#Requires -Modules Pester
<#
.SYNOPSIS
  Behavioural tests for the Windows device host's decision logic.

.DESCRIPTION
  The host decides one thing that matters more than everything else it does:
  whether a submission printed. Getting that wrong in the safe direction sends
  every paid job to an operator; getting it wrong in the unsafe direction
  charges a customer for paper that never came out. Neither is observable from
  the source text, so these drive the decision itself.

  The host is loaded with -AsLibrary, which defines its functions without
  touching a queue, a device or standard input.

.EXAMPLE
  Invoke-Pester -Path infrastructure/windows/print-host.tests.ps1
#>

BeforeAll {
  . "$PSScriptRoot/print-host.ps1" -AsLibrary

  function New-Observation {
    param(
      [int] $Position = 0,
      [int] $JobId = 1,
      [string] $JobName = 'job',
      [int] $ExpectedPages = 1,
      [int] $ExpectedSheets = 1,
      [int] $PagesPrinted = 0,
      [bool] $Observed = $false,
      [bool] $Faulted = $false,
      [string] $FaultCode = '',
      [bool] $Completed = $false,
      [bool] $Present = $false,
      [string] $Status = ''
    )
    [pscustomobject]@{
      position = $Position
      jobId = $JobId
      jobName = $JobName
      expectedPages = $ExpectedPages
      expectedSheets = $ExpectedSheets
      pagesPrinted = $PagesPrinted
      observed = $Observed
      faulted = $Faulted
      faultCode = $FaultCode
      completed = $Completed
      present = $Present
      status = $Status
    }
  }
}

Describe 'Resolve-OperationOutcome: a job that finished and left the queue' {
  It 'confirms a job this host watched and then saw retire' {
    # The regression this exists for: Windows deletes a completed job from the
    # queue immediately, so every successful print looked like an operation
    # nobody could account for and settled as RECOVERY_REQUIRED.
    $observations = @(New-Observation -Observed $true -Present $false -ExpectedSheets 3)
    $report = Resolve-OperationOutcome -Observations $observations -CancelRequested $false

    $report.state | Should -Be 'COMPLETED'
    $report.confidence | Should -Be 'CONFIRMED'
    $report.sheetsProduced | Should -Be 3
    $report.failureCode | Should -BeNullOrEmpty
  }

  It 'sums the sheets of every document in the operation' {
    $observations = @(
      New-Observation -Position 0 -JobId 1 -Observed $true -ExpectedSheets 2
      New-Observation -Position 1 -JobId 2 -Observed $true -ExpectedSheets 5
    )
    $report = Resolve-OperationOutcome -Observations $observations -CancelRequested $false

    $report.confidence | Should -Be 'CONFIRMED'
    $report.sheetsProduced | Should -Be 7
  }

  It 'refuses to confirm a job it never saw alive' {
    # Absent and unobserved is indistinguishable from never created. Something
    # may be in the customer's hand and nobody here can say what.
    $observations = @(New-Observation -Observed $false -Present $false)
    $report = Resolve-OperationOutcome -Observations $observations -CancelRequested $false

    $report.state | Should -Be 'COMPLETED'
    $report.confidence | Should -Be 'UNCONFIRMED'
    $report.sheetsProduced | Should -BeNullOrEmpty
  }

  It 'refuses to read a cancelled job as a clean completion' {
    # Remove-PrintJob empties the queue exactly the way finishing does.
    $observations = @(New-Observation -Observed $true -Present $false)
    $report = Resolve-OperationOutcome -Observations $observations -CancelRequested $true

    $report.confidence | Should -Be 'UNCONFIRMED'
    $report.sheetsProduced | Should -BeNullOrEmpty
  }
}

Describe 'Resolve-OperationOutcome: a job still in the queue' {
  It 'confirms a Printed job even when the driver never moved its page counter' {
    # PagesPrinted is driver-dependent and frequently stays at zero. Requiring
    # it was the second half of the same regression.
    $observations = @(
      New-Observation -Observed $true -Present $true -Status 'Printed' `
        -PagesPrinted 0 -ExpectedPages 4 -ExpectedSheets 4
    )
    $report = Resolve-OperationOutcome -Observations $observations -CancelRequested $false

    $report.state | Should -Be 'COMPLETED'
    $report.confidence | Should -Be 'CONFIRMED'
    $report.sheetsProduced | Should -Be 4
  }

  It 'reports work still spooling as open rather than as a result' {
    $observations = @(New-Observation -Observed $true -Present $true -Status 'Spooling')
    $report = Resolve-OperationOutcome -Observations $observations -CancelRequested $false

    $report.state | Should -Be 'PRINTING'
    $report.confidence | Should -Be 'UNCONFIRMED'
    $report.open | Should -Be 1
  }

  It 'confirms a failure that proved no page moved' {
    $observations = @(
      New-Observation -Observed $true -Present $true -Status 'PaperOut' -PagesPrinted 0
    )
    $report = Resolve-OperationOutcome -Observations $observations -CancelRequested $false

    $report.state | Should -Be 'FAILED'
    $report.failureCode | Should -Be 'OUT_OF_PAPER'
    $report.confidence | Should -Be 'CONFIRMED'
    $report.sheetsProduced | Should -Be 0
  }

  It 'keeps a failure ambiguous once paper has moved' {
    $observations = @(
      New-Observation -Observed $true -Present $true -Status 'PaperOut' -PagesPrinted 2
    )
    $report = Resolve-OperationOutcome -Observations $observations -CancelRequested $false

    $report.state | Should -Be 'FAILED'
    $report.confidence | Should -Be 'UNCONFIRMED'
    $report.sheetsProduced | Should -BeNullOrEmpty
  }

  It 'reports a job being deleted at the device as a cancellation' {
    $observations = @(
      New-Observation -Observed $true -Present $true -Status 'Deleting' -PagesPrinted 0
    )
    $report = Resolve-OperationOutcome -Observations $observations -CancelRequested $false

    $report.state | Should -Be 'CANCELED'
    $report.failureCode | Should -Be 'CANCELED_AT_DEVICE'
  }
}

Describe 'Resolve-OperationOutcome: operations with more than one document' {
  It 'does not confirm anything while a sibling job is still open' {
    $observations = @(
      New-Observation -Position 0 -JobId 1 -Observed $true -Present $false -ExpectedSheets 2
      New-Observation -Position 1 -JobId 2 -Observed $true -Present $true -Status 'Printing'
    )
    $report = Resolve-OperationOutcome -Observations $observations -CancelRequested $false

    $report.state | Should -Be 'PRINTING'
    $report.sheetsProduced | Should -BeNullOrEmpty
  }

  It 'withholds the sheet count when one document cannot be accounted for' {
    $observations = @(
      New-Observation -Position 0 -JobId 1 -Observed $true -Present $false -ExpectedSheets 2
      New-Observation -Position 1 -JobId 2 -Observed $false -Present $false -ExpectedSheets 2
    )
    $report = Resolve-OperationOutcome -Observations $observations -CancelRequested $false

    $report.state | Should -Be 'COMPLETED'
    $report.confidence | Should -Be 'UNCONFIRMED'
    $report.sheetsProduced | Should -BeNullOrEmpty
  }

  It 'will not call a failure proven-zero while a sibling is unaccounted for' {
    $observations = @(
      New-Observation -Position 0 -JobId 1 -Observed $true -Present $true `
        -Status 'PaperOut' -PagesPrinted 0
      New-Observation -Position 1 -JobId 2 -Observed $false -Present $false
    )
    $report = Resolve-OperationOutcome -Observations $observations -CancelRequested $false

    $report.state | Should -Be 'FAILED'
    $report.confidence | Should -Be 'UNCONFIRMED'
    $report.sheetsProduced | Should -BeNullOrEmpty
  }

  It 'keeps a recorded fault after the job has left the queue' {
    # Sticky, so a later poll cannot read a job that failed and was removed as
    # one that retired cleanly.
    $observations = @(
      New-Observation -Observed $true -Present $false -Faulted $true -FaultCode 'DEVICE_ERROR'
    )
    $report = Resolve-OperationOutcome -Observations $observations -CancelRequested $false

    $report.state | Should -Be 'FAILED'
    $report.failureCode | Should -Be 'DEVICE_ERROR'
  }
}

Describe 'ConvertTo-QueueState' {
  It 'treats <status> as a usable queue' -ForEach @(
    @{ status = 'Normal' }, @{ status = 'Idle' }, @{ status = 'Printing' }
    @{ status = 'Busy' }, @{ status = 'IOActive' }, @{ status = 'Processing' }
    @{ status = 'Waiting' }, @{ status = 'Initializing' }, @{ status = 'WarmingUp' }
  ) {
    # A printer that is merely busy or warming up used to be reported OFFLINE,
    # which refused paid work and settled the job as a refundable failure.
    ConvertTo-QueueState -Printer ([pscustomobject]@{ PrinterStatus = $status }) |
      Should -Be 'READY'
  }

  It 'treats the consumable warning <status> as usable so the warning is reachable' -ForEach @(
    @{ status = 'TonerLow' }, @{ status = 'PaperLow' }, @{ status = 'OutputBinFull' }
  ) {
    ConvertTo-QueueState -Printer ([pscustomobject]@{ PrinterStatus = $status }) |
      Should -Be 'READY'
  }

  It 'treats the fault <status> as an error' -ForEach @(
    @{ status = 'PaperJam' }, @{ status = 'PaperOut' }, @{ status = 'NoToner' }
    @{ status = 'DoorOpen' }, @{ status = 'UserInterventionRequired' }
    @{ status = 'OutOfMemory' }, @{ status = 'Error' }
  ) {
    ConvertTo-QueueState -Printer ([pscustomobject]@{ PrinterStatus = $status }) |
      Should -Be 'ERROR'
  }

  It 'treats <status> as offline' -ForEach @(
    @{ status = 'Offline' }, @{ status = 'NotAvailable' }, @{ status = 'PowerSave' }
  ) {
    ConvertTo-QueueState -Printer ([pscustomobject]@{ PrinterStatus = $status }) |
      Should -Be 'OFFLINE'
  }

  It 'treats a paused queue as paused' {
    ConvertTo-QueueState -Printer ([pscustomobject]@{ PrinterStatus = 'Paused' }) |
      Should -Be 'PAUSED'
  }

  It 'lets a fault outrank activity in a combined status' {
    ConvertTo-QueueState -Printer ([pscustomobject]@{ PrinterStatus = 'Printing, PaperOut' }) |
      Should -Be 'ERROR'
  }

  It 'refuses a status it does not recognise' {
    ConvertTo-QueueState -Printer ([pscustomobject]@{ PrinterStatus = 'SomethingNew' }) |
      Should -Be 'ERROR'
  }
}

Describe 'Get-RequestedWaitSeconds' {
  It 'falls back to the default when the caller states no budget' {
    Get-RequestedWaitSeconds -Request ([pscustomobject]@{ op = 'submit' }) | Should -Be 240
  }

  It 'honours the budget the caller sent' {
    Get-RequestedWaitSeconds -Request ([pscustomobject]@{ waitSeconds = 90 }) | Should -Be 90
  }

  It 'clamps a budget below its floor' {
    Get-RequestedWaitSeconds -Request ([pscustomobject]@{ waitSeconds = 1 }) | Should -Be 5
  }

  It 'clamps a budget above its ceiling' {
    Get-RequestedWaitSeconds -Request ([pscustomobject]@{ waitSeconds = 99999 }) | Should -Be 1500
  }
}

Describe 'Printing runtime' {
  It 'is not loaded by simply defining the host' {
    # `Add-Type -TypeDefinition` runs the C# compiler and the WinRT loads pull in
    # the PDF renderer. The transport starts a fresh process per request, so
    # paying for them on a health check or a status poll bought nothing and was
    # charged on every heartbeat.
    $script:PrintingRuntimeReady | Should -BeFalse
  }

  It 'records where the time went' {
    Add-PhaseMark -Name 'unit-test'
    $script:PhaseMarks['unit-test'] | Should -BeOfType [int]
    $script:PhaseMarks['unit-test'] | Should -BeGreaterOrEqual 0
  }
}

Describe 'Get-Field and Set-Field' {
  It 'reads a default for a field an older state file does not carry' {
    # Under Set-StrictMode -Version Latest a missing property is a terminating
    # error, which would turn an in-flight operation into a DEVICE_ERROR the
    # first time a new field was added.
    $state = [pscustomobject]@{ jobId = 7 }
    Get-Field -Source $state -Name 'observed' -Default $false | Should -BeFalse
  }

  It 'reads the stored value when the field is present' {
    $state = [pscustomobject]@{ observed = $true }
    Get-Field -Source $state -Name 'observed' -Default $false | Should -BeTrue
  }

  It 'adds a field the object did not have' {
    $state = [pscustomobject]@{ jobId = 7 }
    Set-Field -Target $state -Name 'cancelRequested' -Value $true
    $state.cancelRequested | Should -BeTrue
  }
}

Describe 'Update-JobObservation' -Skip:(-not ($PSVersionTable.Platform -eq 'Win32NT' -or
    $PSVersionTable.PSEdition -eq 'Desktop')) {
  It 'ignores a queue entry whose document name is not this operation' {
    # A spooler restart renumbers jobs from one, so an identifier on its own
    # eventually names somebody else's work.
    Mock Get-PrintJob {
      [pscustomobject]@{ DocumentName = 'someone-elses-job'; JobStatus = 'Printing'; PagesPrinted = 9 }
    }
    $job = [pscustomobject]@{
      position = 0; jobId = 4; jobName = 'ours'; expectedPages = 1; expectedSheets = 1
      pagesPrinted = 0; observed = $false; faulted = $false; faultCode = ''; completed = $false
    }
    $changed = $false
    $observation = Update-JobObservation -Job $job -QueueName 'Q' -Changed ([ref]$changed)

    $observation.present | Should -BeFalse
    $observation.observed | Should -BeFalse
    $observation.pagesPrinted | Should -Be 0
  }

  It 'records the first sighting of a job that is really ours' {
    Mock Get-PrintJob {
      [pscustomobject]@{ DocumentName = 'ours'; JobStatus = 'Printing'; PagesPrinted = 2 }
    }
    $job = [pscustomobject]@{
      position = 0; jobId = 4; jobName = 'ours'; expectedPages = 4; expectedSheets = 4
      pagesPrinted = 0; observed = $false; faulted = $false; faultCode = ''; completed = $false
    }
    $changed = $false
    $observation = Update-JobObservation -Job $job -QueueName 'Q' -Changed ([ref]$changed)

    $observation.present | Should -BeTrue
    $observation.observed | Should -BeTrue
    $observation.pagesPrinted | Should -Be 2
    $job.observed | Should -BeTrue
    $changed | Should -BeTrue
  }
}

Describe 'Test-QueueApproved' {
  BeforeAll {
    $script:Reference = @(@{ driverName = 'Canon Generic Plus UFR II'; portPattern = '^USB\d+$' })
    function New-Queue {
      param(
        [string] $Type = 'Local',
        [bool] $Shared = $false,
        [string] $DriverName = 'Canon Generic Plus UFR II',
        [string] $PortName = 'USB001'
      )
      [pscustomobject]@{
        Type = $Type; Shared = $Shared; DriverName = $DriverName; PortName = $PortName
      }
    }
  }

  It 'approves the certified printer on a local USB port' {
    Test-QueueApproved -Printer (New-Queue) -Profiles $script:Reference | Should -BeTrue
  }

  It 'refuses a driver nobody certified' {
    $queue = New-Queue -DriverName 'Microsoft Print To PDF'
    Test-QueueApproved -Printer $queue -Profiles $script:Reference | Should -BeFalse
  }

  It 'refuses a port shape the profile does not name' {
    Test-QueueApproved -Printer (New-Queue -PortName 'IP_192.168.0.10') -Profiles $script:Reference |
      Should -BeFalse
  }

  # The security boundary, not a profile decision: this host prints over a cable
  # to a machine standing next to it. No configuration may open a network path.
  It 'refuses a shared or non-local queue however it is configured' {
    $everything = @(@{ driverName = 'Microsoft Print To PDF'; portName = 'x'; portPattern = '.*' })
    Test-QueueApproved -Printer (New-Queue -Shared $true) -Profiles $everything | Should -BeFalse
    Test-QueueApproved -Printer (New-Queue -Type 'Connection') -Profiles $everything |
      Should -BeFalse
  }

  It 'approves a second model without this script changing' {
    $profiles = @(
      @{ driverName = 'Canon Generic Plus UFR II'; portPattern = '^USB\d+$' },
      @{ driverName = 'Brother HL-L2400 series'; portPattern = '^USB\d+$' }
    )
    $queue = New-Queue -DriverName 'Brother HL-L2400 series'
    Test-QueueApproved -Printer $queue -Profiles $profiles | Should -BeTrue
  }

  It 'lets one unusable pattern disqualify only itself' {
    $profiles = @(
      @{ driverName = 'Canon Generic Plus UFR II'; portPattern = '^USB(\d+$' },
      @{ driverName = 'Canon Generic Plus UFR II'; portPattern = '^USB\d+$' }
    )
    Test-QueueApproved -Printer (New-Queue) -Profiles $profiles | Should -BeTrue
  }
}

Describe 'Read-ApprovedProfiles' {
  It 'falls back to the reference printer when the caller names none' {
    $profiles = Read-ApprovedProfiles -Request ([pscustomobject]@{ op = 'status' })
    @($profiles)[0].driverName | Should -Be 'Canon Generic Plus UFR II'
  }

  It 'takes what the caller certified' {
    $request = [pscustomobject]@{
      profiles = @([pscustomobject]@{ driverName = 'Brother HL-L2400 series'; portPattern = '^USB\d+$' })
    }
    $profiles = Read-ApprovedProfiles -Request $request
    @($profiles).Count | Should -Be 1
    @($profiles)[0].driverName | Should -Be 'Brother HL-L2400 series'
  }
}

Describe 'Select-OperationJobs' {
  BeforeAll {
    $script:OperationId = '01900000-0000-7000-8000-0000000000a1'
  }

  It 'finds the queue entries an operation named, without any state file' {
    $jobs = @(
      [pscustomobject]@{ Id = 23; DocumentName = "$($script:OperationId)#000of001"; JobStatus = 'Printing' },
      [pscustomobject]@{ Id = 24; DocumentName = 'somebody elses document'; JobStatus = 'Printing' }
    )
    $found = @(Select-OperationJobs -OperationId $script:OperationId -Jobs $jobs)

    $found.Count | Should -Be 1
    $found[0].jobId | Should -Be 23
    $found[0].position | Should -Be 0
    $found[0].faulted | Should -BeFalse
  }

  It 'marks a queue entry in trouble' {
    $jobs = @(
      [pscustomobject]@{ Id = 23; DocumentName = "$($script:OperationId)#000of001"; JobStatus = 'Error, PaperJam' }
    )
    @(Select-OperationJobs -OperationId $script:OperationId -Jobs $jobs)[0].faulted | Should -BeTrue
  }

  It 'never matches a different operation' {
    $other = '01900000-0000-7000-8000-0000000000b2'
    $jobs = @([pscustomobject]@{ Id = 23; DocumentName = "$other#000of001"; JobStatus = 'Printing' })
    @(Select-OperationJobs -OperationId $script:OperationId -Jobs $jobs).Count | Should -Be 0
  }

  It 'answers nothing rather than everything for an empty operation id' {
    $jobs = @([pscustomobject]@{ Id = 23; DocumentName = '#000of001'; JobStatus = 'Printing' })
    @(Select-OperationJobs -OperationId '' -Jobs $jobs).Count | Should -Be 0
  }
}

Describe 'ConvertTo-RetentionCutoff' {
  It 'reads the ISO 8601 UTC the caller always sends' {
    $cutoff = ConvertTo-RetentionCutoff -Value '2026-08-19T22:00:00Z'
    $cutoff.Kind | Should -Be ([System.DateTimeKind]::Utc)
    $cutoff.ToString('yyyy-MM-ddTHH:mm:ss') | Should -Be '2026-08-19T22:00:00'
  }

  # The bug this exists for: a day-first locale does not fail on an ISO date,
  # it succeeds at a different moment. A cutoff that moved sweeps away the state
  # of a live operation, and losing that record is a paid job nobody can settle.
  It 'reads the same instant whatever locale the kiosk was installed with' {
    $original = [System.Threading.Thread]::CurrentThread.CurrentCulture
    try {
      foreach ($name in @('en-US', 'de-DE', 'en-GB', 'ar-AE')) {
        [System.Threading.Thread]::CurrentThread.CurrentCulture = [cultureinfo]::new($name)
        $cutoff = ConvertTo-RetentionCutoff -Value '2026-08-19T22:00:00Z'
        $cutoff.ToString('yyyy-MM-ddTHH:mm:ss') | Should -Be '2026-08-19T22:00:00'
      }
    } finally {
      [System.Threading.Thread]::CurrentThread.CurrentCulture = $original
    }
  }

  It 'refuses a cutoff nobody can read rather than sweeping on a guess' {
    ConvertTo-RetentionCutoff -Value 'whenever' | Should -BeNullOrEmpty
    ConvertTo-RetentionCutoff -Value '' | Should -BeNullOrEmpty
  }
}

Describe 'Resolve-RenderLongEdge' {
  It 'renders to the surface the driver actually reports' {
    # 1:1 with the device leaves GDI nothing to rescale.
    Resolve-RenderLongEdge -HorizontalPixels 2480 -VerticalPixels 3508 | Should -Be 3508
  }

  It 'holds the ceiling so a high-resolution driver cannot stall the kiosk' {
    # Cost is quadratic: an unbounded 1200 DPI device turns 11 seconds into a
    # minute with a customer standing there.
    Resolve-RenderLongEdge -HorizontalPixels 9920 -VerticalPixels 14043 | Should -Be 4960
  }

  It 'holds the floor so a coarse driver cannot print a blurred page' {
    Resolve-RenderLongEdge -HorizontalPixels 600 -VerticalPixels 800 | Should -Be 2480
  }

  It 'falls back when the driver will not describe itself' {
    Resolve-RenderLongEdge -HorizontalPixels 0 -VerticalPixels 0 | Should -Be 3508
  }
}

Describe 'Get-CapabilityRefusal' {
  It 'recognises a queue that cannot do the work, through PowerShell wrapping' {
    $inner = [System.InvalidOperationException]::new('DUPLEX_UNAVAILABLE')
    $outer = [System.InvalidOperationException]::new('Exception calling ".ctor"', $inner)
    $record = [System.Management.Automation.ErrorRecord]::new($outer, 'x', 'NotSpecified', $null)
    Get-CapabilityRefusal -ErrorRecord $record | Should -Be 'DUPLEX_UNAVAILABLE'
  }

  # Treating an unrecognised failure as definite is how an ambiguous submission
  # becomes a duplicate print.
  It 'leaves anything it does not recognise alone' {
    $error = [System.InvalidOperationException]::new('START_PAGE_FAILED:5')
    $record = [System.Management.Automation.ErrorRecord]::new($error, 'x', 'NotSpecified', $null)
    Get-CapabilityRefusal -ErrorRecord $record | Should -BeNullOrEmpty
    Get-CapabilityRefusal -ErrorRecord $null | Should -BeNullOrEmpty
  }
}

Describe 'Get-PrinterFaultCode' {
  # These are the conditions that mean paper stopped coming out. Each maps to
  # the code an operator needs to read, not to a generic device error.
  It 'names the fault behind a stopped printer' {
    Get-PrinterFaultCode -Status 'PaperOut' | Should -Be 'OUT_OF_PAPER'
    Get-PrinterFaultCode -Status 'PaperJam' | Should -Be 'PAPER_JAM'
    Get-PrinterFaultCode -Status 'DoorOpen' | Should -Be 'COVER_OPEN'
    Get-PrinterFaultCode -Status 'NoToner' | Should -Be 'DEVICE_ERROR'
    Get-PrinterFaultCode -Status 'UserInterventionRequired' | Should -Be 'DEVICE_ERROR'
  }

  # The whole point of the narrow pattern. A printer that sleeps or is paused
  # after finishing is the ordinary end of a healthy print; treating either as
  # evidence would route every idle kiosk into operator recovery.
  It 'is silent about a printer that is merely idle, asleep or paused' {
    foreach ($status in @('Normal', 'Idle', 'Printing', 'Busy', 'IOActive', 'WarmingUp',
                          'Offline', 'PowerSave', 'Paused', 'PendingDeletion', 'NotAvailable')) {
      Get-PrinterFaultCode -Status $status | Should -BeNullOrEmpty -Because "'$status' is not a fault"
    }
  }

  # Consumable warnings already travel as warningCode. Vetoing on them would put
  # a refund conversation in front of a customer whose pages did come out.
  It 'is silent about consumable warnings' {
    Get-PrinterFaultCode -Status 'TonerLow' | Should -BeNullOrEmpty
    Get-PrinterFaultCode -Status 'PaperLow' | Should -BeNullOrEmpty
    Get-PrinterFaultCode -Status 'OutputBinFull' | Should -BeNullOrEmpty
  }

  It 'treats an absent or unreadable status as no evidence at all' {
    Get-PrinterFaultCode -Status '' | Should -BeNullOrEmpty
    Get-PrinterFaultCode -Status '   ' | Should -BeNullOrEmpty
    Get-PrinterFaultCode -Status 'SomeStatusNobodyHasSeen' | Should -BeNullOrEmpty
  }

  # A real status word carries several flags at once. The most specific cause
  # wins, because 'DEVICE_ERROR' tells an operator nothing they can act on.
  It 'reports the most specific cause when several flags are set' {
    Get-PrinterFaultCode -Status 'TonerLow, PaperOut' | Should -Be 'OUT_OF_PAPER'
    Get-PrinterFaultCode -Status 'Error, PaperJam' | Should -Be 'PAPER_JAM'
  }
}

Describe 'Merge-DeviceFault' {
  BeforeAll {
    function New-Outcome {
      param(
        [string] $State = 'COMPLETED',
        [string] $Confidence = 'CONFIRMED',
        $FailureCode = $null,
        $SheetsProduced = 2,
        [int] $Open = 0
      )
      @{
        state = $State; confidence = $Confidence; failureCode = $FailureCode
        warningCode = $null; sheetsProduced = $SheetsProduced; open = $Open
      }
    }
  }

  # The regression this whole mechanism exists for: two sheets were asked for,
  # both spooler jobs retired, and the printer had run out of paper.
  It 'takes a confirmed completion away when the printer faulted' {
    $merged = Merge-DeviceFault -Outcome (New-Outcome) -FaultCode 'OUT_OF_PAPER'
    $merged.state | Should -Be 'FAILED'
    $merged.confidence | Should -Be 'UNCONFIRMED'
    $merged.failureCode | Should -Be 'OUT_OF_PAPER'
    # The count was only ever what this host intended to produce. A fault is the
    # proof it was not what came out, so it must not travel as a fact.
    $merged.sheetsProduced | Should -BeNullOrEmpty
  }

  It 'leaves a healthy operation exactly as the queue described it' {
    $outcome = New-Outcome
    $merged = Merge-DeviceFault -Outcome $outcome -FaultCode ''
    $merged.state | Should -Be 'COMPLETED'
    $merged.confidence | Should -Be 'CONFIRMED'
    $merged.sheetsProduced | Should -Be 2
    (Merge-DeviceFault -Outcome $outcome -FaultCode $null).confidence | Should -Be 'CONFIRMED'
  }

  # A proved-zero failure is definite and refundable. Turning it into an
  # ambiguous one would take a refund away from a customer who is owed it.
  It 'never rewrites a failure that already proved nothing came out' {
    $outcome = New-Outcome -State 'FAILED' -Confidence 'CONFIRMED' `
      -FailureCode 'PRINTER_OFFLINE' -SheetsProduced 0
    $merged = Merge-DeviceFault -Outcome $outcome -FaultCode 'OUT_OF_PAPER'
    $merged.state | Should -Be 'FAILED'
    $merged.confidence | Should -Be 'CONFIRMED'
    $merged.failureCode | Should -Be 'PRINTER_OFFLINE'
    $merged.sheetsProduced | Should -Be 0
  }

  It 'never rewrites a cancellation' {
    $outcome = New-Outcome -State 'CANCELED' -Confidence 'CONFIRMED' `
      -FailureCode 'CANCELED_AT_DEVICE' -SheetsProduced 0
    $merged = Merge-DeviceFault -Outcome $outcome -FaultCode 'PAPER_JAM'
    $merged.state | Should -Be 'CANCELED'
    $merged.failureCode | Should -Be 'CANCELED_AT_DEVICE'
  }

  # An operation with work still in the queue has not claimed anything yet, so
  # there is nothing for a fault to take away and the wait must continue.
  It 'leaves an operation that is still printing open' {
    $outcome = New-Outcome -State 'PRINTING' -Confidence 'UNCONFIRMED' `
      -SheetsProduced $null -Open 1
    $merged = Merge-DeviceFault -Outcome $outcome -FaultCode 'OUT_OF_PAPER'
    $merged.state | Should -Be 'PRINTING'
    $merged.open | Should -Be 1
  }

  # Confidence only ever travels one way. There is no input that turns an
  # unconfirmed answer into a confirmed one.
  It 'can only ever downgrade' {
    foreach ($state in @('COMPLETED', 'FAILED', 'CANCELED', 'PRINTING', 'NOT_SUBMITTED')) {
      $outcome = New-Outcome -State $state -Confidence 'UNCONFIRMED' -SheetsProduced $null
      $merged = Merge-DeviceFault -Outcome $outcome -FaultCode 'OUT_OF_PAPER'
      $merged.confidence | Should -Be 'UNCONFIRMED' -Because "$state must not gain confidence"
    }
  }
}

Describe 'Get-RequestedSettleMilliseconds' {
  It 'defaults when the caller does not ask' {
    Get-RequestedSettleMilliseconds -Request ([pscustomobject]@{ op = 'submit' }) | Should -Be 3000
  }

  It 'clamps what a caller may ask for' {
    Get-RequestedSettleMilliseconds -Request ([pscustomobject]@{ settleMs = -1 }) | Should -Be 0
    Get-RequestedSettleMilliseconds -Request ([pscustomobject]@{ settleMs = 999999 }) |
      Should -Be 15000
    Get-RequestedSettleMilliseconds -Request ([pscustomobject]@{ settleMs = 1500 }) | Should -Be 1500
  }
}

Describe 'Watch-PrinterSettle' {
  It 'does not touch the spooler when it is given no window' {
    $result = Watch-PrinterSettle -QueueName 'anything' -Milliseconds 0
    $result.faultCode | Should -BeNullOrEmpty
    @($result.statuses).Count | Should -Be 0
  }
}

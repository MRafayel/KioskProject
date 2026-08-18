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

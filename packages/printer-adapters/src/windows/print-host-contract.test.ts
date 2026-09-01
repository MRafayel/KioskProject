import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const hostPath = fileURLToPath(
  new URL("../../../../infrastructure/windows/print-host.ps1", import.meta.url)
);
const specPath = fileURLToPath(
  new URL("../../../../infrastructure/windows/print-host.tests.ps1", import.meta.url)
);
const hostSource = readFileSync(hostPath, "utf8");

/**
 * Which PowerShell this machine has, if any.
 *
 * The host's behaviour is tested by driving it (see `print-host.tests.ps1`).
 * That needs an interpreter, which a developer machine may not have, so the
 * suite reports as skipped there and runs wherever the kiosk actually ships.
 */
function findPowerShell(): string | null {
  for (const candidate of ["pwsh", "powershell.exe", "powershell"]) {
    const probe = spawnSync(
      candidate,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
      { encoding: "utf8", timeout: 30_000 }
    );
    if (probe.status === 0) return candidate;
  }
  return null;
}

function hasPester(shell: string): boolean {
  const probe = spawnSync(
    shell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "if (Get-Module -ListAvailable -Name Pester) { exit 0 } else { exit 1 }"
    ],
    { encoding: "utf8", timeout: 60_000 }
  );
  return probe.status === 0;
}

const shell = findPowerShell();
const pesterAvailable = shell !== null && hasPester(shell);

describe.skipIf(!pesterAvailable)("Windows print host behaviour", () => {
  it("passes its own decision suite", () => {
    const result = spawnSync(
      shell!,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Invoke-Pester -Path '${specPath}' -Output Detailed -CI`
      ],
      { encoding: "utf8", timeout: 300_000 }
    );
    if (result.status !== 0) {
      throw new Error(`print-host.tests.ps1 failed:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    }
  }, 300_000);
});

describe.skipIf(pesterAvailable)("Windows print host behaviour (not exercised here)", () => {
  it("reports why the behavioural suite did not run", () => {
    // Deliberately not a silent skip: a machine that cannot run the host's own
    // tests should say so, because the source assertions below are a much
    // weaker guarantee and it must be obvious which one is in force.
    const reason = shell === null ? "no PowerShell interpreter" : "Pester is not installed";
    expect(reason.length).toBeGreaterThan(0);
    console.warn(
      `print-host.tests.ps1 was not run (${reason}). ` +
        "Run it on the Windows kiosk: Invoke-Pester -Path infrastructure/windows/print-host.tests.ps1"
    );
  });
});

/**
 * Invariants about what the host must never do.
 *
 * These stay as source assertions on purpose. They are not statements about
 * behaviour that a test could observe from outside — they are prohibitions, and
 * the evidence that a prohibition holds is the absence of the thing. The
 * host's actual decisions are tested by driving it, above.
 */
describe("Windows print host prohibitions", () => {
  it("never sends PDF bytes to the printer as RAW data", () => {
    expect(hostSource).toContain("Windows.Data.Pdf.PdfDocument");
    expect(hostSource).toContain('CreateDC("WINSPOOL"');
    expect(hostSource).not.toContain("StartDocPrinter");
    expect(hostSource).not.toContain("WritePrinter");
    expect(hostSource).not.toContain('pDatatype = "RAW"');
  });

  /**
   * Which driver and which port shape are certified is now configuration, so
   * the reference profile is a default rather than the rule. What must not
   * become configurable is the boundary itself: this host prints over a cable
   * to a machine standing next to it, and no profile may open a network path.
   */
  it("keeps the approved queue local and unshared whatever a profile says", () => {
    expect(hostSource).toContain("if ([string]$Printer.Type -ne 'Local') { return $false }");
    expect(hostSource).toContain("if ([bool]$Printer.Shared) { return $false }");
    expect(hostSource).toContain("portPattern = '^USB\\d+$'");
    expect(hostSource).not.toContain("DUPLEX_SHORT_EDGE");
  });

  /**
   * This host no longer judges whether paper came out, and must not start again.
   *
   * A three-second watch of `PrinterStatus` used to run before every confirmed
   * completion. It never once saw a fault — `["Normal"]` on the jobs that
   * printed short and on the ones that printed in full — because this driver
   * does not surface the print engine through that field. The question is now
   * answered by the engine's own page counter in the agent, against evidence
   * that exists.
   *
   * Guarded structurally because the failure mode is silent: a re-added watch
   * would cost every job three seconds and still answer `Normal`, which reads
   * as a working check.
   */
  it("does not re-examine the printer after the queue empties", () => {
    for (const removed of [
      "Watch-PrinterSettle",
      "Merge-DeviceFault",
      "Get-PrinterFaultCode",
      "$OperationFaultPattern",
      "settleMs"
    ]) {
      expect(hostSource).not.toContain(removed);
    }
  });

  /**
   * The queue-state vocabulary stays, and stays narrow. It is about the *queue*
   * — can this job be handed over at all — which is the one thing SNMP cannot
   * see, and it must not drift into judging the paper.
   */
  it("keeps sleep and pause out of the queue fault vocabulary", () => {
    const pattern = hostSource.match(/\$QueueFaultPattern\s*=\s*\n?\s*'([^']+)'/);
    expect(pattern).not.toBeNull();
    for (const benign of ["TonerLow", "PaperLow", "OutputBinFull"]) {
      expect(pattern?.[1]).not.toContain(benign);
    }
  });

  it("never writes request payloads or document paths to the diagnostic log", () => {
    expect(hostSource).toContain("diagnostics.jsonl");
    expect(hostSource).not.toContain("request = $Request");
    expect(hostSource).not.toContain("path = $document.path");
  });

  it("keeps the local diagnostic footprint bounded and off the user profile", () => {
    // A public kiosk is a machine strangers stand in front of. The operation's
    // own evidence now reaches the control plane in the protocol response, so
    // what stays here is a small fallback under the installer's locked-down
    // state tree rather than an unbounded log in an account's profile.
    expect(hostSource).toContain("$DiagnosticMaxBytes = 256KB");
    expect(hostSource).toContain("$DiagnosticMaxAgeHours");
    expect(hostSource).toContain("$DiagnosticDirectory = Join-Path $StateDirectory 'diagnostics'");
    expect(hostSource).not.toContain("$env:LOCALAPPDATA");
  });

  it("keeps the driver's own units when drawing a rendered page", () => {
    // A regression guard for a defect only real hardware showed: GDI+ defaults
    // a printer surface to 1/100 inch while the driver metrics are device
    // pixels, and the mismatch printed blank-looking pages.
    expect(hostSource).toContain("graphics.PageUnit = GraphicsUnit.Pixel");
    expect(hostSource).toContain("graphics.PageScale = 1.0f");
  });

  it("does not let a WinRT completion value escape into the renderer's output", () => {
    // Another hardware-only defect: the escaped value made the renderer return
    // an array, and strict-mode property access then failed.
    expect(hostSource).toContain("[void]$task.GetAwaiter().GetResult()");
  });

  it("settles every page a document will print before it opens a job", () => {
    // Pages are rasterised as they are drawn, not all of them beforehand, so
    // the printer starts on page one instead of waiting out the document.
    // What may not move with them is the refusal: opening the file and
    // resolving the requested ranges decide whether this submission is
    // possible at all, and both have to stay on the side of StartDoc where
    // nothing has reached a spooler yet. Past it the same failure would be an
    // ambiguous partial print rather than a clean "nothing was submitted".
    const preflight = hostSource.indexOf("Add-PhaseMark -Name 'prepared'");
    const startDoc = hostSource.indexOf("Add-PhaseMark -Name \"document.$position.startDoc\"");
    const firstRender = hostSource.indexOf("$pending = Start-PdfPageRender -Pdf $item.pdf");

    expect(preflight).toBeGreaterThan(-1);
    expect(startDoc).toBeGreaterThan(preflight);
    expect(firstRender).toBeGreaterThan(startDoc);
    // The whole-document renderer is gone; leaving it callable would let the
    // old ordering come back without anything here noticing.
    expect(hostSource).not.toContain("function Render-PdfSelection");
  });

  it("starts the next page rendering before drawing the current one", () => {
    // The regression this guards is one real hardware showed: rasterise, draw,
    // rasterise, draw delivered a page more slowly than the engine printed one,
    // so the printer ran two or three sheets, stopped, spun back up and did it
    // again. Overlapping the two is what keeps it fed, and the only thing that
    // makes it an overlap is that the render below is started above the draw.
    const drawLoop = hostSource.slice(
      hostSource.indexOf('$script:DiagnosticStage = "submit.document.$position.draw-pages"')
    );
    const lookahead = drawLoop.indexOf("if ($emitted -lt $totalPages)");
    const draw = drawLoop.indexOf("$job.PrintImageBytes($bytes)");

    expect(lookahead).toBeGreaterThan(-1);
    expect(draw).toBeGreaterThan(lookahead);
  });

  it("never writes a customer's page image to disk while printing", () => {
    // The page goes from the renderer to GDI as bytes. Nothing encodes it to a
    // file and reads it back, which is both two fewer seconds a minute and one
    // fewer place a document exists on this machine.
    expect(hostSource).toContain("public void PrintImageBytes(byte[] bytes)");
    expect(hostSource).not.toContain("[System.IO.File]::WriteAllBytes($outputPath, $bytes)");
    expect(hostSource).not.toContain("function Get-RenderPath");
  });

  it("does not resample a page that was rasterised at the device's own size", () => {
    // Interpolating one-to-one walks eight million pixels and changes none of
    // them. The high-quality path stays for the sizes that really differ.
    expect(hostSource).toContain("graphics.DrawImageUnscaled(image, left, top)");
    expect(hostSource).toContain("InterpolationMode.HighQualityBicubic");
  });
});

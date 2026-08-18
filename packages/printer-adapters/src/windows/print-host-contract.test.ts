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

  it("keeps the approved queue profile narrow and local", () => {
    expect(hostSource).toContain("$printer.PortName -match '^USB\\d+$'");
    expect(hostSource).not.toContain("DUPLEX_SHORT_EDGE");
  });

  it("never writes request payloads or document paths to the diagnostic log", () => {
    expect(hostSource).toContain("diagnostics.jsonl");
    expect(hostSource).toContain("$DiagnosticMaxBytes = 1MB");
    expect(hostSource).not.toContain("request = $Request");
    expect(hostSource).not.toContain("path = $document.path");
  });

  it("keeps the driver's own units when drawing a rendered page", () => {
    // A regression guard for a defect only real hardware showed: GDI+ defaults
    // a printer surface to 1/100 inch while the driver metrics are device
    // pixels, and the mismatch printed blank-looking pages.
    expect(hostSource).toContain("graphics.PageUnit = GraphicsUnit.Pixel");
    expect(hostSource).toContain("graphics.PageScale = 1.0f");
  });

  it("does not let a WinRT completion value escape into the renderer's output", () => {
    // Another hardware-only defect: the escaped value made Render-PdfSelection
    // return an array, and strict-mode property access then failed.
    expect(hostSource).toContain("[void]$task.GetAwaiter().GetResult()");
  });
});

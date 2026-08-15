import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const hostSource = readFileSync(
  new URL("../../../../infrastructure/windows/print-host.ps1", import.meta.url),
  "utf8"
);

describe("Windows PowerShell print host contract", () => {
  it("uses the installed Windows driver instead of sending raw PDF bytes", () => {
    expect(hostSource).toContain("Windows.Data.Pdf.PdfDocument");
    expect(hostSource).toContain('CreateDC("WINSPOOL"');
    expect(hostSource).toContain("StartDoc(deviceContext");
    expect(hostSource).toContain("RotateFlipType.Rotate90FlipNone");
    expect(hostSource).not.toContain("StartDocPrinter");
    expect(hostSource).not.toContain("WritePrinter");
    expect(hostSource).not.toContain('pDatatype = "RAW"');
  });

  it("keeps the supported printer policy narrow", () => {
    expect(hostSource).toContain("$SupportedDriverName = 'Canon Generic Plus UFR II'");
    expect(hostSource).toContain("$MaximumCopies = 10");
    expect(hostSource).toContain("$document.pageRanges");
    expect(hostSource).toContain("$printer.PortName -match '^USB\\d+$'");
    expect(hostSource).toContain("$sides -eq 'two-sided-long-edge'");
    expect(hostSource).not.toContain("DUPLEX_SHORT_EDGE");
  });

  it("keeps detailed failures in a bounded local diagnostic log", () => {
    expect(hostSource).toContain("$env:LOCALAPPDATA");
    expect(hostSource).toContain("diagnostics.jsonl");
    expect(hostSource).toContain("$DiagnosticMaxBytes = 1MB");
    expect(hostSource).toContain("Write-LocalDiagnostic -ErrorRecord $_");
    expect(hostSource).toContain('"submit.document.$Position.page.$index.render"');
    expect(hostSource).toContain("submissionTouched = [bool]$script:SubmissionTouched");
    expect(hostSource).not.toContain("request = $Request");
  });
});

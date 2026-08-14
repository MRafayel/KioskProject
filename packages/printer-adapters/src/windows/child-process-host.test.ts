import { describe, expect, it } from "vitest";

import { deviceHostCommand } from "./child-process-host.js";

describe("Windows device host command", () => {
  it("launches a PowerShell host explicitly on Windows", () => {
    expect(
      deviceHostCommand({ executablePath: "C:\\PrintingKiosk\\print-host.ps1" }, "win32")
    ).toEqual({
      executablePath: "powershell.exe",
      arguments: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "C:\\PrintingKiosk\\print-host.ps1"
      ]
    });
  });

  it("runs a compiled host directly", () => {
    expect(
      deviceHostCommand({ executablePath: "C:\\PrintingKiosk\\print-host.exe" }, "win32")
    ).toEqual({ executablePath: "C:\\PrintingKiosk\\print-host.exe", arguments: [] });
  });
});

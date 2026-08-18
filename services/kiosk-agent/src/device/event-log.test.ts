import { describe, expect, it } from "vitest";

import { AGENT_EVENT_IDS, sanitizeEventDescription, WindowsEventLog } from "./event-log.js";

function recordingLog(platform: NodeJS.Platform = "win32") {
  const calls: { executable: string; args: readonly string[] }[] = [];
  const log = new WindowsEventLog({
    platform,
    run: (executable, args) => {
      calls.push({ executable, args });
      return Promise.resolve();
    }
  });
  return { log, calls };
}

describe("Windows event log", () => {
  it("records the lifecycle a service leaves no other trace of", async () => {
    // Installed as a service, the agent has no console and the service control
    // manager captures nothing. This is the only local evidence that a kiosk
    // came up or went down.
    const { log, calls } = recordingLog();

    await log.write("started", "Kiosk agent started using the windows printer adapter.");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.executable).toBe("eventcreate.exe");
    expect(calls[0]?.args).toContain(String(AGENT_EVENT_IDS.started));
    expect(calls[0]?.args).toContain("INFORMATION");
  });

  it("marks a fatal error as an error so a filter can find it", async () => {
    const { log, calls } = recordingLog();

    await log.write("fatal", "Kiosk agent could not start: Error listen EADDRINUSE");

    expect(calls[0]?.args).toContain("ERROR");
    expect(calls[0]?.args).toContain(String(AGENT_EVENT_IDS.fatal));
  });

  it("writes nothing anywhere but Windows", async () => {
    const { log, calls } = recordingLog("darwin");
    await log.write("started", "Kiosk agent started.");
    expect(calls).toHaveLength(0);
  });

  it("never lets a logging failure reach the caller", async () => {
    // A machine that cannot write to its own event log is still a machine that
    // has to keep printing.
    const log = new WindowsEventLog({
      platform: "win32",
      run: () => Promise.reject(new Error("source is not registered"))
    });

    await expect(log.write("fatal", "something went wrong")).resolves.toBeUndefined();
  });
});

describe("event descriptions", () => {
  it("removes local paths a kiosk's event log has no business showing", () => {
    const description = sanitizeEventDescription(
      "ENOENT: no such file C:\\ProgramData\\PrintingKiosk\\spool\\a1b2.pdf while printing"
    );

    expect(description).not.toContain("a1b2.pdf");
    expect(description).not.toContain("C:\\");
    expect(description).toContain("<path>");
    expect(description).toContain("while printing");
  });

  it("removes UNC paths as well", () => {
    expect(sanitizeEventDescription("copy failed from \\\\server\\share\\job.pdf")).not.toContain(
      "job.pdf"
    );
  });

  it("flattens control characters that would corrupt the record", () => {
    expect(sanitizeEventDescription("first line\nsecond\tline\u0000")).toBe("first line second line");
  });

  it("bounds a description an exception made enormous", () => {
    expect(sanitizeEventDescription("x".repeat(10_000)).length).toBeLessThanOrEqual(500);
  });

  it("writes nothing when there is nothing left to say", async () => {
    const { log, calls } = recordingLog();
    await log.write("fatal", "   \n\t  ");
    expect(calls).toHaveLength(0);
  });
});

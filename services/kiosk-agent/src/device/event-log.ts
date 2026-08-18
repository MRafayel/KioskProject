import { execFile } from "node:child_process";

/**
 * The last channel that still works when nothing else does.
 *
 * A kiosk agent installed as a Windows service has nowhere to write: the
 * service control manager captures no standard output, so in production every
 * line the agent logs is discarded unless something ships it. Shipping happens
 * over the network, which is exactly what is unavailable in the incidents worth
 * recording — a machine that cannot reach the control plane, or one whose agent
 * will not start at all.
 *
 * So a very small number of events go to the Windows event log instead. It is
 * the platform's own place for this, it survives a reboot, it has its own
 * retention and its own access control, and an on-site technician or a remote
 * management tool already knows to look there.
 *
 * Deliberately narrow: service lifecycle and failures that stop the agent
 * working. Per-print detail belongs in the control plane's ledger, not on the
 * kiosk. Nothing written here identifies a customer, a document or a session.
 */

/** `eventcreate` accepts 1..1000. These are stable so a filter can match them. */
export const AGENT_EVENT_IDS = {
  started: 10,
  stopping: 11,
  fatal: 900
} as const;

export type AgentEventKind = keyof typeof AGENT_EVENT_IDS;

const EVENT_SOURCE = "PrintingKioskAgent";
const EVENT_TIMEOUT_MS = 5_000;
/** `eventcreate` truncates beyond this; keeping it short avoids a shell limit. */
const MAX_DESCRIPTION_LENGTH = 500;

export interface WindowsEventLogOptions {
  platform?: NodeJS.Platform;
  /** Injected in tests. Production always shells out to the built-in tool. */
  run?: (executable: string, args: readonly string[]) => Promise<void>;
}

/**
 * Strip anything that is not a plain, safe description.
 *
 * The text is passed as an argument rather than through a shell, so this is not
 * quoting — it is a guarantee about content. Control characters would corrupt
 * the record, and anything resembling a path is removed because a kiosk's event
 * log is read by people who have no business seeing where a customer's document
 * briefly lived.
 */
export function sanitizeEventDescription(message: string): string {
  return (
    message
      // Removing control characters is the point: they would corrupt the
      // event record, and an exception message is not a trusted shape.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/gu, " ")
      .replace(/[A-Za-z]:\\[^\s"']*/gu, "<path>")
      .replace(/\\\\[^\s"']+/gu, "<path>")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, MAX_DESCRIPTION_LENGTH)
  );
}

export class WindowsEventLog {
  private readonly platform: NodeJS.Platform;
  private readonly run: (executable: string, args: readonly string[]) => Promise<void>;

  public constructor(options: WindowsEventLogOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.run = options.run ?? runEventCreate;
  }

  /**
   * Record one event. Never throws and never rejects: a machine that cannot
   * write to its own event log is still a machine that must keep printing.
   */
  public async write(kind: AgentEventKind, message: string): Promise<void> {
    if (this.platform !== "win32") return;
    const description = sanitizeEventDescription(message);
    if (description.length === 0) return;

    try {
      await this.run("eventcreate.exe", [
        "/T",
        kind === "fatal" ? "ERROR" : "INFORMATION",
        "/ID",
        String(AGENT_EVENT_IDS[kind]),
        "/L",
        "APPLICATION",
        "/SO",
        EVENT_SOURCE,
        "/D",
        description
      ]);
    } catch {
      // The source may not be registered, or the account may not be allowed to
      // write. Either is an installation problem, and neither is a reason to
      // stop serving customers.
    }
  }
}

function runEventCreate(executable: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // Arguments are passed as a vector, never a command line, so nothing in the
    // description can become another argument or reach a shell.
    execFile(executable, [...args], { timeout: EVENT_TIMEOUT_MS, windowsHide: true }, (error) => {
      if (error) reject(error instanceof Error ? error : new Error("EVENT_LOG_WRITE_FAILED"));
      else resolve();
    });
  });
}

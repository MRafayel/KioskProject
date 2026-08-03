import { mkdir, readFile, appendFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

const OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type LocalPrintLedgerEntry = "CLAIMED" | "SUBMITTING" | "RESULT_REPORTED";

/**
 * The kiosk's own record of what it did with a print operation.
 *
 * It exists for one moment: the instant between deciding to hand work to a
 * device and learning what the device did with it. If the agent dies there, the
 * next attempt reads this file and knows not to submit blindly. It is written
 * before the device is touched and never rewritten, so a crash leaves evidence
 * rather than silence.
 *
 * It holds no customer data — an operation identifier, an entry name, and a
 * timestamp — and it is not the authority. The device is asked as well, because
 * a wiped spool directory must not be able to turn a printed job into a second
 * print.
 */
export class LocalPrintLedger {
  private readonly directory: string;

  public constructor(spoolDirectory: string) {
    this.directory = resolve(spoolDirectory, "ledger");
  }

  public async record(operationId: string, entry: LocalPrintLedgerEntry): Promise<void> {
    const path = this.pathFor(operationId);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await appendFile(path, `${JSON.stringify({ entry, at: new Date().toISOString() })}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
  }

  /**
   * Whether this kiosk already told a device about this operation. A `true`
   * here forbids resubmitting: the device must be asked what it did instead.
   */
  public async hasSubmitted(operationId: string): Promise<boolean> {
    let contents: string;
    try {
      contents = await readFile(this.pathFor(operationId), "utf8");
    } catch {
      return false;
    }
    return contents
      .split("\n")
      .some(
        (line) => line.includes(`"entry":"SUBMITTING"`) || line.includes(`"entry": "SUBMITTING"`)
      );
  }

  private pathFor(operationId: string): string {
    if (!OPERATION_ID_PATTERN.test(operationId)) throw new Error("PRINT_OPERATION_ID_INVALID");
    const candidate = resolve(this.directory, `${operationId}.jsonl`);
    // The pattern already excludes separators; proving containment makes that a
    // property of the filesystem rather than of a regular expression.
    if (!candidate.startsWith(this.directory + sep)) throw new Error("PRINT_LEDGER_PATH_INVALID");
    return candidate;
  }
}

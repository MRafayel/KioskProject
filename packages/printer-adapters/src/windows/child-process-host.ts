import { spawn } from "node:child_process";

import type { DeviceHostTransport } from "./adapter.js";
import type { DeviceHostRequest } from "./protocol.js";

/** A host answer is JSON, never a document. Anything larger is a broken host. */
const MAX_RESPONSE_BYTES = 256 * 1024;

export interface ChildProcessDeviceHostOptions {
  /** Absolute path to the host executable. Configuration, never derived input. */
  executablePath: string;
  /** Arguments the host is launched with, before the request is written. */
  arguments?: readonly string[];
  /** The working directory the host runs in. */
  workingDirectory?: string;
}

/**
 * The default device host transport: one process per request.
 *
 * A long-lived host with correlation identifiers would save a few hundred
 * milliseconds per call and cost the property that matters more — a host that
 * wedges cannot wedge the agent with it. Print operations are rare and already
 * measured in seconds, so the trade is one-sided. It also means the host holds
 * no in-memory state between calls, which is what forces it to persist the
 * operation-to-job mapping that a restart has to be resolved from.
 *
 * The request goes to standard input and the answer comes back as one JSON
 * document on standard output. Standard error is never parsed; a host that
 * writes a diagnostic there cannot change what this decides.
 */
export class ChildProcessDeviceHost implements DeviceHostTransport {
  public constructor(private readonly options: ChildProcessDeviceHostOptions) {}

  public request(
    request: DeviceHostRequest,
    options: { timeoutMilliseconds: number }
  ): Promise<unknown> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(this.options.executablePath, [...(this.options.arguments ?? [])], {
        ...(this.options.workingDirectory ? { cwd: this.options.workingDirectory } : {}),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });

      let output = "";
      let settled = false;
      const finish = (error: Error | null, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) rejectPromise(error);
        else resolvePromise(value);
      };

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error("DEVICE_HOST_TIMEOUT"));
      }, options.timeoutMilliseconds);
      timer.unref?.();

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        if (output.length > MAX_RESPONSE_BYTES) {
          child.kill("SIGKILL");
          finish(new Error("DEVICE_HOST_RESPONSE_TOO_LARGE"));
        }
      });
      // Drained so a chatty host cannot fill its pipe buffer and deadlock.
      child.stderr.resume();

      child.on("error", () => finish(new Error("DEVICE_HOST_UNAVAILABLE")));
      child.on("close", (code) => {
        if (code !== 0) {
          finish(new Error("DEVICE_HOST_EXIT_" + String(code)));
          return;
        }
        try {
          finish(null, JSON.parse(output) as unknown);
        } catch {
          finish(new Error("DEVICE_HOST_RESPONSE_INVALID"));
        }
      });

      child.stdin.on("error", () => finish(new Error("DEVICE_HOST_UNAVAILABLE")));
      child.stdin.end(JSON.stringify(request) + "\n", "utf8");
    });
  }
}

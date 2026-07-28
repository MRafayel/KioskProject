import { once } from "node:events";
import { createReadStream } from "node:fs";
import { createConnection, type Socket } from "node:net";

import { ProcessorError } from "./errors.js";
import type { MalwareScanner, MalwareScanResult } from "./types.js";

const MAX_CLAM_RESPONSE_BYTES = 16 * 1024;
const CLAM_STREAM_CHUNK_BYTES = 64 * 1024;
const FUTURE_CLOCK_TOLERANCE_MS = 5 * 60 * 1_000;
const SAFE_VERSION_METADATA = /^[A-Za-z0-9._:+-]{1,80}$/u;

export interface ClamAvClientOptions {
  socketPath?: string;
  host?: string;
  port?: number;
  timeoutMilliseconds: number;
  definitionMaxAgeMilliseconds: number;
  maxStreamBytes: number;
  now?: () => Date;
  connectionFactory?: () => Socket;
}

export interface ParsedClamVersion {
  engineVersion: string;
  definitionsVersion: string;
  definitionsUpdatedAt: Date;
}

export class ClamAvClient implements MalwareScanner {
  private readonly now: () => Date;
  private readonly connect: () => Socket;

  public constructor(private readonly options: ClamAvClientOptions) {
    this.now = options.now ?? (() => new Date());
    if (!options.socketPath && (!options.host || !options.port)) {
      throw new Error("CLAMAV_ENDPOINT_REQUIRED");
    }
    this.connect =
      options.connectionFactory ??
      (() =>
        options.socketPath
          ? createConnection({ path: options.socketPath })
          : createConnection({
              host: options.host ?? "127.0.0.1",
              port: options.port ?? 3310
            }));
  }

  public async checkReady(signal?: AbortSignal): Promise<MalwareScanResult> {
    try {
      const rawVersion = await this.command("zVERSION\0", signal);
      const version = parseClamVersion(rawVersion);
      this.assertFresh(version.definitionsUpdatedAt);
      return {
        engineVersion: version.engineVersion,
        definitionsVersion: version.definitionsVersion,
        scannedAt: this.now().toISOString()
      };
    } catch (error) {
      if (error instanceof ProcessorError) throw error;
      throw new ProcessorError("MALWARE_SCANNER_UNAVAILABLE", 503, true);
    }
  }

  public async scan(path: string, signal?: AbortSignal): Promise<MalwareScanResult> {
    const version = await this.checkReady(signal);
    const socket = this.connect();
    try {
      await waitForConnection(socket, signal);
      const responsePromise = readNulTerminatedResponse(
        socket,
        this.options.timeoutMilliseconds,
        signal
      );
      // A file-read failure can happen before the response is awaited. Attach a
      // handler immediately so closing the socket cannot create an unhandled
      // rejection; awaiting the original promise still preserves the failure.
      void responsePromise.catch(() => undefined);
      await writeSocket(socket, Buffer.from("zINSTREAM\0"), signal);

      let streamedBytes = 0;
      const input = createReadStream(path, {
        highWaterMark: CLAM_STREAM_CHUNK_BYTES,
        ...(signal ? { signal } : {})
      });
      for await (const value of input) {
        const chunk = value as Buffer;
        streamedBytes += chunk.byteLength;
        if (streamedBytes > this.options.maxStreamBytes) {
          throw new ProcessorError("REQUEST_TOO_LARGE", 413);
        }
        const header = Buffer.allocUnsafe(4);
        header.writeUInt32BE(chunk.byteLength, 0);
        await writeSocket(socket, header, signal);
        await writeSocket(socket, chunk, signal);
      }
      await writeSocket(socket, Buffer.alloc(4), signal);

      const response = await responsePromise;
      if (/ FOUND$/u.test(response)) {
        throw new ProcessorError("MALWARE_DETECTED", 422);
      }
      if (!/ OK$/u.test(response)) {
        throw new ProcessorError("MALWARE_SCANNER_UNAVAILABLE", 503, true);
      }
      return { ...version, scannedAt: this.now().toISOString() };
    } catch (error) {
      if (error instanceof ProcessorError) throw error;
      throw new ProcessorError("MALWARE_SCANNER_UNAVAILABLE", 503, true);
    } finally {
      socket.destroy();
    }
  }

  private async command(command: string, signal?: AbortSignal): Promise<string> {
    const socket = this.connect();
    try {
      await waitForConnection(socket, signal);
      const response = readNulTerminatedResponse(socket, this.options.timeoutMilliseconds, signal);
      await writeSocket(socket, Buffer.from(command), signal);
      return await response;
    } finally {
      socket.destroy();
    }
  }

  private assertFresh(updatedAt: Date): void {
    const age = this.now().getTime() - updatedAt.getTime();
    if (age < -FUTURE_CLOCK_TOLERANCE_MS || age > this.options.definitionMaxAgeMilliseconds) {
      throw new ProcessorError("MALWARE_SCANNER_STALE", 503, true);
    }
  }
}

export function parseClamVersion(value: string): ParsedClamVersion {
  const normalized = value.replace(/\0+$/u, "").trim();
  const match = normalized.match(/^ClamAV\s+([^/\s]+)\/([^/\s]+)\/(.+)$/u);
  if (
    !match?.[1] ||
    !match[2] ||
    !match[3] ||
    !SAFE_VERSION_METADATA.test(match[1]) ||
    !SAFE_VERSION_METADATA.test(match[2])
  ) {
    throw new ProcessorError("MALWARE_SCANNER_UNAVAILABLE", 503, true);
  }
  const updatedMilliseconds = Date.parse(match[3]);
  if (!Number.isFinite(updatedMilliseconds)) {
    throw new ProcessorError("MALWARE_SCANNER_UNAVAILABLE", 503, true);
  }
  return {
    engineVersion: match[1],
    definitionsVersion: match[2],
    definitionsUpdatedAt: new Date(updatedMilliseconds)
  };
}

async function waitForConnection(socket: Socket, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!socket.connecting && !socket.destroyed) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      reject(asError(signal?.reason, "ABORTED"));
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function writeSocket(socket: Socket, value: Uint8Array, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (socket.write(value)) return;
  await once(socket, "drain", signal ? { signal } : undefined);
}

async function readNulTerminatedResponse(
  socket: Socket,
  timeoutMilliseconds: number,
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;

    const finish = (error?: unknown, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(asError(error, "CLAMAV_RESPONSE_FAILED"));
      else resolve(value ?? "");
    };
    const onData = (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_CLAM_RESPONSE_BYTES) {
        finish(new ProcessorError("MALWARE_SCANNER_UNAVAILABLE", 503, true));
        return;
      }
      const nul = chunk.indexOf(0);
      chunks.push(nul >= 0 ? chunk.subarray(0, nul) : chunk);
      if (nul >= 0 || chunk.includes(0x0a)) {
        finish(undefined, Buffer.concat(chunks).toString("utf8").trim());
      }
    };
    const onError = (error: Error) => finish(error);
    const onEnd = () => finish(new Error("CLAMAV_RESPONSE_INCOMPLETE"));
    const onAbort = () => finish(signal?.reason ?? new Error("ABORTED"));
    const timeout = setTimeout(
      () => finish(new ProcessorError("MALWARE_SCANNER_UNAVAILABLE", 503, true)),
      timeoutMilliseconds
    );
    timeout.unref();

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

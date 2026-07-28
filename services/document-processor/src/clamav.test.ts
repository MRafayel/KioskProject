import { writeFile, mkdtemp, rm } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex, type DuplexOptions } from "node:stream";

import { describe, expect, it } from "vitest";

import { ClamAvClient, parseClamVersion } from "./clamav.js";

describe("ClamAV protocol metadata", () => {
  it("parses engine, definition and freshness metadata without exposing scan text", () => {
    const parsed = parseClamVersion("ClamAV 1.4.3/27654/Thu Jul 23 12:00:00 2026\0");
    expect(parsed).toEqual({
      engineVersion: "1.4.3",
      definitionsVersion: "27654",
      definitionsUpdatedAt: new Date("Thu Jul 23 12:00:00 2026")
    });
  });

  it("fails closed when the version response cannot prove definition freshness", () => {
    expect(() => parseClamVersion("ClamAV unknown")).toThrowError(
      expect.objectContaining({ code: "MALWARE_SCANNER_UNAVAILABLE" })
    );
  });

  it("uses the bounded INSTREAM protocol and records fresh scanner metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clamav-test-"));
    const document = Buffer.from("%PDF-1.7\nsafe test bytes", "utf8");
    const path = join(directory, "input.bin");
    await writeFile(path, document);
    const fake = new FakeClamAv({
      version: "ClamAV 1.4.3/27654/Fri Jul 24 11:59:00 2026",
      scanResponse: "stream: OK"
    });

    try {
      const now = new Date("Fri Jul 24 12:00:00 2026");
      const client = new ClamAvClient({
        host: "127.0.0.1",
        port: 3310,
        timeoutMilliseconds: 1_000,
        definitionMaxAgeMilliseconds: 60 * 60 * 1_000,
        maxStreamBytes: 1_024,
        now: () => now,
        connectionFactory: fake.connectionFactory
      });

      await expect(client.scan(path)).resolves.toEqual({
        engineVersion: "1.4.3",
        definitionsVersion: "27654",
        scannedAt: now.toISOString()
      });
      expect(fake.streamed()).toEqual(document);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when INSTREAM reports malware", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clamav-test-"));
    const path = join(directory, "input.bin");
    await writeFile(path, Buffer.from("malware test bytes", "utf8"));
    const fake = new FakeClamAv({
      version: "ClamAV 1.4.3/27654/Fri Jul 24 11:59:00 2026",
      scanResponse: "stream: Unit-Test-Signature FOUND"
    });

    try {
      const client = new ClamAvClient({
        host: "127.0.0.1",
        port: 3310,
        timeoutMilliseconds: 1_000,
        definitionMaxAgeMilliseconds: 60 * 60 * 1_000,
        maxStreamBytes: 1_024,
        now: () => new Date("Fri Jul 24 12:00:00 2026"),
        connectionFactory: fake.connectionFactory
      });

      await expect(client.scan(path)).rejects.toMatchObject({
        code: "MALWARE_DETECTED",
        retryable: false
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("fails closed and retryable when the scanner never answers before the timeout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clamav-test-"));
    const path = join(directory, "input.bin");
    await writeFile(path, Buffer.from("%PDF-1.7\nslow scanner bytes", "utf8"));
    const fake = new FakeClamAv({
      version: "ClamAV 1.4.3/27654/Fri Jul 24 11:59:00 2026",
      scanResponse: undefined
    });

    try {
      const client = new ClamAvClient({
        host: "127.0.0.1",
        port: 3310,
        timeoutMilliseconds: 50,
        definitionMaxAgeMilliseconds: 60 * 60 * 1_000,
        maxStreamBytes: 1_024,
        now: () => new Date("Fri Jul 24 12:00:00 2026"),
        connectionFactory: fake.connectionFactory
      });

      await expect(client.scan(path)).rejects.toMatchObject({
        code: "MALWARE_SCANNER_UNAVAILABLE",
        retryable: true
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed and retryable when the scanner answers with an error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clamav-test-"));
    const path = join(directory, "input.bin");
    await writeFile(path, Buffer.from("%PDF-1.7\nunscannable bytes", "utf8"));
    const fake = new FakeClamAv({
      version: "ClamAV 1.4.3/27654/Fri Jul 24 11:59:00 2026",
      scanResponse: "INSTREAM size limit exceeded. ERROR"
    });

    try {
      const client = new ClamAvClient({
        host: "127.0.0.1",
        port: 3310,
        timeoutMilliseconds: 1_000,
        definitionMaxAgeMilliseconds: 60 * 60 * 1_000,
        maxStreamBytes: 1_024,
        now: () => new Date("Fri Jul 24 12:00:00 2026"),
        connectionFactory: fake.connectionFactory
      });

      await expect(client.scan(path)).rejects.toMatchObject({
        code: "MALWARE_SCANNER_UNAVAILABLE",
        retryable: true
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed and retryable when definitions are older than the allowed age", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clamav-test-"));
    const path = join(directory, "input.bin");
    await writeFile(path, Buffer.from("%PDF-1.7\nstale definitions", "utf8"));
    const fake = new FakeClamAv({
      version: "ClamAV 1.4.3/27654/Mon Jul 20 11:59:00 2026",
      scanResponse: "stream: OK"
    });

    try {
      const client = new ClamAvClient({
        host: "127.0.0.1",
        port: 3310,
        timeoutMilliseconds: 1_000,
        definitionMaxAgeMilliseconds: 60 * 60 * 1_000,
        maxStreamBytes: 1_024,
        now: () => new Date("Fri Jul 24 12:00:00 2026"),
        connectionFactory: fake.connectionFactory
      });

      await expect(client.scan(path)).rejects.toMatchObject({
        code: "MALWARE_SCANNER_STALE",
        retryable: true
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses to stream more bytes than the configured scan limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clamav-test-"));
    const path = join(directory, "input.bin");
    await writeFile(path, Buffer.alloc(2_048, 0x41));
    const fake = new FakeClamAv({
      version: "ClamAV 1.4.3/27654/Fri Jul 24 11:59:00 2026",
      scanResponse: "stream: OK"
    });

    try {
      const client = new ClamAvClient({
        host: "127.0.0.1",
        port: 3310,
        timeoutMilliseconds: 1_000,
        definitionMaxAgeMilliseconds: 60 * 60 * 1_000,
        maxStreamBytes: 1_024,
        now: () => new Date("Fri Jul 24 12:00:00 2026"),
        connectionFactory: fake.connectionFactory
      });

      await expect(client.scan(path)).rejects.toMatchObject({ code: "REQUEST_TOO_LARGE" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

class FakeClamAv {
  private connectionNumber = 0;
  private readonly streamedChunks: Buffer[] = [];

  public constructor(
    private readonly responses: {
      version: string;
      scanResponse: string | undefined;
    }
  ) {}

  public readonly connectionFactory = (): Socket => {
    this.connectionNumber += 1;
    const connection =
      this.connectionNumber === 1
        ? new FakeClamSocket((received, respond) => {
            expect(received).toEqual(Buffer.from("zVERSION\0"));
            respond(`${this.responses.version}\0`);
          })
        : new FakeClamSocket((received, respond) => {
            consumeInstream(received, this.streamedChunks, () => {
              // An undefined response models a scanner that accepts the stream
              // and then never answers, exercising the response timeout.
              if (this.responses.scanResponse === undefined) return;
              respond(`${this.responses.scanResponse}\0`);
            });
          });
    return connection as unknown as Socket;
  };

  public streamed(): Buffer {
    return Buffer.concat(this.streamedChunks);
  }
}

class FakeClamSocket extends Duplex {
  private received = Buffer.alloc(0);

  public constructor(
    private readonly consume: (received: Buffer, respond: (value: string) => void) => void,
    options?: DuplexOptions
  ) {
    super(options);
  }

  public override _read(): void {
    // Test responses are pushed when the client writes a complete command.
  }

  public override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.received = Buffer.concat([this.received, chunk]);
    try {
      this.consume(this.received, (value) => this.push(Buffer.from(value)));
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error("FAKE_CLAMAV_FAILED"));
    }
  }
}

function consumeInstream(received: Buffer, streamedChunks: Buffer[], complete: () => void): void {
  const command = Buffer.from("zINSTREAM\0");
  if (received.byteLength < command.byteLength) return;
  if (!received.subarray(0, command.byteLength).equals(command)) {
    throw new Error("INVALID_CLAMAV_INSTREAM_COMMAND");
  }

  let remaining = received.subarray(command.byteLength);
  const completeChunks: Buffer[] = [];
  while (remaining.byteLength >= 4) {
    const size = remaining.readUInt32BE(0);
    if (size === 0) {
      if (remaining.byteLength !== 4) throw new Error("TRAILING_CLAMAV_TEST_BYTES");
      streamedChunks.splice(0, streamedChunks.length, ...completeChunks);
      complete();
      return;
    }
    if (remaining.byteLength < size + 4) return;
    completeChunks.push(Buffer.from(remaining.subarray(4, size + 4)));
    remaining = remaining.subarray(size + 4);
  }
}

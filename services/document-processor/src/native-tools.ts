import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";

import { isAbortError, ProcessorError } from "./errors.js";
import type { NativeDocumentTools, PdfInspection, RasterFormat } from "./types.js";

const MAX_RETAINED_STDOUT_BYTES = 64 * 1024;

/**
 * qpdf reports recovered problems with exit code 3 and unrecoverable ones with
 * exit code 2. A file whose cross-reference table had to be rebuilt is still
 * fully renderable, so warnings must not be reported as a corrupt document.
 */
const QPDF_WARNING_EXIT_CODE = 3;

export interface CommandInput {
  executable: string;
  arguments: string[];
  allowedExitCodes?: number[];
  signal?: AbortSignal;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stdoutTruncated: boolean;
}

export interface CommandExecutor {
  execute(input: CommandInput): Promise<CommandResult>;
}

export interface SpawnCommandExecutorOptions {
  timeoutMilliseconds: number;
  path?: string;
}

export class SpawnCommandExecutor implements CommandExecutor {
  public constructor(private readonly options: SpawnCommandExecutorOptions) {}

  public async execute(input: CommandInput): Promise<CommandResult> {
    input.signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(this.options.timeoutMilliseconds);
    const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
    const allowedExitCodes = input.allowedExitCodes ?? [0];

    try {
      return await new Promise<CommandResult>((resolve, reject) => {
        const child = spawn(input.executable, input.arguments, {
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          signal,
          killSignal: "SIGKILL",
          env: {
            PATH:
              this.options.path ??
              process.env.PATH ??
              "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            LANG: "C",
            LC_ALL: "C",
            HOME: "/nonexistent"
          }
        });
        const stdoutChunks: Buffer[] = [];
        let stdoutBytes = 0;
        let stdoutTruncated = false;
        let settled = false;

        const finish = (error?: unknown, result?: CommandResult) => {
          if (settled) return;
          settled = true;
          if (error) {
            reject(error instanceof Error ? error : new Error("NATIVE_TOOL_FAILED"));
          } else if (result) resolve(result);
          else reject(new ProcessorError("NATIVE_TOOL_UNAVAILABLE", 503, true));
        };
        // Retain a bounded prefix and keep draining. Discarding the overflow
        // costs constant memory, while killing the tool would turn a merely
        // chatty document into a false corruption verdict. The configured tool
        // timeout still bounds how long a tool may keep writing.
        child.stdout.on("data", (chunk: Buffer) => {
          const remaining = MAX_RETAINED_STDOUT_BYTES - stdoutBytes;
          if (remaining <= 0) {
            stdoutTruncated = true;
            return;
          }
          if (chunk.byteLength > remaining) {
            stdoutTruncated = true;
            stdoutChunks.push(chunk.subarray(0, remaining));
            stdoutBytes = MAX_RETAINED_STDOUT_BYTES;
            return;
          }
          stdoutBytes += chunk.byteLength;
          stdoutChunks.push(chunk);
        });
        // Drain but never retain or return parser diagnostics. Warning volume
        // scales with page count and says nothing about whether the document
        // can be rendered, so it must never decide the outcome.
        child.stderr.resume();
        child.once("error", (error) => finish(error));
        child.once("close", (code) => {
          const exitCode = code ?? -1;
          if (!allowedExitCodes.includes(exitCode)) {
            finish(new ProcessorError("MALFORMED_DOCUMENT", 422));
            return;
          }
          finish(undefined, {
            exitCode,
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stdoutTruncated
          });
        });
      });
    } catch (error) {
      if (error instanceof ProcessorError) throw error;
      if (isAbortError(error)) throw new ProcessorError("PROCESSING_TIMEOUT", 422);
      throw new ProcessorError("NATIVE_TOOL_UNAVAILABLE", 503, true);
    }
  }
}

function rasterFormatArguments(format: RasterFormat): string[] {
  switch (format) {
    case "tiff":
      return ["-tiff", "-tiffcompression", "none"];
    case "tiff-deflate":
      return ["-tiff", "-tiffcompression", "deflate"];
    case "png":
      return ["-png"];
  }
}

function rasterFileExtension(format: RasterFormat): string {
  return format === "png" ? ".png" : ".tif";
}

export class QpdfPopplerTools implements NativeDocumentTools {
  public constructor(
    private readonly executor: CommandExecutor,
    private readonly maximumPages: number
  ) {}

  public async checkReady(signal?: AbortSignal): Promise<void> {
    await this.executor.execute({
      executable: "qpdf",
      arguments: ["--version"],
      ...(signal ? { signal } : {})
    });
    await this.executor.execute({
      executable: "pdftoppm",
      arguments: ["-v"],
      ...(signal ? { signal } : {})
    });
  }

  public async inspectPdf(path: string, signal?: AbortSignal): Promise<PdfInspection> {
    const encrypted = await this.executor.execute({
      executable: "qpdf",
      arguments: ["--is-encrypted", path],
      allowedExitCodes: [0, 2],
      ...(signal ? { signal } : {})
    });
    if (encrypted.exitCode === 0) {
      throw new ProcessorError("PASSWORD_PROTECTED_PDF", 422);
    }

    await this.executor.execute({
      executable: "qpdf",
      arguments: ["--password=", "--check", path],
      allowedExitCodes: [0, QPDF_WARNING_EXIT_CODE],
      ...(signal ? { signal } : {})
    });
    const pages = await this.executor.execute({
      executable: "qpdf",
      arguments: ["--password=", "--show-npages", path],
      allowedExitCodes: [0, QPDF_WARNING_EXIT_CODE],
      ...(signal ? { signal } : {})
    });
    const pageCountText = pages.stdout.trim();
    if (pages.stdoutTruncated || !/^[1-9]\d{0,5}$/u.test(pageCountText)) {
      throw new ProcessorError("MALFORMED_DOCUMENT", 422);
    }
    const pageCount = Number(pageCountText);
    if (pageCount > this.maximumPages) {
      throw new ProcessorError("PAGE_LIMIT_EXCEEDED", 422);
    }
    return { pageCount };
  }

  public async rasterizePdfPage(input: {
    inputPath: string;
    outputPrefix: string;
    pageNumber: number;
    maximumDimension: number;
    format: RasterFormat;
    signal?: AbortSignal;
  }): Promise<string> {
    await this.executor.execute({
      executable: "pdftoppm",
      arguments: [
        "-f",
        String(input.pageNumber),
        "-l",
        String(input.pageNumber),
        "-singlefile",
        "-gray",
        "-scale-to",
        String(input.maximumDimension),
        ...rasterFormatArguments(input.format),
        input.inputPath,
        input.outputPrefix
      ],
      ...(input.signal ? { signal: input.signal } : {})
    });
    const outputPath = `${input.outputPrefix}${rasterFileExtension(input.format)}`;
    const output = await lstat(outputPath).catch(() => undefined);
    if (!output?.isFile() || output.isSymbolicLink()) {
      throw new ProcessorError("MALFORMED_DOCUMENT", 422);
    }
    return outputPath;
  }

  public async assertCanonicalPdf(path: string, signal?: AbortSignal): Promise<void> {
    await this.executor.execute({
      executable: "qpdf",
      arguments: ["--password=", "--check", path],
      allowedExitCodes: [0, QPDF_WARNING_EXIT_CODE],
      ...(signal ? { signal } : {})
    });
  }
}

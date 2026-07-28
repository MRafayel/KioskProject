import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  QpdfPopplerTools,
  type CommandExecutor,
  type CommandInput,
  type CommandResult
} from "./native-tools.js";

describe("qpdf command boundary", () => {
  it("uses argv calls and rejects encryption before parsing pages", async () => {
    const executor = new FakeExecutor([result(0)]);
    const tools = new QpdfPopplerTools(executor, 200);

    await expect(tools.inspectPdf("/tmp/generated/input.bin")).rejects.toMatchObject({
      code: "PASSWORD_PROTECTED_PDF"
    });
    expect(executor.inputs).toEqual([
      {
        executable: "qpdf",
        arguments: ["--is-encrypted", "/tmp/generated/input.bin"],
        allowedExitCodes: [0, 2]
      }
    ]);
  });

  it("checks structure and enforces the page bound", async () => {
    const executor = new FakeExecutor([result(2), result(0), result(0, "201\n")]);
    const tools = new QpdfPopplerTools(executor, 200);

    await expect(tools.inspectPdf("/tmp/generated/input.bin")).rejects.toMatchObject({
      code: "PAGE_LIMIT_EXCEEDED"
    });
    expect(executor.inputs.map((input) => input.arguments)).toEqual([
      ["--is-encrypted", "/tmp/generated/input.bin"],
      ["--password=", "--check", "/tmp/generated/input.bin"],
      ["--password=", "--show-npages", "/tmp/generated/input.bin"]
    ]);
  });

  it("accepts a document qpdf recovered from with warnings", async () => {
    const executor = new FakeExecutor([result(2), result(3), result(3, "7\n")]);
    const tools = new QpdfPopplerTools(executor, 200);

    await expect(tools.inspectPdf("/tmp/generated/input.bin")).resolves.toEqual({ pageCount: 7 });
    expect(executor.inputs.map((input) => input.allowedExitCodes)).toEqual([
      [0, 2],
      [0, 3],
      [0, 3]
    ]);
  });

  it("rejects a page count that outgrew the retained output buffer", async () => {
    const executor = new FakeExecutor([
      result(2),
      result(0),
      { ...result(0, "3\n"), stdoutTruncated: true }
    ]);
    const tools = new QpdfPopplerTools(executor, 200);

    await expect(tools.inspectPdf("/tmp/generated/input.bin")).rejects.toMatchObject({
      code: "MALFORMED_DOCUMENT"
    });
  });

  it("accepts warnings when verifying the canonical output", async () => {
    const executor = new FakeExecutor([result(3)]);
    const tools = new QpdfPopplerTools(executor, 200);

    await expect(
      tools.assertCanonicalPdf("/tmp/generated/normalized.pdf")
    ).resolves.toBeUndefined();
    expect(executor.inputs[0]).toEqual({
      executable: "qpdf",
      arguments: ["--password=", "--check", "/tmp/generated/normalized.pdf"],
      allowedExitCodes: [0, 3]
    });
  });
});

describe("page rasterization format", () => {
  let scratchDirectory: string;

  beforeEach(async () => {
    scratchDirectory = await mkdtemp(join(tmpdir(), "raster-format-test-"));
  });

  afterEach(async () => {
    await rm(scratchDirectory, { recursive: true, force: true });
  });

  // The intermediate raster is scratch that Sharp reads once and deletes.
  // Every variant is lossless, so the format only decides how much CPU Poppler
  // spends compressing bytes we are about to throw away.
  it.each([
    { format: "tiff" as const, expected: ["-tiff", "-tiffcompression", "none"], extension: ".tif" },
    {
      format: "tiff-deflate" as const,
      expected: ["-tiff", "-tiffcompression", "deflate"],
      extension: ".tif"
    },
    { format: "png" as const, expected: ["-png"], extension: ".png" }
  ])("renders $format with the matching argv and extension", async (testCase) => {
    const outputPrefix = join(scratchDirectory, "page-000001");
    const executor = new WritingExecutor(`${outputPrefix}${testCase.extension}`);
    const tools = new QpdfPopplerTools(executor, 200);

    const produced = await tools.rasterizePdfPage({
      inputPath: "/tmp/generated/input.bin",
      outputPrefix,
      pageNumber: 7,
      maximumDimension: 3_508,
      format: testCase.format
    });

    expect(produced).toBe(`${outputPrefix}${testCase.extension}`);
    expect(executor.inputs[0]).toEqual({
      executable: "pdftoppm",
      arguments: [
        "-f",
        "7",
        "-l",
        "7",
        "-singlefile",
        "-gray",
        "-scale-to",
        "3508",
        ...testCase.expected,
        "/tmp/generated/input.bin",
        outputPrefix
      ]
    });
  });

  it("rejects a page whose renderer produced no output file", async () => {
    const outputPrefix = join(scratchDirectory, "page-000001");
    const executor = new FakeExecutor([result(0)]);
    const tools = new QpdfPopplerTools(executor, 200);

    await expect(
      tools.rasterizePdfPage({
        inputPath: "/tmp/generated/input.bin",
        outputPrefix,
        pageNumber: 1,
        maximumDimension: 3_508,
        format: "tiff"
      })
    ).rejects.toMatchObject({ code: "MALFORMED_DOCUMENT" });
  });
});

function result(exitCode: number, stdout = ""): CommandResult {
  return { exitCode, stdout, stdoutTruncated: false };
}

class FakeExecutor implements CommandExecutor {
  public readonly inputs: CommandInput[] = [];

  public constructor(private readonly results: CommandResult[]) {}

  public execute(input: CommandInput): Promise<CommandResult> {
    this.inputs.push(input);
    const result = this.results.shift();
    if (!result) throw new Error("UNEXPECTED_COMMAND");
    return Promise.resolve(result);
  }
}

/** Stands in for Poppler by producing the output file the real tool would. */
class WritingExecutor implements CommandExecutor {
  public readonly inputs: CommandInput[] = [];

  public constructor(private readonly outputPath: string) {}

  public async execute(input: CommandInput): Promise<CommandResult> {
    this.inputs.push(input);
    await writeFile(this.outputPath, Buffer.from("raster"));
    return { exitCode: 0, stdout: "", stdoutTruncated: false };
  }
}

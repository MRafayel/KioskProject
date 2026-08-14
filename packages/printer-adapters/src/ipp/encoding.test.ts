import { describe, expect, it } from "vitest";

import {
  decodeIppResponse,
  encodeIppRequest,
  integerAttribute,
  IPP_DELIMITER,
  IPP_OPERATION,
  IPP_TAG,
  IppProtocolError,
  keywordAttribute,
  nameAttribute,
  operationPreamble,
  readIntegerAttribute,
  readStringListAttribute,
  uriAttribute
} from "./encoding.js";

function encodeResponse(
  statusCode: number,
  requestId: number,
  groups: Parameters<typeof encodeIppRequest>[0]["groups"]
) {
  return encodeIppRequest({ operation: statusCode, requestId, groups });
}

describe("encodeIppRequest", () => {
  it("writes the header the way RFC 8010 lays it out", () => {
    const bytes = encodeIppRequest({
      operation: IPP_OPERATION.GET_PRINTER_ATTRIBUTES,
      requestId: 7,
      groups: [
        {
          tag: IPP_DELIMITER.OPERATION_ATTRIBUTES,
          attributes: [...operationPreamble(), uriAttribute("printer-uri", "ipp://p/ipp/print")]
        }
      ]
    });

    expect([...bytes.subarray(0, 8)]).toEqual([1, 1, 0x00, 0x0b, 0, 0, 0, 7]);
    expect(bytes[8]).toBe(IPP_DELIMITER.OPERATION_ATTRIBUTES);
    expect(bytes[bytes.byteLength - 1]).toBe(IPP_DELIMITER.END_OF_ATTRIBUTES);
  });

  it("appends the document after the end-of-attributes marker", () => {
    const data = new TextEncoder().encode("%PDF-1.7\n");
    const bytes = encodeIppRequest({
      operation: IPP_OPERATION.PRINT_JOB,
      requestId: 1,
      groups: [{ tag: IPP_DELIMITER.OPERATION_ATTRIBUTES, attributes: operationPreamble() }],
      data
    });

    expect([...bytes.subarray(bytes.byteLength - data.byteLength)]).toEqual([...data]);
    expect(bytes[bytes.byteLength - data.byteLength - 1]).toBe(IPP_DELIMITER.END_OF_ATTRIBUTES);
  });

  /**
   * Multi-value attributes are how `requested-attributes` is sent, and the
   * additional values carry a zero-length name rather than repeating it.
   */
  it("names only the first value of a multi-valued attribute", () => {
    const bytes = encodeIppRequest({
      operation: IPP_OPERATION.GET_JOBS,
      requestId: 2,
      groups: [
        {
          tag: IPP_DELIMITER.OPERATION_ATTRIBUTES,
          attributes: [keywordAttribute("requested-attributes", ["job-id", "job-state"])]
        }
      ]
    });

    const decoded = decodeIppResponse(bytes);
    expect(
      readStringListAttribute(decoded, IPP_DELIMITER.OPERATION_ATTRIBUTES, "requested-attributes")
    ).toEqual(["job-id", "job-state"]);
  });

  it("refuses an attribute with no value at all", () => {
    expect(() =>
      encodeIppRequest({
        operation: IPP_OPERATION.GET_JOBS,
        requestId: 1,
        groups: [
          {
            tag: IPP_DELIMITER.OPERATION_ATTRIBUTES,
            attributes: [{ name: "x", tag: IPP_TAG.KEYWORD, values: [] }]
          }
        ]
      })
    ).toThrow(IppProtocolError);
  });
});

describe("decodeIppResponse", () => {
  it("reads attributes back out of their groups", () => {
    const bytes = encodeResponse(0x0000, 11, [
      {
        tag: IPP_DELIMITER.PRINTER_ATTRIBUTES,
        attributes: [
          integerAttribute("printer-state", 3),
          keywordAttribute("printer-state-reasons", ["none"]),
          nameAttribute("printer-make-and-model", "Kiosk Laser 400")
        ]
      }
    ]);

    const decoded = decodeIppResponse(bytes);
    expect(decoded.statusCode).toBe(0);
    expect(decoded.requestId).toBe(11);
    expect(readIntegerAttribute(decoded, IPP_DELIMITER.PRINTER_ATTRIBUTES, "printer-state")).toBe(
      3
    );
    expect(
      readStringListAttribute(decoded, IPP_DELIMITER.PRINTER_ATTRIBUTES, "printer-state-reasons")
    ).toEqual(["none"]);
  });

  it("reads the upper bound of a range, which is what copies-supported is", () => {
    const range = new Uint8Array(8);
    const view = new DataView(range.buffer);
    view.setInt32(0, 1, false);
    view.setInt32(4, 99, false);

    const bytes = new Uint8Array([
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      3,
      IPP_DELIMITER.PRINTER_ATTRIBUTES,
      IPP_TAG.RANGE_OF_INTEGER,
      0,
      "copies-supported".length,
      ...new TextEncoder().encode("copies-supported"),
      0,
      8,
      ...range,
      IPP_DELIMITER.END_OF_ATTRIBUTES
    ]);

    expect(
      readIntegerAttribute(
        decodeIppResponse(bytes),
        IPP_DELIMITER.PRINTER_ATTRIBUTES,
        "copies-supported"
      )
    ).toBe(99);
  });

  /**
   * Every byte here comes off the network from a device. A truncated,
   * over-declared or unterminated message must fail rather than be read past
   * the end of its own buffer.
   */
  it("refuses a message that ends early", () => {
    const bytes = encodeResponse(0x0000, 1, [
      { tag: IPP_DELIMITER.PRINTER_ATTRIBUTES, attributes: [integerAttribute("printer-state", 3)] }
    ]);

    expect(() => decodeIppResponse(bytes.subarray(0, 4))).toThrow(IppProtocolError);
    expect(() => decodeIppResponse(bytes.subarray(0, bytes.byteLength - 6))).toThrow(
      IppProtocolError
    );
  });

  it("refuses a message with no end-of-attributes marker", () => {
    const bytes = encodeResponse(0x0000, 1, [
      { tag: IPP_DELIMITER.PRINTER_ATTRIBUTES, attributes: [integerAttribute("printer-state", 3)] }
    ]);

    expect(() => decodeIppResponse(bytes.subarray(0, bytes.byteLength - 1))).toThrow(
      IppProtocolError
    );
  });

  it("refuses a value length that runs past the buffer", () => {
    const bytes = new Uint8Array([
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      1,
      IPP_DELIMITER.PRINTER_ATTRIBUTES,
      IPP_TAG.KEYWORD,
      0,
      1,
      0x61,
      0xff,
      0xff,
      0x00,
      IPP_DELIMITER.END_OF_ATTRIBUTES
    ]);

    expect(() => decodeIppResponse(bytes)).toThrow(IppProtocolError);
  });

  it("refuses an additional value with no attribute to belong to", () => {
    const bytes = new Uint8Array([
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      1,
      IPP_DELIMITER.PRINTER_ATTRIBUTES,
      IPP_TAG.KEYWORD,
      0,
      0,
      0,
      1,
      0x61,
      IPP_DELIMITER.END_OF_ATTRIBUTES
    ]);

    expect(() => decodeIppResponse(bytes)).toThrow(IppProtocolError);
  });

  it("stops a device that declares more attributes than it may", () => {
    const attributes = Array.from({ length: 12 }, (unused, index) =>
      integerAttribute("attribute-" + String(index), index)
    );
    const bytes = encodeResponse(0x0000, 1, [
      { tag: IPP_DELIMITER.PRINTER_ATTRIBUTES, attributes }
    ]);

    expect(() => decodeIppResponse(bytes, { maxAttributes: 4, maxValueBytes: 1_024 })).toThrow(
      IppProtocolError
    );
  });
});

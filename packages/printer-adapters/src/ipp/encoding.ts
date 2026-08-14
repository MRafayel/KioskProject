/**
 * The IPP wire format, encoded and decoded here rather than pulled from a
 * dependency.
 *
 * The protocol is small — a fixed nine-byte header, then length-prefixed
 * attributes in delimited groups — and every byte of a response comes from a
 * device on the local network. That makes the decoder the boundary this package
 * cares most about: it is handed untrusted input and must never allocate on a
 * declared length it has not already seen, walk past the end of the buffer, or
 * loop on a zero-length record. Each of those is a bounds check below rather
 * than an assumption.
 */

export const IPP_VERSION_MAJOR = 1;
export const IPP_VERSION_MINOR = 1;

export const IPP_OPERATION = {
  PRINT_JOB: 0x0002,
  VALIDATE_JOB: 0x0004,
  CANCEL_JOB: 0x0008,
  GET_JOB_ATTRIBUTES: 0x0009,
  GET_JOBS: 0x000a,
  GET_PRINTER_ATTRIBUTES: 0x000b
} as const;

export const IPP_DELIMITER = {
  OPERATION_ATTRIBUTES: 0x01,
  JOB_ATTRIBUTES: 0x02,
  END_OF_ATTRIBUTES: 0x03,
  PRINTER_ATTRIBUTES: 0x04,
  UNSUPPORTED_ATTRIBUTES: 0x05
} as const;

export const IPP_TAG = {
  UNSUPPORTED: 0x10,
  UNKNOWN: 0x12,
  NO_VALUE: 0x13,
  INTEGER: 0x21,
  BOOLEAN: 0x22,
  ENUM: 0x23,
  OCTET_STRING: 0x30,
  DATE_TIME: 0x31,
  RESOLUTION: 0x32,
  RANGE_OF_INTEGER: 0x33,
  BEG_COLLECTION: 0x34,
  TEXT_WITH_LANGUAGE: 0x35,
  NAME_WITH_LANGUAGE: 0x36,
  END_COLLECTION: 0x37,
  TEXT_WITHOUT_LANGUAGE: 0x41,
  NAME_WITHOUT_LANGUAGE: 0x42,
  KEYWORD: 0x44,
  URI: 0x45,
  CHARSET: 0x47,
  NATURAL_LANGUAGE: 0x48,
  MIME_MEDIA_TYPE: 0x49,
  MEMBER_ATTR_NAME: 0x4a
} as const;

/** Anything at or above this is a refusal rather than an outcome. */
export const IPP_STATUS_CLIENT_ERROR = 0x0400;
export const IPP_STATUS_SUCCESS_MAX = 0x00ff;

/** IPP job states (RFC 8011 §5.3.7). */
export const IPP_JOB_STATE = {
  PENDING: 3,
  PENDING_HELD: 4,
  PROCESSING: 5,
  PROCESSING_STOPPED: 6,
  CANCELED: 7,
  ABORTED: 8,
  COMPLETED: 9
} as const;

/** IPP printer states (RFC 8011 §5.4.11). */
export const IPP_PRINTER_STATE = {
  IDLE: 3,
  PROCESSING: 4,
  STOPPED: 5
} as const;

export type IppValue = string | number | boolean;

export interface IppAttribute {
  name: string;
  tag: number;
  values: IppValue[];
}

export interface IppGroup {
  tag: number;
  attributes: IppAttribute[];
}

export interface IppRequest {
  operation: number;
  requestId: number;
  groups: readonly IppGroup[];
  /** The document bytes appended after the attributes, for Print-Job. */
  data?: Uint8Array;
}

export interface IppResponse {
  statusCode: number;
  requestId: number;
  groups: IppGroup[];
}

export class IppProtocolError extends Error {
  public constructor(public readonly reason: string) {
    super(reason);
    this.name = "IppProtocolError";
  }
}

/** Ceilings a device cannot talk this decoder past. */
export interface IppDecodeLimits {
  maxAttributes: number;
  maxValueBytes: number;
}

const DEFAULT_DECODE_LIMITS: IppDecodeLimits = {
  maxAttributes: 4_096,
  maxValueBytes: 65_535
};

export function encodeIppRequest(request: IppRequest): Uint8Array {
  const chunks: Uint8Array[] = [];
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  header[0] = IPP_VERSION_MAJOR;
  header[1] = IPP_VERSION_MINOR;
  view.setUint16(2, request.operation, false);
  view.setUint32(4, request.requestId, false);
  chunks.push(header);

  for (const group of request.groups) {
    chunks.push(Uint8Array.of(group.tag));
    for (const attribute of group.attributes) {
      if (attribute.values.length === 0) {
        throw new IppProtocolError("IPP_ATTRIBUTE_WITHOUT_VALUE");
      }
      for (const [index, value] of attribute.values.entries()) {
        // Only the first value of an attribute carries the name. Additional
        // values repeat the tag with a zero-length name.
        chunks.push(encodeAttributeValue(attribute.tag, index === 0 ? attribute.name : "", value));
      }
    }
  }

  chunks.push(Uint8Array.of(IPP_DELIMITER.END_OF_ATTRIBUTES));
  if (request.data && request.data.byteLength > 0) chunks.push(request.data);
  return concat(chunks);
}

export function decodeIppResponse(
  bytes: Uint8Array,
  limits: IppDecodeLimits = DEFAULT_DECODE_LIMITS
): IppResponse {
  if (bytes.byteLength < 9) throw new IppProtocolError("IPP_RESPONSE_TRUNCATED");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const statusCode = view.getUint16(2, false);
  const requestId = view.getUint32(4, false);

  const groups: IppGroup[] = [];
  let group: IppGroup | undefined;
  let attribute: IppAttribute | undefined;
  let attributeCount = 0;
  let offset = 8;

  while (offset < bytes.byteLength) {
    const tag = bytes[offset]!;
    offset += 1;

    if (tag === IPP_DELIMITER.END_OF_ATTRIBUTES) {
      if (group) groups.push(group);
      return { statusCode, requestId, groups };
    }

    if (isDelimiterTag(tag)) {
      if (group) groups.push(group);
      group = { tag, attributes: [] };
      attribute = undefined;
      continue;
    }

    if (offset + 2 > bytes.byteLength) throw new IppProtocolError("IPP_RESPONSE_TRUNCATED");
    const nameLength = view.getUint16(offset, false);
    offset += 2;
    if (nameLength > limits.maxValueBytes || offset + nameLength > bytes.byteLength) {
      throw new IppProtocolError("IPP_RESPONSE_TRUNCATED");
    }
    const name = decodeText(bytes.subarray(offset, offset + nameLength));
    offset += nameLength;

    if (offset + 2 > bytes.byteLength) throw new IppProtocolError("IPP_RESPONSE_TRUNCATED");
    const valueLength = view.getUint16(offset, false);
    offset += 2;
    if (valueLength > limits.maxValueBytes || offset + valueLength > bytes.byteLength) {
      throw new IppProtocolError("IPP_RESPONSE_TRUNCATED");
    }
    const raw = bytes.subarray(offset, offset + valueLength);
    offset += valueLength;

    if (!group) throw new IppProtocolError("IPP_ATTRIBUTE_OUTSIDE_GROUP");
    const value = decodeAttributeValue(tag, raw);

    if (nameLength === 0) {
      // An additional value for the attribute that came before it. A response
      // that opens with one is malformed rather than something to invent an
      // attribute for.
      if (!attribute) throw new IppProtocolError("IPP_ADDITIONAL_VALUE_WITHOUT_ATTRIBUTE");
      attribute.values.push(value);
      continue;
    }

    attributeCount += 1;
    if (attributeCount > limits.maxAttributes) throw new IppProtocolError("IPP_RESPONSE_TOO_LARGE");
    attribute = { name, tag, values: [value] };
    group.attributes.push(attribute);
  }

  throw new IppProtocolError("IPP_RESPONSE_UNTERMINATED");
}

export function findAttribute(
  response: IppResponse,
  groupTag: number,
  name: string
): IppAttribute | undefined {
  for (const group of response.groups) {
    if (group.tag !== groupTag) continue;
    const found = group.attributes.find((entry) => entry.name === name);
    if (found) return found;
  }
  return undefined;
}

export function readIntegerAttribute(
  response: IppResponse,
  groupTag: number,
  name: string
): number | null {
  const value = findAttribute(response, groupTag, name)?.values[0];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

export function readStringAttribute(
  response: IppResponse,
  groupTag: number,
  name: string
): string | null {
  const value = findAttribute(response, groupTag, name)?.values[0];
  return typeof value === "string" ? value : null;
}

export function readStringListAttribute(
  response: IppResponse,
  groupTag: number,
  name: string
): string[] {
  const attribute = findAttribute(response, groupTag, name);
  if (!attribute) return [];
  return attribute.values.filter((value): value is string => typeof value === "string");
}

export function textAttribute(name: string, value: string): IppAttribute {
  return { name, tag: IPP_TAG.TEXT_WITHOUT_LANGUAGE, values: [value] };
}

export function nameAttribute(name: string, value: string): IppAttribute {
  return { name, tag: IPP_TAG.NAME_WITHOUT_LANGUAGE, values: [value] };
}

export function keywordAttribute(name: string, values: string | string[]): IppAttribute {
  return { name, tag: IPP_TAG.KEYWORD, values: Array.isArray(values) ? values : [values] };
}

export function uriAttribute(name: string, value: string): IppAttribute {
  return { name, tag: IPP_TAG.URI, values: [value] };
}

export function integerAttribute(name: string, value: number): IppAttribute {
  return { name, tag: IPP_TAG.INTEGER, values: [value] };
}

export function enumAttribute(name: string, value: number): IppAttribute {
  return { name, tag: IPP_TAG.ENUM, values: [value] };
}

export function booleanAttribute(name: string, value: boolean): IppAttribute {
  return { name, tag: IPP_TAG.BOOLEAN, values: [value] };
}

export function mimeTypeAttribute(name: string, value: string): IppAttribute {
  return { name, tag: IPP_TAG.MIME_MEDIA_TYPE, values: [value] };
}

/** The charset and language pair every IPP request has to open with. */
export function operationPreamble(): IppAttribute[] {
  return [
    { name: "attributes-charset", tag: IPP_TAG.CHARSET, values: ["utf-8"] },
    { name: "attributes-natural-language", tag: IPP_TAG.NATURAL_LANGUAGE, values: ["en"] }
  ];
}

function isDelimiterTag(tag: number): boolean {
  return tag >= 0x00 && tag <= 0x05;
}

function encodeAttributeValue(tag: number, name: string, value: IppValue): Uint8Array {
  const nameBytes = encodeText(name);
  const valueBytes = encodeValueBytes(tag, value);
  if (nameBytes.byteLength > 0xffff || valueBytes.byteLength > 0xffff) {
    throw new IppProtocolError("IPP_ATTRIBUTE_TOO_LARGE");
  }

  const buffer = new Uint8Array(1 + 2 + nameBytes.byteLength + 2 + valueBytes.byteLength);
  const view = new DataView(buffer.buffer);
  buffer[0] = tag;
  view.setUint16(1, nameBytes.byteLength, false);
  buffer.set(nameBytes, 3);
  view.setUint16(3 + nameBytes.byteLength, valueBytes.byteLength, false);
  buffer.set(valueBytes, 5 + nameBytes.byteLength);
  return buffer;
}

function encodeValueBytes(tag: number, value: IppValue): Uint8Array {
  if (tag === IPP_TAG.INTEGER || tag === IPP_TAG.ENUM) {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw new IppProtocolError("IPP_VALUE_NOT_INTEGER");
    }
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setInt32(0, value, false);
    return bytes;
  }
  if (tag === IPP_TAG.BOOLEAN) {
    if (typeof value !== "boolean") throw new IppProtocolError("IPP_VALUE_NOT_BOOLEAN");
    return Uint8Array.of(value ? 1 : 0);
  }
  if (typeof value !== "string") throw new IppProtocolError("IPP_VALUE_NOT_TEXT");
  return encodeText(value);
}

function decodeAttributeValue(tag: number, raw: Uint8Array): IppValue {
  if (tag === IPP_TAG.INTEGER || tag === IPP_TAG.ENUM) {
    if (raw.byteLength !== 4) throw new IppProtocolError("IPP_INTEGER_LENGTH_INVALID");
    return new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getInt32(0, false);
  }
  if (tag === IPP_TAG.BOOLEAN) {
    if (raw.byteLength !== 1) throw new IppProtocolError("IPP_BOOLEAN_LENGTH_INVALID");
    return raw[0] === 1;
  }
  if (tag === IPP_TAG.RANGE_OF_INTEGER) {
    if (raw.byteLength !== 8) throw new IppProtocolError("IPP_RANGE_LENGTH_INVALID");
    // Only the upper bound is ever read here: `copies-supported` is a range and
    // what the kiosk needs from it is the ceiling.
    return new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getInt32(4, false);
  }
  if (
    tag === IPP_TAG.TEXT_WITH_LANGUAGE ||
    tag === IPP_TAG.NAME_WITH_LANGUAGE ||
    tag === IPP_TAG.DATE_TIME ||
    tag === IPP_TAG.RESOLUTION ||
    tag === IPP_TAG.OCTET_STRING ||
    tag === IPP_TAG.BEG_COLLECTION ||
    tag === IPP_TAG.END_COLLECTION ||
    tag === IPP_TAG.UNSUPPORTED ||
    tag === IPP_TAG.UNKNOWN ||
    tag === IPP_TAG.NO_VALUE
  ) {
    // Structured and out-of-band values are kept only as a placeholder. Nothing
    // this package decides is read from one, and inventing a string for a
    // collection would let a device's nesting look like a plain keyword.
    return "";
  }
  return decodeText(raw);
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

function encodeText(value: string): Uint8Array {
  return textEncoder.encode(value);
}

function decodeText(value: Uint8Array): string {
  return textDecoder.decode(value);
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

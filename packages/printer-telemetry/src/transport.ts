import {
  AuthProtocols,
  ObjectType,
  PrivProtocols,
  SecurityLevel,
  createV3Session,
  isVarbindError,
  type Session,
  type SessionOptionsV3,
  type User,
  type Varbind
} from "net-snmp";

import { SnmpTimeoutError } from "./client.js";
import type { SnmpTransport, SnmpVarbind } from "./types.js";

/**
 * The only file in this package that touches the network or the SNMP library.
 *
 * Everything above it is pure and runs in tests without a printer, which is what
 * makes the parsing of untrusted device output exhaustively testable. Keeping
 * the dependency to one file is also what keeps its blast radius small: the
 * library sees a target address, one user, and nine hard-coded OIDs.
 *
 * Reads are `GETBULK`, one round trip per column. `maxRepetitions` bounds the
 * reply in the protocol itself, so a device cannot make the kiosk loop by
 * feeding it rows — unlike a walk, where the far end decides when to stop.
 */

export type SnmpAuthProtocol = "md5" | "sha" | "sha224" | "sha256" | "sha384" | "sha512";
export type SnmpPrivProtocol = "des" | "aes" | "aes256b" | "aes256r";

export interface SnmpTransportOptions {
  /** An IPv4 literal. Never a hostname: no name resolution on this segment. */
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly authProtocol: SnmpAuthProtocol;
  readonly authKey: string;
  readonly privProtocol: SnmpPrivProtocol;
  readonly privKey: string;
  readonly requestTimeoutMs: number;
  /**
   * Which local interface to send from. Pinning it keeps telemetry on the
   * printer's dedicated adapter even if the routing table changes, so a
   * misconfigured metric cannot put SNMP traffic on the kiosk's uplink. Empty
   * lets the operating system choose.
   */
  readonly sourceAddress: string;
}

const AUTH_PROTOCOLS: Readonly<Record<SnmpAuthProtocol, AuthProtocols>> = {
  md5: AuthProtocols.md5,
  sha: AuthProtocols.sha,
  sha224: AuthProtocols.sha224,
  sha256: AuthProtocols.sha256,
  sha384: AuthProtocols.sha384,
  sha512: AuthProtocols.sha512
};

const PRIV_PROTOCOLS: Readonly<Record<SnmpPrivProtocol, PrivProtocols>> = {
  des: PrivProtocols.des,
  aes: PrivProtocols.aes,
  aes256b: PrivProtocols.aes256b,
  aes256r: PrivProtocols.aes256r
};

/**
 * `noAuthNoPriv` and `authNoPriv` are not offered. There is no configuration of
 * this kiosk that sends unauthenticated SNMP, and none that sends telemetry in
 * clear text, so neither can be reached by getting an environment variable
 * wrong.
 */
export function createSnmpTransport(options: SnmpTransportOptions): SnmpTransport {
  const user: User = {
    name: options.user,
    level: SecurityLevel.authPriv,
    authProtocol: AUTH_PROTOCOLS[options.authProtocol],
    authKey: options.authKey,
    privProtocol: PRIV_PROTOCOLS[options.privProtocol],
    privKey: options.privKey
  };

  const sessionOptions: SessionOptionsV3 = {
    version: 3,
    transport: "udp4",
    port: options.port,
    // Retries are the client's job, once, against a shared budget. Letting the
    // library retry too would multiply the two and quietly overrun it.
    retries: 0,
    timeout: options.requestTimeoutMs,
    ...(options.sourceAddress.trim().length > 0
      ? { sourceAddress: options.sourceAddress.trim() }
      : {})
  };

  let session: Session | null = createV3Session(options.host, user, sessionOptions);

  return {
    walkColumn(columnOid: string, maxRows: number): Promise<readonly SnmpVarbind[]> {
      const active = session;
      if (active === null) return Promise.reject(new Error("SNMP session is closed"));

      return new Promise<readonly SnmpVarbind[]>((resolve, reject) => {
        let settled = false;
        // The library's own timeout should fire first. This exists because a
        // callback that never runs would leave a request pending forever, and
        // the budget above can only end a reading it is told about.
        const guard = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new SnmpTimeoutError());
        }, options.requestTimeoutMs * 2);
        guard.unref?.();

        active.getBulk([columnOid], 0, maxRows, (error, varbinds) => {
          if (settled) return;
          settled = true;
          clearTimeout(guard);
          if (error) {
            reject(isTimeout(error) ? new SnmpTimeoutError() : redactedError(error));
            return;
          }
          // A `GETBULK` reply nests each repeater's rows in their own array,
          // and the column asked for here is a repeater. Both shapes are
          // flattened rather than assumed, because which one arrives depends on
          // the reply, not on the request.
          const flat = (varbinds ?? []).flatMap((entry) =>
            Array.isArray(entry) ? entry : [entry]
          );
          resolve(flat.flatMap(toSnmpVarbind));
        });
      });
    },
    close(): void {
      session?.close();
      session = null;
    }
  };
}

function isTimeout(error: Error): boolean {
  return error.name === "RequestTimedOutError";
}

/**
 * Re-wraps a library error with its message only.
 *
 * The original carries the session, and the session carries the authentication
 * and privacy keys. An error object that reaches a log or a crash report must
 * not be able to take them with it.
 */
function redactedError(error: Error): Error {
  const wrapped = new Error(`SNMP request failed: ${error.name}`);
  wrapped.name = "SnmpTransportError";
  return wrapped;
}

/**
 * Converts one binding, or drops it.
 *
 * A varbind whose type says one thing and whose value is another is discarded
 * rather than coerced: the layer above distinguishes "the device did not say"
 * from "the device said zero", and a coerced value would destroy that
 * distinction at the only point where it can still be seen.
 */
function toSnmpVarbind(varbind: Varbind): SnmpVarbind[] {
  // noSuchObject, noSuchInstance and endOfMibView all arrive as varbinds.
  if (isVarbindError(varbind)) return [];
  const value = varbind.value;

  switch (varbind.type) {
    case ObjectType.Integer:
    case ObjectType.Counter:
    case ObjectType.Gauge:
    case ObjectType.TimeTicks:
      return typeof value === "number" && Number.isSafeInteger(value)
        ? [{ oid: varbind.oid, integer: value, bytes: null }]
        : [];
    case ObjectType.OctetString:
      if (Buffer.isBuffer(value)) {
        return [{ oid: varbind.oid, integer: null, bytes: new Uint8Array(value) }];
      }
      // Some devices hand back a decoded string for printable octet strings.
      return typeof value === "string"
        ? [{ oid: varbind.oid, integer: null, bytes: new TextEncoder().encode(value) }]
        : [];
    default:
      return [];
  }
}

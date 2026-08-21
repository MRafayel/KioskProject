/**
 * Proves SNMPv3 authPriv against the real printer, and prints what it reports.
 *
 * This is the one thing Phase 0 could not settle. The verification script in
 * `infrastructure/windows` speaks SNMPv1 only — deliberately, because a
 * hand-rolled USM implementation in PowerShell would have been a great deal of
 * untested cryptography — so whether this firmware actually supports the
 * authenticated, encrypted combination we intend to ship can only be answered by
 * the client that will ship. That client is this package.
 *
 *   PRINTER_TELEMETRY_SNMP_AUTH_KEY=... PRINTER_TELEMETRY_SNMP_PRIV_KEY=... \
 *     pnpm --filter @printing-kiosk/printer-telemetry probe -- \
 *       --host 192.168.253.2 --user kiosk --serial PKQA002495
 *
 * Keys are read from the environment and never from arguments: a command line is
 * visible to every process on the machine and lands in shell history. Nothing
 * here prints a key, and a failure is reported by name only.
 */
import { setTimeout as delay } from "node:timers/promises";

import {
  createPrinterTelemetryClient,
  createSnmpTransport,
  type PrinterTelemetrySnapshot,
  type SnmpAuthProtocol,
  type SnmpPrivProtocol,
  type TelemetryReadResult
} from "../src/index.js";

const AUTH_PROTOCOLS = ["md5", "sha", "sha224", "sha256", "sha384", "sha512"] as const;
const PRIV_PROTOCOLS = ["des", "aes", "aes256b", "aes256r"] as const;

function readFlag(name: string, fallback = ""): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const host = readFlag("host");
const serial = readFlag("serial");
const user = readFlag("user");
const mac = readFlag("mac");
const port = Number.parseInt(readFlag("port", "161"), 10);
const seconds = Number.parseInt(readFlag("watch", "0"), 10);
const sourceAddress = readFlag("source");
const authProtocol = readFlag("auth", "sha256");
const privProtocol = readFlag("priv", "aes");
const authKey = process.env.PRINTER_TELEMETRY_SNMP_AUTH_KEY ?? "";
const privKey = process.env.PRINTER_TELEMETRY_SNMP_PRIV_KEY ?? "";

if (host.length === 0) fail("--host is required (an IPv4 address, never a hostname)");
if (user.length === 0) fail("--user is required (the SNMPv3 user name)");
if (serial.length === 0) fail("--serial is required (pinned identity; see the printer label)");
if (authKey.length === 0) fail("PRINTER_TELEMETRY_SNMP_AUTH_KEY is not set");
if (privKey.length === 0) fail("PRINTER_TELEMETRY_SNMP_PRIV_KEY is not set");
if (!isAuthProtocol(authProtocol)) fail(`--auth must be one of ${AUTH_PROTOCOLS.join(", ")}`);
if (!isPrivProtocol(privProtocol)) fail(`--priv must be one of ${PRIV_PROTOCOLS.join(", ")}`);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) fail("--port must be a port number");

function isAuthProtocol(value: string): value is SnmpAuthProtocol {
  return (AUTH_PROTOCOLS as readonly string[]).includes(value);
}

function isPrivProtocol(value: string): value is SnmpPrivProtocol {
  return (PRIV_PROTOCOLS as readonly string[]).includes(value);
}

const client = createPrinterTelemetryClient({
  transport: createSnmpTransport({
    host,
    port,
    user,
    authProtocol,
    authKey,
    privProtocol,
    privKey,
    requestTimeoutMs: 1_000,
    sourceAddress
  }),
  identity: { serialNumber: serial, macAddress: mac },
  clock: { now: () => new Date() },
  budgetMs: 8_000,
  attemptsPerColumn: 3
});

process.stdout.write(
  `probing ${host}:${String(port)} as "${user}" with authPriv (${authProtocol}/${privProtocol})\n\n`
);

try {
  const first = await client.read();
  describe(first);

  if (first.outcome === "OK" && seconds > 0) {
    process.stdout.write(
      `\nwatching for ${String(seconds)}s — send a job of a known page count now\n\n`
    );
    process.stdout.write("  time      engine      marker  unit         faults\n");
    const until = Date.now() + seconds * 1_000;
    while (Date.now() < until) {
      const reading = await client.read();
      process.stdout.write(`  ${line(reading)}\n`);
      await delay(1_000);
    }
  }
} finally {
  client.close();
}

function describe(result: TelemetryReadResult): void {
  if (result.outcome === "UNAVAILABLE") {
    process.stdout.write(`RESULT: no usable reading — ${result.reason}\n\n`);
    if (result.reason === "TIMEOUT" || result.reason === "TRANSPORT_ERROR") {
      process.stdout.write(
        "SNMPv3 authPriv did not answer. Before concluding the firmware cannot do it,\n" +
          "check in this order, because each has a different fix:\n" +
          "  1. the user exists on the printer and is enabled, with MIB access Read Only\n" +
          "  2. the authentication and encryption algorithms match --auth and --priv\n" +
          "  3. SNMPv1 is still on and v3 is off — some firmware serves only one\n" +
          "  4. the printer's IP filter permits this kiosk's address\n" +
          "Try other algorithm pairs before deciding: Canon firmware of this generation\n" +
          "often offers sha/des where the Remote UI implies more.\n"
      );
    }
    if (result.reason === "IDENTITY_MISMATCH") {
      process.stdout.write(
        "It answered, and it is not the printer this kiosk is pinned to. Check --serial\n" +
          "against the label, and check nothing else is on this cable.\n"
      );
    }
    process.exitCode = 1;
    return;
  }
  report(result.snapshot);
}

function report(snapshot: PrinterTelemetrySnapshot): void {
  process.stdout.write("RESULT: SNMPv3 authPriv works on this firmware.\n\n");
  process.stdout.write(`  serial      ${snapshot.serialNumber}\n`);
  process.stdout.write(`  engine      ${snapshot.engine}\n`);
  process.stdout.write(`  faults      ${snapshot.faults?.join(", ") || describeEmpty(snapshot.faults)}\n`);
  process.stdout.write(
    `  marker      ${
      snapshot.marker === null
        ? "not reported"
        : `${String(snapshot.marker.lifeCount)} (${snapshot.marker.unit})`
    }\n`
  );
  for (const input of snapshot.inputs ?? []) {
    process.stdout.write(
      `  tray ${String(input.index).padEnd(6)} ${input.presence}${
        input.sheets === null ? "" : ` (${String(input.sheets)} sheets)`
      }\n`
    );
  }
  for (const supply of snapshot.supplies ?? []) {
    process.stdout.write(
      `  supply ${String(supply.index).padEnd(4)} ${
        supply.percentRemaining === null ? "level not reported" : `${String(supply.percentRemaining)}%`
      }\n`
    );
  }

  if (snapshot.marker === null) {
    process.stdout.write(
      "\nNO-GO: the engine page counter did not read. It is the only signal that can\n" +
        "evidence physical output, so telemetry without it buys nothing actionable.\n"
    );
    process.exitCode = 1;
    return;
  }
  if (snapshot.marker.unit === "UNKNOWN") {
    process.stdout.write(
      "\nWARNING: prtMarkerCounterUnit did not read. Without it a duplex job cannot be\n" +
        "compared against the counter, because one sheet may count once or twice.\n"
    );
  }
}

function describeEmpty(faults: readonly string[] | null): string {
  // "none" and "did not say" are different answers and the difference decides
  // whether a job may be sold, so the report never collapses them.
  return faults === null ? "not reported" : "none";
}

function line(result: TelemetryReadResult): string {
  const time = new Date().toISOString().slice(11, 19);
  if (result.outcome === "UNAVAILABLE") return `${time}  ${result.reason}`;
  const { engine, marker, faults } = result.snapshot;
  return [
    time,
    engine.padEnd(10),
    String(marker?.lifeCount ?? "?").padStart(6),
    (marker?.unit ?? "?").padEnd(12),
    faults?.join(", ") || describeEmpty(faults)
  ].join("  ");
}

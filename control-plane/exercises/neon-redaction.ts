#!/usr/bin/env bun
// Exercise: drive deliberate connection failures and prove that NOTHING an
// application can see carries a fragment of the DSN.
//
// Ruling 8 says a DSN is redacted on the error path, not repaired after
// capture, so a transcript filter is not what is being tested here. What is
// tested is the boundary: the pg driver's own error object may hold the host
// and the role - measured 2026-08-11, a bad password answers SQLSTATE 28P01
// with `password authentication failed for user '<role>'`, and a refused port
// answers ECONNREFUSED with the address - and none of that may survive contact
// with anything that prints.
//
// Four failures, each against a real endpoint or a real refusal:
//   wrong password, wrong database, refused port, unresolvable name.
// For each one it captures every application-visible surface - message, code,
// stack, String(err), JSON.stringify(err), and the error a logger would walk a
// `cause` chain into - and scans them for the password, the role, the host, the
// endpoint id, the database name and the whole DSN.
//
// It carries a POSITIVE CONTROL, the way invite-persistence.test.ts does: one
// case that puts the DSN into an error on purpose and MUST be caught by the
// same scan. A scan that has never matched anything is not evidence.
//
// Output is booleans and counts. The captured text is never printed - printing
// it is the failure this file exists to detect.
//
// Usage:
//   bun control-plane/exercises/neon-redaction.ts

import pg from "pg";
import {
  Store,
  redactConnectionDetails,
  withGovernedOptions,
} from "../store.ts";
import { SUITES_BRANCH, targetFor } from "./neon-api.ts";

/**
 * Every component of the DSN a captured surface may not contain.
 *
 * NO LENGTH FILTER, and the port and every query parameter name and value are
 * in here - an earlier version skipped anything under four characters and
 * scanned no query values at all, so it could not have caught a short role, a
 * two-letter database, the port, or the `options` value it claimed to cover.
 */
function components(dsn: string): [string, string][] {
  const url = new URL(dsn);
  const out: [string, string][] = [
    ["the whole DSN", dsn],
    ["the password", decodeURIComponent(url.password)],
    ["the password, encoded", url.password],
    ["the role", decodeURIComponent(url.username)],
    ["the role, encoded", url.username],
    ["the host", url.hostname],
    ["the port", url.port],
    ["the database name", url.pathname.replace(/^\//, "")],
  ];
  // The endpoint id is the first label of the host and identifies the compute
  // on its own, so it is scanned for separately from the whole host.
  const label = url.hostname.split(".")[0];
  if (label) out.push(["the endpoint id", label]);
  for (const [name, value] of url.searchParams) {
    out.push([`the query parameter name ${name}`, name]);
    out.push([`the ${name} value`, value]);
    out.push([`the ${name} value, encoded`, encodeURIComponent(value)]);
    for (const token of value.split(/[\s=]+/)) {
      if (token) out.push([`a token of ${name}`, token]);
    }
  }
  return out.filter(([, value]) => value.length > 0);
}

/**
 * Everything an application can see of an error.
 *
 * The `cause` chain is walked deliberately: a logger that prints causes is
 * ordinary, and "we attached the driver's error as a cause" is exactly how a
 * redacted message gets undone one layer down.
 */
function surfaces(err: unknown): string[] {
  const out: string[] = [];
  let seen: unknown = err;
  for (let depth = 0; depth < 8 && seen; depth++) {
    const e = seen as { message?: string; stack?: string; cause?: unknown };
    out.push(Object.prototype.toString.call(seen));
    if (e.message) out.push(e.message);
    if (e.stack) out.push(e.stack);
    try {
      out.push(JSON.stringify(seen));
      out.push(JSON.stringify(seen, Object.getOwnPropertyNames(Object(seen))));
    } catch {
      // A circular error object is not a leak.
    }
    seen = e.cause;
  }
  return out.filter((s) => typeof s === "string" && s.length > 0);
}

let failures = 0;

function scan(label: string, dsn: string, captured: string[]): void {
  const hits: string[] = [];
  for (const [name, value] of components(dsn)) {
    if (captured.some((s) => s.includes(value))) hits.push(name);
  }
  const clean = hits.length === 0;
  if (!clean) failures++;
  console.log(
    `${label}: surfaces=${captured.length} no DSN fragment: ${clean}` +
      (clean ? "" : ` (leaked: ${hits.join(", ")})`),
  );
}

async function capture(dsn: string): Promise<string[]> {
  try {
    const store = await Store.open(dsn);
    await store.close();
    return [];
  } catch (err) {
    return surfaces(err);
  }
}

/**
 * The driver's OWN message for the same failure, taken from a bare pool.
 *
 * The component scan cannot catch this class: a driver message like `password
 * authentication failed for user ...` is free text, not a DSN component, and it
 * crossed the boundary on the stack's first line until it was rebuilt from
 * frames. So the live check is the direct one - whatever the driver actually
 * said, in full, must appear on no surface we emit.
 */
async function driverMessage(dsn: string): Promise<string | null> {
  const pool = new pg.Pool({
    connectionString: dsn,
    connectionTimeoutMillis: 30_000,
  });
  pool.on("error", () => {});
  try {
    await pool.query("select 1");
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : null;
  } finally {
    await pool.end().catch(() => {});
  }
}

async function main(): Promise<void> {
  // The real child endpoint, so the wrong-password and wrong-database cases are
  // answered by the managed engine rather than by a local container.
  const target = await targetFor(SUITES_BRANCH);
  const real = new URL(target.dsn);

  const wrongPassword = new URL(real.toString());
  wrongPassword.password = "not-the-password-9f2b1c";
  const wrongDatabase = new URL(real.toString());
  wrongDatabase.pathname = "/no_such_database_9f2b1c";
  const refused = new URL(real.toString());
  refused.hostname = "127.0.0.1";
  refused.port = "5599";
  refused.searchParams.set("sslmode", "disable");
  const unresolvable = new URL(real.toString());
  unresolvable.hostname = "no-such-host-9f2b1c.invalid";

  const cases: [string, URL][] = [
    ["wrong password", wrongPassword],
    ["wrong database", wrongDatabase],
    ["refused port", refused],
    ["unresolvable name", unresolvable],
  ];

  console.log(`endpoint host came from the API: ${target.hostFromApi}`);
  for (const [label, url] of cases) {
    const dsn = url.toString();
    const captured = await capture(dsn);
    if (captured.length === 0) {
      console.log(`${label}: CONNECTED - this case proves nothing`);
      failures++;
      continue;
    }
    scan(label, dsn, captured);

    // And the free-text class, which no component scan can see.
    const said = await driverMessage(dsn);
    if (said === null) {
      console.log(`  ${label}: the driver did not fail on a bare pool`);
      failures++;
      continue;
    }
    const echoed = captured.some((s) => s.includes(said));
    console.log(`  ${label}: the driver's own message is absent: ${!echoed}`);
    if (echoed) failures++;
  }

  // POSITIVE CONTROLS. A scan that has never matched anything is not evidence,
  // and one control leaking the WHOLE URL only proves the scan finds the whole
  // URL. So each control leaks exactly ONE component.
  //
  // They run against a DSN carrying `options`, because that is what the claim
  // is about and the built DSN does not have one until the store merges its
  // governed settings in - an earlier version of this file scanned a DSN with
  // no options at all and reported a pass for a case it never ran.
  const withOptions = withGovernedOptions(
    (() => {
      const u = new URL(real.toString());
      u.searchParams.set("options", "-c search_path=cp_probe_schema");
      return u.toString();
    })(),
  );
  const url = new URL(withOptions);
  const optionsValue = url.searchParams.get("options") ?? "";

  const controls: [string, string][] = [
    ["the whole DSN", withOptions],
    ["the password alone", decodeURIComponent(url.password)],
    ["the role alone", decodeURIComponent(url.username)],
    ["the host alone", url.hostname],
    ["the endpoint id alone", url.hostname.split(".")[0]],
    ["the database name alone", url.pathname.replace(/^\//, "")],
    ["the whole options value alone", optionsValue],
    ["one token out of options alone", "cp_probe_schema"],
    // A port control only means something when the DSN names one. Neon's does
    // not, and inventing 5432 would test a string that is not a component of
    // this DSN at all - so it is skipped out loud rather than counted.
    ["the port alone", url.port],
  ];
  for (const [label, leaked] of controls) {
    if (!leaked) {
      console.log(
        `positive control (${label}): SKIPPED - this DSN has no such component`,
      );
      continue;
    }
    const planted = surfaces(new Error(`connection failed: ${leaked}`));
    const found = components(withOptions).some(([, value]) =>
      planted.some((s) => s.includes(value)),
    );
    console.log(`positive control (${label}) caught: ${found}`);
    if (!found) failures++;

    const cleaned = surfaces(
      redactConnectionDetails(
        new Error(`connection failed: ${leaked}`),
        withOptions,
      ),
    );
    const hits = components(withOptions).filter(([, value]) =>
      cleaned.some((s) => s.includes(value)),
    );
    console.log(
      `  after redaction, no component: ${hits.length === 0}` +
        (hits.length === 0
          ? ""
          : ` (leaked: ${hits.map(([n]) => n).join(", ")})`),
    );
    if (hits.length > 0) failures++;
  }

  // THE SHORT-COMPONENT CASE, which the >=4 filter used to skip. A real DSN
  // here has long credentials, so the property is exercised on a synthetic one:
  // a one-character role, a two-character database and an explicit port must
  // all be treated as components.
  const tiny = "postgres://a:b@h.example.com:1/cd?sslmode=require";
  for (const [label, leaked] of [
    ["a one-character role", "a"],
    ["a one-character password", "b"],
    ["a two-character database", "cd"],
    ["a one-character port", "1"],
  ] as [string, string][]) {
    const cleaned = surfaces(
      redactConnectionDetails(new Error(`failed near ${leaked}`), tiny),
    );
    const clean = !cleaned.some((s) => s.includes(`failed near ${leaked}`));
    console.log(`short component (${label}) never reaches output: ${clean}`);
    if (!clean) failures++;
  }

  console.log(`failures: ${failures}`);
  if (failures > 0) process.exit(1);
}

await main();

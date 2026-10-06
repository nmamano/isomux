#!/usr/bin/env bun
// Did a database copy arrive whole? One fingerprint per side, then a compare.
//
//   bun control-plane/restore-check.ts fingerprint > side.json
//   bun control-plane/restore-check.ts compare source.json target.json
//
// `fingerprint` reads the database named by CONTROL_PLANE_DB (the owner's
// string: it must read every table) in a READ ONLY transaction and prints, per
// table of the current schema: the columns by name, type, nullability and
// default IN ORDER, the row count and a content hash; per sequence its state;
// and the constraint and index definitions. Raw `attnum` is never compared: a
// restore drops the gaps that dropped columns leave, so the same table can
// arrive with different numbers and the same columns.
//
// The `database_identity` row in schema_meta is left out of the hash: a target
// gets its own identity after the restore (see `set-database-identity`), and a
// check that failed on that would fail on every correct move.
//
// The output carries counts, hashes and definitions only - no row data and no
// connection detail. `compare` names what differs and exits non-zero.

import * as fs from "node:fs";
import pg from "pg";
import { DATABASE_IDENTITY_KEY } from "./boot.ts";
import { databaseUrl } from "./config.ts";
import { redactConnectionDetails } from "./store.ts";

export interface TableFingerprint {
  columns: string[];
  rows: number;
  hash: string;
}

export interface Fingerprint {
  tables: Record<string, TableFingerprint>;
  sequences: Record<string, string>;
  constraints: string[];
  indexes: string[];
}

/** Settings that make a row's text form the same on both sides. */
const STABLE_TEXT = [
  "set local timezone to 'UTC'",
  "set local datestyle to 'ISO, YMD'",
  "set local intervalstyle to 'postgres'",
  "set local extra_float_digits to 1",
  "set local bytea_output to 'hex'",
  // The owner's role bound is 30s; hashing the largest table may need longer.
  "set local statement_timeout to '10min'",
];

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export async function fingerprint(dsn: string): Promise<Fingerprint> {
  const client = new pg.Client({
    connectionString: dsn,
    connectionTimeoutMillis: 30_000,
  });
  try {
    await client.connect();
    await client.query(
      "begin transaction isolation level repeatable read read only",
    );
    for (const statement of STABLE_TEXT) await client.query(statement);

    const tables = await client.query<{ name: string }>(
      "select c.relname as name from pg_class c " +
        "where c.relnamespace = current_schema()::text::regnamespace " +
        "and c.relkind in ('r', 'p') order by 1",
    );
    const out: Fingerprint = {
      tables: {},
      sequences: {},
      constraints: [],
      indexes: [],
    };
    for (const { name } of tables.rows) {
      const columns = await client.query<{ col: string }>(
        "select a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || " +
          "case when a.attnotnull then ' not null' else '' end || " +
          "coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '') as col " +
          "from pg_attribute a left join pg_attrdef d " +
          "on d.adrelid = a.attrelid and d.adnum = a.attnum " +
          "where a.attrelid = $1::regclass and a.attnum > 0 " +
          "and not a.attisdropped order by a.attnum",
        [quoteIdentifier(name)],
      );
      const filter =
        name === "schema_meta"
          ? `where t.key <> '${DATABASE_IDENTITY_KEY}'`
          : "";
      const content = await client.query<{ rows: string; hash: string }>(
        `select count(*)::text as rows, encode(sha256(convert_to(coalesce(` +
          `string_agg(md5(t::text), '' order by md5(t::text)), ''), 'UTF8')), 'hex') as hash ` +
          `from ${quoteIdentifier(name)} t ${filter}`,
      );
      out.tables[name] = {
        columns: columns.rows.map((r) => r.col),
        rows: Number(content.rows[0].rows),
        hash: content.rows[0].hash,
      };
    }
    const sequences = await client.query<{ name: string; state: string }>(
      "select sequencename as name, " +
        "coalesce(last_value::text, 'unset') || ' ' || increment_by || ' ' || " +
        "min_value || ' ' || max_value || ' ' || cycle as state " +
        "from pg_sequences where schemaname = current_schema() order by 1",
    );
    for (const row of sequences.rows) out.sequences[row.name] = row.state;
    const constraints = await client.query<{ def: string }>(
      "select cl.relname || ' ' || c.conname || ' ' || pg_get_constraintdef(c.oid) as def " +
        "from pg_constraint c join pg_class cl on cl.oid = c.conrelid " +
        "where c.connamespace = current_schema()::text::regnamespace order by 1",
    );
    out.constraints = constraints.rows.map((r) => r.def);
    // The engine always qualifies the table in an index definition; the schema
    // name is where a copy lives, not what it is.
    const indexes = await client.query<{ def: string }>(
      "select replace(pg_get_indexdef(i.indexrelid), " +
        "' ON ' || quote_ident(current_schema()) || '.', ' ON ') as def from pg_index i " +
        "join pg_class c on c.oid = i.indexrelid " +
        "where c.relnamespace = current_schema()::text::regnamespace order by 1",
    );
    out.indexes = indexes.rows.map((r) => r.def);
    await client.query("rollback");
    return out;
  } catch (err) {
    throw redactConnectionDetails(err, dsn);
  } finally {
    await client.end().catch(() => {});
  }
}

/** What differs between two fingerprints, by name. Empty means the same. */
export function compareFingerprints(
  source: Fingerprint,
  target: Fingerprint,
): string[] {
  const out: string[] = [];
  const names = new Set([
    ...Object.keys(source.tables),
    ...Object.keys(target.tables),
  ]);
  for (const name of [...names].sort()) {
    const a = source.tables[name];
    const b = target.tables[name];
    if (!a || !b) {
      out.push(`table ${name}: only on the ${a ? "source" : "target"}`);
      continue;
    }
    if (a.columns.join("\n") !== b.columns.join("\n"))
      out.push(`table ${name}: columns differ`);
    if (a.rows !== b.rows) out.push(`table ${name}: row count differs`);
    else if (a.hash !== b.hash) out.push(`table ${name}: content differs`);
  }
  const sequences = new Set([
    ...Object.keys(source.sequences),
    ...Object.keys(target.sequences),
  ]);
  for (const name of [...sequences].sort()) {
    if (source.sequences[name] !== target.sequences[name])
      out.push(`sequence ${name}: differs`);
  }
  if (source.constraints.join("\n") !== target.constraints.join("\n"))
    out.push("constraints differ");
  if (source.indexes.join("\n") !== target.indexes.join("\n"))
    out.push("indexes differ");
  return out;
}

async function main(): Promise<void> {
  const [mode, ...files] = process.argv.slice(2);
  if (mode === "fingerprint" && files.length === 0) {
    console.log(JSON.stringify(await fingerprint(databaseUrl()), null, 1));
    return;
  }
  if (mode === "compare" && files.length === 2) {
    const [source, target] = files.map(
      (file) => JSON.parse(fs.readFileSync(file, "utf8")) as Fingerprint,
    );
    const differences = compareFingerprints(source, target);
    for (const line of differences) console.log(line);
    console.log(
      differences.length === 0
        ? `same: ${Object.keys(source.tables).length} tables`
        : `${differences.length} differences`,
    );
    if (differences.length > 0) process.exit(1);
    return;
  }
  console.error(
    "usage: restore-check.ts fingerprint | restore-check.ts compare <source.json> <target.json>",
  );
  process.exit(2);
}

if (import.meta.main) await main();

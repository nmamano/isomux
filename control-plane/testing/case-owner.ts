// A scratch database for one role-governance case, owned by a role of its own.
//
// Governing writes the owner's bounds onto the role cluster-wide, and the
// owner is the connection's own user. Every process on the local engine
// connects as the LOCAL_DATABASE_URL user, so a case that governed that user
// collided with every other process doing the same (measured 2026-10-03:
// SQLSTATE XX000 and refusals caused by another case's `reset all`). A case
// that connects as an owner of its own needs no cross-process lock.
//
// SUPERUSER, like the shared user it replaces, so each case keeps its
// semantics: a superuser's grants are recorded with the bootstrap superuser as
// grantor, which leaves no membership edge to block the owner's drop. The
// non-superuser owner is a case of its own in governance-converge.test.ts.
//
// The caller drops the owner LAST, after the database and the runtime roles.

import type pg from "pg";
import { LOCAL_DATABASE_URL } from "./pg.ts";

export interface OwnedDatabase {
  name: string;
  owner: string;
  dsn: string;
}

const randomName = (): string => Math.random().toString(36).slice(2, 10);

export async function ownedScratchDatabase(
  admin: pg.Pool,
  prefix: string,
): Promise<OwnedDatabase> {
  const name = `${prefix}_${randomName()}`;
  const owner = `cp_ow_${process.pid}_${randomName()}`;
  const password = crypto.randomUUID().replace(/-/g, "");
  await admin.query(
    `create role ${owner} login superuser password '${password}'`,
  );
  try {
    await admin.query(`create database ${name} owner ${owner}`);
  } catch (error) {
    await admin.query(`drop role if exists ${owner}`).catch(() => {});
    throw error;
  }
  const url = new URL(LOCAL_DATABASE_URL);
  url.pathname = `/${name}`;
  url.username = owner;
  url.password = password;
  return { name, owner, dsn: url.toString() };
}

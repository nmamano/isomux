// The Neon side of the control plane's database: which branch a command is
// allowed to touch, and how a connection string for it is BUILT.
//
// The library half, with no side effects at import - `neon.ts` is the CLI over
// it, and `testing/target.ts` uses it to refuse a suite run against the wrong
// branch. Loop-scoped, in the same class as cancel-asset-probe.ts: the guard
// rails are here, executable, rather than in a paragraph somebody has to
// remember.
//
//   - any project but `isomux-control-plane` is refused. The API key is
//     ACCOUNT-WIDE and the same key can see two wallgame projects, so matching
//     the name is not a courtesy;
//   - a connection string is never read whole. The direct endpoint HOST comes
//     from the API's endpoint record, the credentials come from the env DSN,
//     and the two are combined in this process and nowhere else (manager
//     ruling, 2026-08-11). No secret file is written, and no secret is printed,
//     echoed, or passed as an argument;
//   - everything a caller may print is a BOOLEAN or a count. No host, role,
//     endpoint id, database name, branch id or DSN is returned in any error
//     message, error paths included.

import pg from "pg";
import * as os from "node:os";
import * as path from "node:path";

/** The only project this rig may ever touch. */
export const PROJECT_NAME = "isomux-control-plane";
/** The branch the suites and the e2e transcripts run against. */
export const SUITES_BRANCH = "suites";
/** The branch that carries real customer rows. Schema only, ever. */
export const PRODUCTION_BRANCH = "production";

const API = "https://console.neon.tech/api/v2";
const SECRETS = path.join(os.homedir(), "nil", "secrets");
const TOKEN_FILE = path.join(SECRETS, "neon.token");
const ENV_FILE = path.join(SECRETS, "control-plane-neon.env");

/**
 * The API key, read INSIDE this process.
 *
 * Never sourced by a shell and never passed as an argument: an argument is
 * visible in the process table, and a sourced file is visible in a shell's
 * history and in whatever that shell logs.
 */
async function token(): Promise<string> {
  const raw = await Bun.file(TOKEN_FILE).text();
  const value = raw
    .trim()
    .replace(/^[A-Z_]+=/, "")
    .replace(/^['"]|['"]$/g, "");
  if (!value) throw new Error("the Neon API key file is empty");
  return value;
}

type Json = Record<string, unknown>;

async function api(route: string, init?: RequestInit): Promise<Json> {
  const res = await fetch(`${API}${route}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await token()}`,
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    // The STATUS only. A Neon error body quotes back what was asked for, which
    // on some routes is a host or a role.
    throw new Error(
      `the Neon API answered ${res.status} to a ${init?.method ?? "GET"}`,
    );
  }
  return (await res.json()) as Json;
}

/** The project, matched by exact name, and refused if it is not unique. */
export async function project(): Promise<{ id: string }> {
  const { projects } = await api("/projects");
  const matches = (projects as Json[]).filter((p) => p.name === PROJECT_NAME);
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one project named ${PROJECT_NAME}; the account shows ` +
        `${matches.length}`,
    );
  }
  const id = matches[0].id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("the project carries no id");
  }
  return { id };
}

export type Branch = {
  id: string;
  name: string;
  isDefault: boolean;
  hasParent: boolean;
};

function asBranch(row: Json): Branch {
  return {
    id: String(row.id),
    name: String(row.name),
    // Neon has moved this field once already; read both and treat either as the
    // claim, because getting "is this production" wrong is the whole risk.
    isDefault: Boolean(row.default ?? row.primary),
    hasParent: typeof row.parent_id === "string" && row.parent_id.length > 0,
  };
}

export async function branches(projectId: string): Promise<Branch[]> {
  const { branches } = await api(`/projects/${projectId}/branches`);
  return (branches as Json[]).map(asBranch);
}

export async function branchNamed(
  projectId: string,
  name: string,
): Promise<Branch> {
  const matches = (await branches(projectId)).filter((b) => b.name === name);
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one branch named ${name}; the project shows ` +
        `${matches.length}`,
    );
  }
  return matches[0];
}

export async function createBranch(
  projectId: string,
  name: string,
  parent: Branch,
): Promise<void> {
  await api(`/projects/${projectId}/branches`, {
    method: "POST",
    body: JSON.stringify({
      branch: { name, parent_id: parent.id },
      endpoints: [{ type: "read_write" }],
    }),
  });
}

export async function deleteBranch(
  projectId: string,
  branch: Branch,
): Promise<void> {
  await api(`/projects/${projectId}/branches/${branch.id}`, {
    method: "DELETE",
  });
}

/**
 * The DIRECT endpoint host for a branch, from the API's own record.
 *
 * Not by removing "-pooler" from a string: the API is the authority on which
 * host belongs to which branch, and a string transform is a guess that happens
 * to be right. The fallback in `targetFor` exists because the manager allowed
 * one, and it is gated on a live connection proof.
 */
async function directHost(
  projectId: string,
  branchId: string,
): Promise<string | null> {
  const { endpoints } = await api(`/projects/${projectId}/endpoints`);
  const mine = (endpoints as Json[]).filter(
    (e) => e.branch_id === branchId && e.type === "read_write",
  );
  if (mine.length !== 1) return null;
  const host = mine[0].host;
  if (typeof host !== "string" || host.length === 0) return null;
  if (host.includes("-pooler")) {
    // The pooled endpoint drops the startup parameters this build's bounds
    // travel in, so it is not a target this rig may hand to anything.
    throw new Error(
      "the API returned a pooled host for the read_write endpoint",
    );
  }
  return host;
}

/**
 * The role, the password and the database name, from the env DSN.
 *
 * ONLY those three. The env file's HOST is deliberately not used: that file
 * currently carries the pooled endpoint, only Nil edits it, and the authority
 * on the host is the API (manager ruling, 2026-08-11).
 */
async function credentials(): Promise<{
  username: string;
  password: string;
  database: string;
  envHost: string;
}> {
  const raw = await Bun.file(ENV_FILE).text();
  const match = raw.match(/CONTROL_PLANE_DB=['"]?([^'"\n]+)['"]?/);
  if (!match) throw new Error("the env file carries no CONTROL_PLANE_DB");
  let url: URL;
  try {
    url = new URL(match[1]);
  } catch {
    throw new Error("the env file's CONTROL_PLANE_DB is not a URL");
  }
  if (!url.username || !url.password) {
    throw new Error("the env file's CONTROL_PLANE_DB carries no credentials");
  }
  const database = url.pathname.replace(/^\//, "");
  if (!database)
    throw new Error("the env file's CONTROL_PLANE_DB names no database");
  return {
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    envHost: url.hostname,
  };
}

export type Target = {
  /** Never printed, never written, never passed as an argument. */
  dsn: string;
  branch: Branch;
  projectId: string;
  /** False only on the fallback path, which carries a live connection proof. */
  hostFromApi: boolean;
};

/**
 * Build the connection string for a branch, in memory.
 *
 * `sslmode=verify-full` is set explicitly rather than left at the env file's
 * `require`: pg 8.23 currently treats `require` as `verify-full` and warns that
 * a future major will stop doing so, and a silent downgrade of certificate
 * verification is not something a deployment should inherit from a default.
 */
export async function targetFor(branchName: string): Promise<Target> {
  const { id: projectId } = await project();
  const branch = await branchNamed(projectId, branchName);
  const creds = await credentials();
  const apiHost = await directHost(projectId, branch.id);

  const build = (host: string): string => {
    let url: URL;
    try {
      url = new URL(`postgresql://${host}/${creds.database}`);
    } catch {
      // Node's URL error carries the offending string on an `input` property,
      // which a stringified error prints - and that string is the host and the
      // database name. Same class as the two in testing/pg.ts.
      throw new Error("the endpoint host and database name do not form a URL");
    }
    url.username = encodeURIComponent(creds.username);
    url.password = encodeURIComponent(creds.password);
    url.searchParams.set("sslmode", "verify-full");
    return url.toString();
  };

  if (apiHost) {
    return { dsn: build(apiHost), branch, projectId, hostFromApi: true };
  }

  // FALLBACK, allowed by the manager only with a live connection proof: the
  // label is stripped, and the resulting host must prove it is this branch
  // before the DSN may be used for anything.
  const stripped = creds.envHost.replace("-pooler", "");
  if (stripped === creds.envHost) {
    throw new Error(
      "the API returned no endpoint host and the env host is not a pooled one",
    );
  }
  const dsn = build(stripped);
  if ((await liveBranchId(dsn)) !== branch.id) {
    throw new Error(
      "the fallback host did not prove it is the requested branch: the live " +
        "branch id and the API's branch id are not equal",
    );
  }
  return { dsn, branch, projectId, hostFromApi: false };
}

/**
 * What the ENGINE says about which branch answered.
 *
 * The session's own answer, not the DSN's claim: a connection string can name
 * any host, and the only thing that knows which branch is serving is the branch
 * that is serving. Measured 2026-08-11 on a real child connection - the setting
 * is present and equals the id the API reports for that branch.
 */
export async function liveBranchId(dsn: string): Promise<string | null> {
  const pool = new pg.Pool({
    connectionString: dsn,
    connectionTimeoutMillis: 30_000,
  });
  pool.on("error", () => {});
  try {
    const answer = await pool.query<{ v: string | null }>(
      "select current_setting('neon.branch_id', true) as v",
    );
    const value = answer.rows[0]?.v ?? null;
    return value && value.length > 0 ? value : null;
  } catch {
    // Deliberately swallowed: a driver error carries the host and the role, and
    // this function's contract is a branch id or nothing.
    return null;
  } finally {
    await pool.end().catch(() => {});
  }
}

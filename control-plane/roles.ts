// Who may connect, how many of them at once, and what each one may touch.
//
// The control plane's connection ceiling used to be a client-side promise: the
// web app capped its own pool at four and nothing capped the number of pools,
// so the worst case was (however many instances the platform decided to run)
// times four against a hard engine limit, with nothing reserved for the
// provisioner - the component that holds the keys and runs revocations. That
// was recorded as a dated finding with an expiry (R-2026-08-11-1) and this file
// is what closes it.
//
// THE ENFORCEMENT LIVES IN THE ENGINE, in two catalog columns:
//
//   rolconnlimit  bounds the number of backends a role may hold at once. It is
//                 checked when a backend is created, so the aggregate is a
//                 property of the database rather than of anybody's good
//                 behaviour, and one role cannot spend another's budget.
//   rolconfig     carries statement_timeout and idle_in_transaction_session_
//                 timeout, so every new session inherits both without the
//                 connection string having to ask. `Store` reads them back and
//                 refuses to run if either is missing - moving where they come
//                 from does not move who is responsible for proving them.
//
// Measured on the suites branch 2026-08-11, all four on a real Neon engine:
// role-level bounds are reported by a fresh session on the DIRECT endpoint AND
// through the POOLED one (the pooled endpoint refuses the `options` channel the
// bounds used to travel in, which is why they moved); a CONNECTION LIMIT is
// enforced with SQLSTATE 53300 and leaves other roles connecting normally; and
// under 80 concurrent statements against a role capped at 10, the pooler held
// server backends at exactly 10 and QUEUED the rest - 80 statements served,
// zero failures, 32s of wall clock for 320s of work. Pooled CLIENT sessions are
// not charged against the limit; server backends are.
//
// ROLES ARE CREATED IN SQL, NOT THROUGH THE NEON API. Measured the same day: an
// API-created role arrives as a member of `neon_superuser` - owner-equivalent
// by construction - and our own owner cannot ALTER it at all (42501 on both a
// connection limit and a role SET), so it can carry neither half of the posture.
// A SQL-created role arrives with zero memberships and is ours to govern.

/** The web tier's login role. Serverless, pooled endpoint, internet-facing. */
export const WEB_ROLE = "cp_web";
/** The provisioner's login role. One always-on machine, direct endpoint. */
export const PROVISIONER_ROLE = "cp_provisioner";

/**
 * What each role may hold open at once, as an engine-enforced budget.
 *
 * These are NOT predictions about how many processes will exist. A budget is
 * what the engine will allow whatever the platform does, which is the whole
 * difference between this posture and the client-side one it replaces: no
 * number here has to be right about Vercel's scaling to be true.
 *
 * WEB is generous rather than tight because exceeding it is not an error under
 * the pooled endpoint - it is a queue (measured, above). It is a throughput
 * knob, and raising it is one ALTER ROLE with no deployment.
 *
 * PROVISIONER is sized so a REDEPLOY DEGRADES INSIDE THE BUDGET rather than
 * needing a multiplier that could exceed it: the machine's pool is capped at
 * PROVISIONER_POOL below, so two machines overlapping during a deploy is ten
 * backends, inside twelve, with two to spare. Without that pool cap the
 * provisioner would inherit pg's default of ten and an overlap would need
 * twenty.
 *
 * THERE IS NO OWNER BUDGET, and the reason is a provider limit rather than a
 * choice. The project's owner role cannot be capped: `ALTER ROLE ... CONNECTION
 * LIMIT` against it is refused with 42501 from every identity available to us,
 * including after `set role neon_superuser` (measured 2026-08-11). Locking it
 * out instead - transfer ownership to a capped role, revoke CONNECT - was
 * measured and rejected as UNENTERABLE: no role is a member of the owner, no
 * grant of it carries admin option, and creating that membership is refused
 * 42501, so the transferred state could never be handed back (measured
 * 2026-08-11). Manager ruling R-2026-08-11-3 therefore reclassifies the owner
 * as MANUAL BREAK-GLASS, outside the aggregate: after the deployment rotation
 * its DSN is deployed nowhere, and it is used for migrations, bootstrap and
 * operator tooling only.
 */
export const WEB_BUDGET = 40;
export const PROVISIONER_BUDGET = 12;

/** What one provisioner process may hold, so an overlap fits inside its budget. */
export const PROVISIONER_POOL = { max: 5, idleTimeoutMillis: 10_000 };

/**
 * The ceiling the budgets are measured against, and why it is not 901.
 *
 * `max_connections` reads 901 and `superuser_reserved_connections` reads 7, so
 * 894 is what non-superuser roles can actually occupy - and every role here is
 * non-superuser. Measured on the suites branch 2026-08-11 against a compute
 * that had just COLD-STARTED at the minimum autoscaling size (the API reported
 * the endpoint inactive before the run), so this is the smallest ceiling the
 * configuration can present rather than the value at whatever size happened to
 * be serving. `max_connections` is a postmaster-level setting and cannot move
 * while a compute runs.
 *
 * PROVED FOR THE 0.25-2 CU ENDPOINT CONFIGURATION MEASURED 2026-08-11. The
 * ceiling follows the endpoint's autoscaling maximum, so any change to that
 * configuration invalidates this number and the posture must be re-measured
 * before the change, not after.
 */
export const MEASURED_MAX_CONNECTIONS = 901;
export const MEASURED_SUPERUSER_RESERVED = 7;
export const USABLE_CEILING =
  MEASURED_MAX_CONNECTIONS - MEASURED_SUPERUSER_RESERVED;

/**
 * The worst case for the DEPLOYED AUTOMATED CONSUMERS, which is what this
 * posture is scoped to (R-2026-08-11-3).
 *
 * Each term is a separate role's `rolconnlimit`, so no term can borrow from
 * another and neither tier can spend the other's reserve. What the number does
 * NOT cover is stated rather than implied: the owner role, which no design of
 * ours can cap, and the two provider login roles that already hold CONNECT on
 * this database and are Neon's rather than ours. Every aggregate claim here is
 * a claim about roles WE create - which was true of every option considered,
 * including the one that tried to cap the owner.
 */
export const WORST_CASE_AGGREGATE = WEB_BUDGET + PROVISIONER_BUDGET;

/** What is left unallocated after the two deployed budgets. */
export const UNALLOCATED_RESERVE = USABLE_CEILING - WORST_CASE_AGGREGATE;

/**
 * The two bounds, as role configuration.
 *
 * The values are the store's, and this module does not get to disagree with it:
 * `GOVERNED_SETTINGS` in store.ts is the single statement of what the build
 * guarantees, and the read-back compares against that. What lives here is only
 * the decision to write them onto the ROLE.
 */
export type Bound = readonly [name: string, value: string];

/** A table and the verbs a role may use on it. */
export interface TableGrant {
  table: string;
  verbs: readonly ("select" | "insert" | "update" | "delete")[];
  /** Why, in one line. A grant nobody can justify is a grant to remove. */
  because: string;
}

/**
 * WHAT THE WEB MAY DO, derived from its call graph rather than from a habit.
 *
 * Every entry below was traced from `web/lib/services.server.ts` and the app's
 * route handlers through the modules they reach, to the store method or raw
 * statement that names the table. The absences are the interesting part and are
 * listed at the bottom of this comment, because an absence is what a privilege
 * boundary actually is.
 *
 * NOT GRANTED to the web, and each one is a property rather than an oversight:
 *   create_intents  - the latch that stops us buying a box twice. Only the
 *                     provisioner writes it; the internet-facing tier cannot
 *                     read or touch it.
 *   stripe_events   - the billing event journal. Its only writer is the
 *                     reconciler, which runs operator-side today.
 *   schema_meta     - schema bookkeeping. Nothing at runtime reads it.
 *   operations UPDATE - the web may ASK for work (insert) and read it back. It
 *                     cannot lease, complete, re-drive or flag an operation:
 *                     driving the machine is the provisioner's job, and this is
 *                     that sentence expressed as a grant.
 *   instance_liveness writes, provider_assets UPDATE, attention_reasons INSERT
 *                   - all provisioner verbs. The web reads them to render.
 *   DELETE, anywhere - nothing in this build deletes a row. Confirmed by
 *                     search: there is no `delete from` in product code.
 */
export const WEB_GRANTS: readonly TableGrant[] = [
  {
    table: "accounts",
    verbs: ["select", "insert", "update"],
    because:
      "sign-in binds a Google subject to an account and creates one on first arrival",
  },
  {
    table: "name_reservations",
    verbs: ["select", "insert"],
    because: "signup reserves the office name before it reaches Stripe",
  },
  {
    table: "instances",
    verbs: ["select", "insert", "update"],
    because:
      "signup creates the instance row; acknowledging attention refreshes its summary",
  },
  {
    table: "provider_assets",
    verbs: ["select", "insert"],
    because: "signup creates the asset row; progress and requests read it",
  },
  {
    table: "operations",
    verbs: ["select", "insert"],
    because:
      "the three customer verbs enqueue work and the pages read its progress",
  },
  {
    table: "attention_reasons",
    verbs: ["select", "update"],
    because:
      "the ops floor lists open reasons and records that a human saw them",
  },
  {
    table: "audit_events",
    verbs: ["select", "insert"],
    because:
      "every customer verb appends an audit row; the ops floor reads them",
  },
  {
    table: "instance_liveness",
    verbs: ["select"],
    because: "the progress projection reports whether the box is answering",
  },
  {
    table: "sequences",
    verbs: ["select", "update"],
    because:
      "the audit sequence is bumped per event, and runtime open asserts its row exists",
  },
  {
    table: "subscriptions",
    verbs: ["select"],
    because:
      "progress and the cancel pages read subscription state; webhooks are its only writer",
  },
];

/**
 * WHAT THE PROVISIONER MAY DO.
 *
 * Traced the same way from the modules the deployed machine's one command
 * reaches: the tick loop, the liveness watch, the mint seam, the boot proof and
 * the handlers those drive.
 *
 * TWO VERBS ARE DELIBERATELY WITHHELD even though a shared module could be read
 * as needing them, and the live boot is their test rather than a guess here:
 *   instances INSERT       - instance rows are created at signup, by the web.
 *   name_reservations      - reservations belong to the signup path.
 * If the deployed tick loop turns out to need either, that is a measured
 * finding and the grant is added with the evidence attached - which is a better
 * outcome than granting them now because a static scan could not rule them out.
 *
 * Also not granted: stripe_events (the reconciler is operator-side),
 * schema_meta, and DELETE anywhere.
 */
export const PROVISIONER_GRANTS: readonly TableGrant[] = [
  {
    table: "instances",
    verbs: ["select", "update"],
    because: "the tick drives an instance's service state and goal forward",
  },
  {
    table: "provider_assets",
    verbs: ["select", "insert", "update"],
    because:
      "the create coordinator records the asset and reconciles it against the provider",
  },
  {
    table: "operations",
    verbs: ["select", "insert", "update"],
    because:
      "leasing, completing, re-driving and enqueueing follow-on work is the loop itself",
  },
  {
    table: "create_intents",
    verbs: ["select", "insert", "update"],
    because: "the latch that stops a second box being bought for one intent",
  },
  {
    table: "instance_liveness",
    verbs: ["select", "insert", "update"],
    because: "the liveness watch claims a box, checks it and records the rung",
  },
  {
    table: "attention_reasons",
    verbs: ["select", "insert", "update"],
    because:
      "the loop raises and clears the reasons a human is asked to look at",
  },
  {
    table: "audit_events",
    verbs: ["insert"],
    because: "every operation the loop takes is appended to the audit log",
  },
  {
    table: "accounts",
    verbs: ["select"],
    because: "access decisions read the account that owns the instance",
  },
  {
    table: "subscriptions",
    verbs: ["select"],
    because:
      "the lifecycle tick reads subscription state to decide suspension and expiry",
  },
  {
    table: "sequences",
    verbs: ["select", "update"],
    because:
      "the audit sequence is bumped per event, and runtime open asserts its row exists",
  },
];

export interface RolePosture {
  role: string;
  budget: number;
  grants: readonly TableGrant[];
}

export function runtimeRoles(): RolePosture[] {
  return [
    { role: WEB_ROLE, budget: WEB_BUDGET, grants: WEB_GRANTS },
    {
      role: PROVISIONER_ROLE,
      budget: PROVISIONER_BUDGET,
      grants: PROVISIONER_GRANTS,
    },
  ];
}

/** Role and table names are literals in this file, and this is the check that
 * keeps it true: nothing built from input ever reaches a statement. */
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

export function assertIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(
      "a role or table name in the governance statements is not a plain " +
        "lower-case identifier, which is the only shape this module builds",
    );
  }
  return name;
}

/** A setting value this module will write into a statement: a plain interval as
 * Postgres renders one, and nothing else. */
const SETTING_VALUE = /^[0-9]+(us|ms|s|min|h|d)?$/;

/**
 * PHASE ONE: the roles themselves, and what every session of them inherits.
 *
 * SEPARATE FROM THE GRANTS, and the reason is an ordering a fresh database
 * forces: a grant names a TABLE, and on an empty database there are no tables
 * to name. So role creation and role configuration - which depend on nothing -
 * run first, the schema is built by the owner, and the matrix is applied to the
 * tables that now exist. Against a database that already has its schema both
 * phases run together, in one transaction.
 *
 * A PASSWORD IS NOT SET HERE, and the roles are created NOLOGIN. A credential is
 * generated by the deploy step that also writes it to the provider, in one
 * process, so no password is ever produced by a program with nowhere to put it -
 * and a half-applied posture leaves a role that cannot connect rather than one
 * that can connect ungoverned.
 *
 * THE ROLE CONFIGURATION CONVERGES rather than accumulating. `ALTER ROLE ... SET`
 * replaces the setting it names and leaves every other entry standing, so a
 * rerun after a matrix change would leave a stale entry behind - and
 * `Store.openRuntime` would then refuse the very role this program had just
 * declared governed, because it requires EXACTLY the governed pair. `RESET ALL`
 * first makes the destination the whole of the answer. That is safe for these
 * two roles because this build owns them outright; it is NOT done to the owner,
 * whose configuration may carry things we did not put there (see
 * `ownerConfigIsAcceptable`).
 */
export function rolePostureStatements(args: {
  ownerRole: string;
  bounds: readonly Bound[];
}): string[] {
  const owner = assertIdentifier(args.ownerRole);
  const out: string[] = [];

  const setBounds = (role: string): void => {
    for (const [name, value] of args.bounds) {
      if (!SETTING_VALUE.test(value)) {
        throw new Error(
          "a governed bound's value is not a plain interval, and this module " +
            "writes nothing it cannot recognise into a statement",
        );
      }
      out.push(`alter role ${role} set ${assertIdentifier(name)} = '${value}'`);
    }
  };

  for (const { role, budget } of runtimeRoles()) {
    const named = assertIdentifier(role);
    out.push(
      `do $$ begin if not exists (select 1 from pg_roles where rolname = ` +
        `'${named}') then create role ${named} nologin; end if; end $$`,
    );
    // Converge: the pair below becomes the WHOLE of this role's configuration.
    out.push(`alter role ${named} reset all`);
    setBounds(named);
    if (!Number.isInteger(budget) || budget < 1) {
      throw new Error("a connection budget must be a positive whole number");
    }
    out.push(`alter role ${named} connection limit ${budget}`);
  }

  // THE OWNER GETS BOUNDS AND NO CAP, AND NO `RESET ALL`. Not an omission: the
  // statement that would cap it is refused by the provider (42501, measured
  // 2026-08-11), and erasing its configuration wholesale could remove something
  // the provider or an operator put there. Its acceptable starting states are
  // checked before this runs.
  setBounds(owner);
  return out;
}

/**
 * PHASE TWO: the exact table matrix, applied CONVERGENTLY.
 *
 * `GRANT` only ever adds, so a rerun after a verb is removed from the matrix
 * would leave the wider privilege standing in the catalog while the tests in
 * this repo went on asserting it was absent - a boundary that exists in prose
 * and not in the database. So each role's privileges are REVOKED first and then
 * granted exactly, which makes the matrix a destination rather than a floor.
 *
 * The revoke is scoped to the two roles this build owns: nothing here touches
 * the owner's privileges or anyone else's.
 */
export function grantMatrixStatements(): string[] {
  const out: string[] = [];
  for (const { role, grants } of runtimeRoles()) {
    const named = assertIdentifier(role);
    out.push(
      `revoke all privileges on all tables in schema public from ${named}`,
    );
    out.push(
      `revoke all privileges on all sequences in schema public from ${named}`,
    );
    out.push(`revoke all privileges on schema public from ${named}`);
    out.push(`grant usage on schema public to ${named}`);
    for (const grant of grants) {
      out.push(
        `grant ${grant.verbs.join(", ")} on ${assertIdentifier(grant.table)} to ${named}`,
      );
    }
  }
  return out;
}

/**
 * THE EXACT REVERSE of the two phases, for a posture no deployment is using yet.
 *
 * `connection limit -1` plus a `reset` of the bounds is a rollback of the
 * NUMBERS and leaves the roles and their grants standing, which is the right
 * lever once a deployment authenticates as them - dropping a role a running
 * machine is connecting as would be an outage, not a rollback. Before that
 * point the reverse can be exact, and this is it: revoke first, then drop.
 *
 * ORDER IS THE WHOLE THING. `DROP ROLE` answers 2BP01 while any grant still
 * hangs off the role (measured 2026-08-11, on a live branch), and `DROP OWNED
 * BY` needs a membership the owner does not have (42501, same run). So the
 * privileges come off explicitly, one statement per object class, and only then
 * does the role go.
 *
 * The owner's two bounds are reset, which returns it to the state this build
 * found it in: `ownerConfigIsAcceptable` refuses to govern an owner carrying
 * anything else, so "empty, or exactly our pair" is the only thing that can
 * have preceded us.
 */
export function ungovernStatements(args: {
  ownerRole: string;
  bounds: readonly Bound[];
}): string[] {
  const out: string[] = [];
  for (const { role } of runtimeRoles()) {
    const named = assertIdentifier(role);
    out.push(
      `revoke all privileges on all tables in schema public from ${named}`,
    );
    out.push(
      `revoke all privileges on all sequences in schema public from ${named}`,
    );
    out.push(`revoke all privileges on schema public from ${named}`);
    out.push(`alter role ${named} connection limit -1`);
    out.push(`alter role ${named} reset all`);
    out.push(`drop role if exists ${named}`);
  }
  for (const [name] of args.bounds) {
    out.push(
      `alter role ${assertIdentifier(args.ownerRole)} reset ${assertIdentifier(name)}`,
    );
  }
  return out;
}

/**
 * Both phases, for a database that already has its schema.
 *
 * The order still matters - a role must exist before it can be granted
 * anything - and against an existing schema there is nothing between them, so
 * the caller runs the whole list in ONE transaction.
 */
export function governanceStatements(args: {
  ownerRole: string;
  bounds: readonly Bound[];
}): string[] {
  return [...rolePostureStatements(args), ...grantMatrixStatements()];
}

/**
 * May this program touch the owner's role configuration?
 *
 * The owner is not ours the way the two runtime roles are: its configuration
 * can carry provider or operator defaults, and converging it to our pair would
 * erase them silently. So the acceptable starting states are enumerated - it
 * carries nothing, or it already carries exactly what we would set - and
 * anything else REFUSES BEFORE ANY MUTATION rather than being overwritten.
 */
export function ownerConfigIsAcceptable(
  config: readonly string[],
  bounds: readonly Bound[],
): boolean {
  if (config.length === 0) return true;
  return boundsAreExact(config, bounds);
}

/** What the catalog says about one role, as small integers and booleans. */
export interface RoleFacts {
  present: boolean;
  connectionLimit: number;
  boundsExact: boolean;
  canLogin: boolean;
  memberships: number;
  writeGrants: number;
}

/** The one query behind `roleFacts`, kept here so the posture instrument and
 * the tests read the catalog the same way. */
export function roleFactsSql(): string {
  return (
    "select r.rolname as role, r.rolconnlimit as connection_limit, " +
    "r.rolcanlogin as can_login, coalesce(r.rolconfig, '{}') as config, " +
    "(select count(*) from pg_auth_members m where m.member = r.oid) as memberships, " +
    "(select count(*) from information_schema.table_privileges p " +
    " where p.grantee = r.rolname and p.privilege_type in " +
    " ('INSERT', 'UPDATE', 'DELETE')) as write_grants " +
    "from pg_roles r where r.rolname = any($1)"
  );
}

/** Do a role's `rolconfig` entries carry EXACTLY the governed bounds? */
export function boundsAreExact(
  config: readonly string[],
  bounds: readonly Bound[],
): boolean {
  const want = new Set(bounds.map(([name, value]) => `${name}=${value}`));
  const have = new Set(config);
  if (want.size !== have.size) return false;
  for (const entry of want) if (!have.has(entry)) return false;
  return true;
}

/**
 * Read the posture back out of the catalog.
 *
 * The instrument half, and it is deliberately separate from the statements that
 * put the posture there: a program that reports what it just asked for is
 * reporting its own intent. Everything returned is a boolean or a small
 * integer - no role is named back, because a role name is the username half of
 * a connection string.
 */
export async function readRolePosture(
  query: (sql: string, args: unknown[]) => Promise<Record<string, unknown>[]>,
  bounds: readonly Bound[],
  ownerRole: string,
): Promise<Map<string, RoleFacts>> {
  const wanted = [WEB_ROLE, PROVISIONER_ROLE, ownerRole];
  const rows = (await query(roleFactsSql(), [wanted])) as {
    role: string;
    connection_limit: number;
    can_login: boolean;
    config: string[] | null;
    memberships: string;
    write_grants: string;
  }[];
  const out = new Map<string, RoleFacts>();
  for (const role of wanted) {
    const row = rows.find((r) => r.role === role);
    out.set(role, {
      present: row !== undefined,
      connectionLimit: row?.connection_limit ?? 0,
      boundsExact: boundsAreExact(row?.config ?? [], bounds),
      canLogin: row?.can_login === true,
      memberships: Number(row?.memberships ?? -1),
      writeGrants: Number(row?.write_grants ?? -1),
    });
  }
  return out;
}

/**
 * What the catalog ACTUALLY grants each role, table by table and verb by verb.
 *
 * The read-back that matters. Counting write grants tells you a number moved;
 * it does not tell you whether the number is the matrix. This compares the two
 * sets and reports what is missing and what is EXCESS - and excess is the
 * interesting direction, because `GRANT` only adds and a matrix that has been
 * narrowed leaves the wider privilege behind unless something revokes it.
 */
export function matrixSql(): string {
  return (
    "select grantee as role, table_name as table, privilege_type as verb " +
    "from information_schema.table_privileges " +
    "where grantee = any($1) and table_schema = 'public'"
  );
}

export interface MatrixVerdict {
  missing: number;
  excess: number;
  exact: boolean;
}

export function judgeMatrix(
  rows: readonly { role: string; table: string; verb: string }[],
  role: string,
  grants: readonly TableGrant[],
): MatrixVerdict {
  const want = new Set<string>();
  for (const grant of grants) {
    for (const verb of grant.verbs)
      want.add(`${grant.table}:${verb.toUpperCase()}`);
  }
  const have = new Set<string>();
  for (const row of rows) {
    if (row.role !== role) continue;
    have.add(`${row.table}:${row.verb.toUpperCase()}`);
  }
  let missing = 0;
  for (const entry of want) if (!have.has(entry)) missing++;
  let excess = 0;
  for (const entry of have) if (!want.has(entry)) excess++;
  return { missing, excess, exact: missing === 0 && excess === 0 };
}

/**
 * EVERY table privilege Postgres can grant, not just the four this build uses.
 *
 * The sweep has to ask about all of them or it is not a boundary check. A
 * PUBLIC `truncate` is a verb the web tier can exercise and the matrix forbids,
 * and a sweep that only asked about the four granted verbs would report `exact`
 * while the role could empty a table. `references` and `trigger` are the same
 * shape, and `maintain` arrived in Postgres 17. Verified accepted by
 * `has_table_privilege` on both engines this build runs against (Postgres 18,
 * measured 2026-08-11); an engine that does not know one of these names makes
 * the sweep throw, which refuses rather than passes.
 *
 * The MATRIX stays the four verbs it grants - so the other four are always
 * excess, which is the point.
 */
export const ALL_VERBS = [
  "select",
  "insert",
  "update",
  "delete",
  "truncate",
  "references",
  "trigger",
  "maintain",
] as const;

/** What a role may effectively do to the SCHEMA, and to any sequence in it. */
export function schemaPrivilegeSql(): string {
  return (
    "select r.role as role, " +
    "has_schema_privilege(r.role, 'public', 'USAGE') as usage, " +
    "has_schema_privilege(r.role, 'public', 'CREATE') as create " +
    "from unnest($1::text[]) as r(role)"
  );
}

/** Sequences are granted to nobody by this build, and the schema has none - so
 * this proves the absence rather than assuming it. */
export function sequencePrivilegeSql(): string {
  return (
    "select count(*)::int as held from unnest($1::text[]) as r(role), " +
    "(select c.oid::regclass::text as name from pg_class c " +
    " join pg_namespace n on n.oid = c.relnamespace " +
    " where n.nspname = 'public' and c.relkind = 'S') as s, " +
    "unnest(array['USAGE', 'SELECT', 'UPDATE']) as v(verb) " +
    "where has_sequence_privilege(r.role, s.name, v.verb)"
  );
}

/**
 * What a role can ACTUALLY do, rather than what was granted to it directly.
 *
 * `information_schema.table_privileges` lists grants whose grantee is the role
 * itself, and a boundary read only through it can be defeated without touching
 * the role at all: a privilege held by PUBLIC is one every role has, and the
 * matrix check would go on reporting `exact` while the web tier could delete
 * rows it may only read. `has_table_privilege` answers the question the
 * boundary is actually about - can this role do this - and it accounts for
 * PUBLIC and for memberships, which is why the sweep is over every table and
 * every verb rather than over the matrix's own entries.
 */
export function effectivePrivilegeSql(): string {
  return (
    "select r.role as role, t.name as table, v.verb as verb, " +
    "has_table_privilege(r.role, t.name, v.verb) as allowed " +
    "from unnest($1::text[]) as r(role), unnest($2::text[]) as t(name), " +
    "unnest($3::text[]) as v(verb)"
  );
}

export interface EffectiveRow {
  role: string;
  table: string;
  verb: string;
  allowed: boolean;
}

/**
 * Compare what a role CAN do against what the matrix says it may.
 *
 * `excess` is the direction that matters: a verb the role can exercise and the
 * matrix does not carry is the boundary being wrong, whatever the grant tables
 * say about who granted it.
 */
export function judgeEffective(
  rows: readonly EffectiveRow[],
  role: string,
  grants: readonly TableGrant[],
): MatrixVerdict {
  const want = new Set<string>();
  for (const grant of grants) {
    for (const verb of grant.verbs) want.add(`${grant.table}:${verb}`);
  }
  let missing = 0;
  let excess = 0;
  for (const row of rows) {
    if (row.role !== role) continue;
    const key = `${row.table}:${row.verb.toLowerCase()}`;
    if (row.allowed && !want.has(key)) excess++;
    if (!row.allowed && want.has(key)) missing++;
  }
  return { missing, excess, exact: missing === 0 && excess === 0 };
}

/** What the catalog says about a role that ALREADY EXISTS under one of our
 * names, before this build takes it over. */
export function roleIdentitySql(): string {
  return (
    "select r.rolname as role, r.rolcanlogin as can_login, " +
    "coalesce(r.rolconfig, '{}') as config, " +
    // BOTH DIRECTIONS. Counting only the roles this one belongs to misses the
    // dangerous half: a role that OTHER roles are members of hands them
    // everything the matrix is about to grant it.
    "(select count(*)::int from pg_auth_members m where m.member = r.oid) as belongs_to, " +
    "(select count(*)::int from pg_auth_members m where m.roleid = r.oid) as members_of_it, " +
    // CLUSTER-WIDE OWNERSHIP. `pg_class` is one database's relations; these
    // names are global, and a role owning a schema, a database, a function or
    // anything in another database is not an inert residue. `pg_shdepend` is
    // the shared catalog that records owner dependencies across the cluster
    // (readable on this provider, measured 2026-08-11).
    "(select count(*)::int from pg_shdepend d where d.refobjid = r.oid " +
    " and d.deptype = 'o') as owns_anything, " +
    "(select count(*)::int from pg_database d where d.datdba = r.oid) as owns_databases, " +
    "(select count(*)::int from pg_namespace n where n.nspowner = r.oid) as owns_schemas, " +
    "(select count(*)::int from pg_class c where c.relowner = r.oid) as owns_relations, " +
    "(select count(*)::int from pg_proc p where p.proowner = r.oid) as owns_routines, " +
    "(select count(*)::int from pg_type t where t.typowner = r.oid) as owns_types, " +
    "(select count(*)::int from pg_stat_activity a where a.usename = r.rolname) as backends " +
    "from pg_roles r where r.rolname = any($1)"
  );
}

export interface RoleIdentity {
  role: string;
  can_login: boolean;
  config: string[] | null;
  belongs_to: number;
  members_of_it: number;
  owns_anything: number;
  owns_databases: number;
  owns_schemas: number;
  owns_relations: number;
  owns_routines: number;
  owns_types: number;
  backends: number;
}

/**
 * May this build take over a role that is already there?
 *
 * ONLY IF IT IS OUR OWN INERT RESIDUE. These are GLOBAL names in a production
 * cluster, and `create if absent` followed by `reset all` and a fresh grant set
 * would silently adopt somebody else's role - including one a different system
 * is authenticating as. So a pre-existing role must look like what a previous
 * run of this program leaves behind and nothing else: it cannot log in, belongs
 * to nothing, owns nothing, and has nobody connected as it. Anything else
 * refuses before the transaction opens.
 */
export function residueIsInert(identity: RoleIdentity): boolean {
  const counts = [
    identity.belongs_to,
    identity.members_of_it,
    identity.owns_anything,
    identity.owns_databases,
    identity.owns_schemas,
    identity.owns_relations,
    identity.owns_routines,
    identity.owns_types,
    identity.backends,
  ];
  // A count this build could not read is not a zero. Anything unreadable
  // arrives as a negative or a NaN and refuses, rather than passing because the
  // question could not be asked.
  if (counts.some((n) => !Number.isInteger(n) || n !== 0)) return false;
  return identity.can_login === false;
}

/**
 * How many runtime roles are EXACTLY governed, from catalog facts.
 *
 * The predicate behind the bootstrap report's evidence line. "Has some limit
 * and some configuration" would count a role carrying the wrong cap and a stale
 * setting, which is precisely the state a report is supposed to distinguish.
 */
export function governedRoleCount(
  posture: ReadonlyMap<string, RoleFacts>,
): number {
  let exact = 0;
  for (const { role, budget } of runtimeRoles()) {
    const facts = posture.get(role);
    if (
      facts?.present === true &&
      facts.connectionLimit === budget &&
      facts.boundsExact
    ) {
      exact++;
    }
  }
  return exact;
}

/** The budget a role is supposed to carry, by name. */
export function budgetFor(role: string, ownerRole: string): number {
  if (role === WEB_ROLE) return WEB_BUDGET;
  if (role === PROVISIONER_ROLE) return PROVISIONER_BUDGET;
  // The owner is break-glass and uncapped: -1 is what the catalog itself
  // reports for "no limit", so the instrument compares against the truth.
  if (role === ownerRole) return -1;
  return -1;
}

/** The label a transcript uses for a role, so no role NAME is ever printed. */
export function labelFor(role: string, ownerRole: string): string {
  if (role === WEB_ROLE) return "web";
  if (role === PROVISIONER_ROLE) return "provisioner";
  if (role === ownerRole) return "owner";
  return "other";
}

/**
 * The verdict a gate exits on.
 *
 * Separated from the command that collects the claims so it can be tested
 * directly: the failure this guards against is a program that PRINTS a false
 * predicate and exits zero, which is a gate that has become a formality. Any
 * false claim is a failure, and the names come back so the transcript says
 * which.
 */
export function failedClaims(
  claims: readonly (readonly [string, boolean])[],
): string[] {
  return claims.filter(([, ok]) => !ok).map(([name]) => name);
}

/** The inequality, as one line a transcript can carry. */
export function postureLine(): string {
  return (
    `deployed_worst_case ${WEB_BUDGET}+${PROVISIONER_BUDGET}=` +
    `${WORST_CASE_AGGREGATE} usable ${USABLE_CEILING} reserve ${UNALLOCATED_RESERVE} ` +
    `owner_uncapped_break_glass true`
  );
}

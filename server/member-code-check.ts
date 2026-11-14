// The code-tree walk of the member checks (server/member-hosts.ts), in its own
// process so it never holds the server's event loop. Reads
// {officeUid, member, codeRoot} as JSON on stdin; writes the failures as a
// JSON list on stdout.
import {
  privateChecks,
  realFs,
  type CheckFailure,
} from "./split/trusted-checks.ts";

const input = JSON.parse(await new Response(Bun.stdin.stream()).text()) as {
  officeUid: number;
  member: { uid: number; gid: number; groups: number[] };
  codeRoot: string;
};
const failures: CheckFailure[] = [];
const { walkPrivate } = privateChecks(
  realFs,
  input.officeUid,
  input.member,
  (check, detail, path) => failures.push({ check, path, detail }),
);
walkPrivate(input.codeRoot, Infinity, new Map());
process.stdout.write(JSON.stringify(failures));

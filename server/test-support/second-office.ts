// A second office on the same host, for server/test-support/two-offices.test.ts.
// Test-support ONLY.
//
// The harness is one office per process (shared STATE_ROOT and module caches),
// so the second office runs as its own process. Run it as
// `ISOMUX_HOME=<temp dir> bun second-office.ts`. It boots an HTTPS-shaped
// office (external access on with an https origin, then a cold restart, like
// startHttps in auth-host-cookie.test.ts), mints a sign-in link for a member,
// prints one JSON line {port, origin, token}, and stops when stdin closes.

import { startTestServer } from "./harness.ts";
import { mintMemberLink } from "./member-link.ts";
import { buildPublicOrigin } from "../auth.ts";

const first = await startTestServer();
const owner = await first.seedOwner("Boss");
const put = await first.http("/api/office/access", {
  method: "PUT",
  rawSessionId: owner.rawSessionId,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    externalAccess: true,
    publicOrigin: "https://second.example",
  }),
});
if (put.status !== 200) throw new Error(`access PUT failed: ${put.status}`);
const server = await first.restart();
const { origin, isHttps } = buildPublicOrigin();
if (!isHttps) throw new Error("expected an https public origin after restart");
const { rawToken } = await mintMemberLink("Ann");
console.log(JSON.stringify({ port: server.port, origin, token: rawToken }));

for await (const _ of Bun.stdin.stream()) {
  // Nothing to read; the parent closes stdin to stop this office.
}
await server.stop();
process.exit(0);

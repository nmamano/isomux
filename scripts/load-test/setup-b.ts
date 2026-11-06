// Tier B setup: spawns Claude agents in an installed office and writes
// <dir>/server.json for gen.ts.
//   bun run setup-b.ts <dir> <agents> <origin>
// <origin> is the office's public origin (https://<domain>, or
// http://localhost:<port> for a local office). Without <dir>/server.json it
// claims the office first, with the link in <dir>/claim-url: the installer's
// owner invite (/i/<token>) or a setup link (/setup#key=...). The link is a
// credential, so it comes from a file; delete the file after the claim. With
// <dir>/server.json it reuses that session and adds the agents in a new room
// (more agents for the memory levels).
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { claimOwner } from "../install-smoke/claim.ts";

const [dir, agents, origin] = process.argv.slice(2);
if (!dir || !agents || !origin)
  throw new Error("usage: bun run setup-b.ts <dir> <agents> <origin>");
const N = Number(agents);
const serverJson = join(dir, "server.json");

type Cfg = {
  port: number;
  origin: string;
  cookie: string;
  sessions: string[];
  agents: string[];
  tokens: string[];
};
let cfg: Cfg;
if (existsSync(serverJson)) {
  cfg = JSON.parse(readFileSync(serverJson, "utf8")) as Cfg;
} else {
  const url = readFileSync(join(dir, "claim-url"), "utf8").trim();
  const cookie = await claimOwner(
    origin,
    origin,
    new URL(url).pathname.startsWith("/i/")
      ? { kind: "invite", url }
      : { kind: "setup-link", name: "Load Owner", url },
  );
  const eq = cookie.indexOf("=");
  const u = new URL(origin);
  cfg = {
    port: Number(u.port || (u.protocol === "https:" ? 443 : 80)),
    origin,
    cookie: cookie.slice(0, eq),
    sessions: [cookie.slice(eq + 1)],
    agents: [],
    tokens: [],
  };
}
const H = {
  Origin: origin,
  Cookie: `${cfg.cookie}=${cfg.sessions[0]}`,
  "Content-Type": "application/json",
};

const made = (await (
  await fetch(`${origin}/api/rooms`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ name: `Load ${cfg.agents.length}` }),
  })
).json()) as { room?: { id: string } };
if (!made.room) throw new Error(`room: ${JSON.stringify(made)}`);
const start = cfg.agents.length;
for (let i = 0; i < N; i++) {
  const res = await fetch(`${origin}/api/agents`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      name: `LT${start + i}`,
      roomId: made.room.id,
      agentType: "claude",
      permissionMode: "bypassPermissions",
    }),
  });
  const j = (await res.json()) as { agent?: { id: string } };
  if (!j.agent)
    throw new Error(`spawn ${i}: ${res.status} ${JSON.stringify(j)}`);
  cfg.agents.push(j.agent.id);
}
writeFileSync(serverJson, JSON.stringify(cfg));
console.log(`agents ${cfg.agents.length}`);

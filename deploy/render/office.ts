import { hasOwner } from "../../server/users.ts";
import { claimOwnership, freezeBootState, setCookieHeader, setPublicOriginFallback } from "../../server/auth.ts";
import { saveServerConfig } from "../../server/persistence.ts";
import { createSetupHandler } from "./bootstrap.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_ROOT } from "../../server/config.ts";
import { atomicWriteFileSync } from "../../server/persistence.ts";

const publicUrl = process.env.ISOMUX_PUBLIC_URL;
if (!publicUrl) throw new Error("Set ISOMUX_PUBLIC_URL to the office's custom HTTPS origin");
const parsed = new URL(publicUrl);
if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash)
  throw new Error("ISOMUX_PUBLIC_URL must be an HTTPS origin");
const origin = parsed.origin;
// The template owns its public binding, and reapplies it after every redeploy.
saveServerConfig({ publicOrigin: origin, externalAccess: true });
const configPath = join(STATE_ROOT, "office-config.json");
const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
atomicWriteFileSync(configPath, JSON.stringify({ ...config, networkBind: "all" }, null, 2));
if (!hasOwner()) {
  const key = process.env.ISOMUX_SETUP_KEY || "";
  let finish!: () => void;
  const completed = new Promise<void>(resolve => { finish = resolve; });
  const handler = createSetupHandler({ origin, key, hasOwner,
    claim: async (name, userAgent) => {
      const result = await claimOwnership(name, { userAgent });
      if (!result.ok) return null;
      setPublicOriginFallback(origin);
      freezeBootState({ externalAccess: true, networkBind: "all" });
      return setCookieHeader(result.rawSessionId, result.absoluteExpiresAt);
    },
    complete: finish,
  });
  const setup = Bun.serve({ hostname: "0.0.0.0", port: Number(process.env.PORT || 10000),
    maxRequestBodySize: 4096, fetch: handler });
  await completed;
  await setup.stop(true);
}
delete process.env.ISOMUX_SETUP_KEY;
const { runOfficeMain } = await import("../../server/isomux-office.ts");
await runOfficeMain();

import { hasOwner } from "../../server/users.ts";
import {
  claimOwnership,
  freezeBootState,
  setCookieHeader,
  setPublicOriginFallback,
} from "../../server/auth.ts";
import { saveServerConfig } from "../../server/persistence.ts";
import { createSetupHandler } from "./bootstrap.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_ROOT } from "../../server/config.ts";
import { atomicWriteFileSync } from "../../server/persistence.ts";
import { classifyRequest } from "../../server/proxy-trust.ts";

const publicUrl = process.env.ISOMUX_PUBLIC_URL;
if (!publicUrl)
  throw new Error("Set ISOMUX_PUBLIC_URL to the office's custom HTTPS origin");
const parsed = new URL(publicUrl);
if (
  parsed.protocol !== "https:" ||
  parsed.username ||
  parsed.password ||
  parsed.pathname !== "/" ||
  parsed.search ||
  parsed.hash
)
  throw new Error("ISOMUX_PUBLIC_URL must be an HTTPS origin");
const origin = parsed.origin;
// The template owns its public binding and its proxy, and reapplies both after
// every redeploy. Every container deployment (AWS Compose, EKS ALB, Render)
// sits behind a load balancer that sends X-Forwarded-For.
saveServerConfig({ publicOrigin: origin, externalAccess: true });
const configPath = join(STATE_ROOT, "office-config.json");
const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<
  string,
  unknown
>;
atomicWriteFileSync(
  configPath,
  JSON.stringify(
    { ...config, networkBind: "all", trustedProxy: "load-balancer" },
    null,
    2,
  ),
);
if (!hasOwner()) {
  const key = process.env.ISOMUX_SETUP_KEY || "";
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const handler = createSetupHandler({
    key,
    hasOwner,
    claim: async (name, userAgent) => {
      const result = await claimOwnership(name, { userAgent });
      if (!result.ok) return result;
      setPublicOriginFallback(origin);
      freezeBootState({ externalAccess: true, networkBind: "all" });
      return {
        ok: true,
        cookie: setCookieHeader(result.rawSessionId, result.absoluteExpiresAt),
      };
    },
    complete: finish,
  });
  const setup = Bun.serve({
    hostname: "0.0.0.0",
    port: Number(process.env.PORT || 10000),
    maxRequestBodySize: 4096,
    fetch: (req, server) =>
      handler(
        req,
        classifyRequest(
          req,
          server.requestIP(req)?.address ?? null,
          "load-balancer",
        ).client,
      ),
  });
  await completed;
  await setup.stop(true);
}
delete process.env.ISOMUX_SETUP_KEY;
const { runOfficeMain } = await import("../../server/isomux-office.ts");
await runOfficeMain();

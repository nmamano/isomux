// The proxy child for tests: the production body (child.ts) with the stub
// seams. Only tests start it, through the supervisor's `entry` option; the
// production entry is server/secret-proxy/main.ts, which passes no seam.
//
// ISOMUX_TEST_PROXY_SEAMS: JSON {standIns?, upstreamRoots?}.

import { runProxyChild } from "../secret-proxy/child.ts";
import type { ProxyOptions } from "../secret-proxy/proxy.ts";

const seams = JSON.parse(
  process.env.ISOMUX_TEST_PROXY_SEAMS ?? "{}",
) as ProxyOptions;
runProxyChild(seams);

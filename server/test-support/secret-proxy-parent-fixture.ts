// A stand-in server process for the supervisor's orphan test: it starts a
// supervisor with the test child, prints {"childPid","port"} once the child
// listens, and waits to be killed.

import { createCertificateAuthority } from "../secret-proxy/x509.ts";
import { createProxySupervisor } from "../secret-proxy/supervisor.ts";
import { join } from "node:path";

const ca = createCertificateAuthority();
const supervisor = createProxySupervisor({
  entry: join(import.meta.dir, "secret-proxy-test-child.ts"),
  snapshot: () => ({
    secrets: [],
    caCertPem: ca.certPem,
    caKeyPem: ca.keyPem,
    rootsPem: "",
    upstreamProxy: null,
  }),
  savedPort: null,
  onPort: () => {},
  onUse: () => {},
  log: () => {},
});
const port = await supervisor.start();
console.log(JSON.stringify({ childPid: supervisor.pid, port }));
setInterval(() => {}, 1000);

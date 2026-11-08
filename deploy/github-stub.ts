// Test support for deploy/install.sh's GitHub downloads (task 6f9db7cd): a
// local server that stands in for GitHub and answers HTTP 504 a set number of
// times before it serves the file, as GitHub did for an hour on 2026-11-08.
//
// The installer runs the REAL curl, so its retry flags are what is under test.
// A curl wrapper first in PATH sends every https:// URL to this server and
// adds --retry-delay 1 last (curl takes the last value; 0 would mean curl's
// own backoff), so a run with the production retry count takes seconds, not
// minutes. The wrapper records each call's arguments as given, so a test can
// read the delay the installer asked for.
//
// The server runs in the test process: drive the installer with an async
// Bun.spawn, never spawnSync, which would block the server's replies. It is a
// node:http server because a failed try can also be a connection closed with
// no reply, which Bun.serve cannot produce.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

type Plan = {
  failures: number;
  // How a failed try fails: an HTTP 504 with a body (default), or the
  // connection closed with no reply, which curl retries only with
  // --retry-all-errors.
  fail?: "504" | "drop";
  status?: number;
  body?: string | Buffer;
};

export type GithubStub = {
  // Serve `url` (an https:// URL) to case `id`: fail the first `failures`
  // requests, then answer `status` (default 200) with `body`.
  plan: (id: string, url: string, plan: Plan) => void;
  // Requests case `id` made for `url`.
  hits: (id: string, url: string) => number;
  // Environment for one case's shell: PATH with the wrapper first. The
  // wrapper appends each call's arguments, one line per call, to `calls`.
  env: (id: string, calls: string) => Record<string, string>;
  // The directory that holds the curl wrapper.
  bin: string;
  stop: () => void;
};

// A body a retry to stdout would leave in the captured output.
export const GATEWAY_BODY = "upstream request timeout\n";

export async function startGithubStub(dir: string): Promise<GithubStub> {
  const realCurl = Bun.which("curl");
  if (!realCurl) throw new Error("these tests need curl on PATH");
  const plans = new Map<string, Plan>();
  const hits = new Map<string, number>();
  const key = (id: string, url: string) => {
    if (!url.startsWith("https://")) throw new Error(`not https: ${url}`);
    return `/${id}/${url.slice("https://".length)}`;
  };
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://stub").pathname;
    const n = (hits.get(path) ?? 0) + 1;
    hits.set(path, n);
    const plan = plans.get(path);
    if (!plan) {
      res.writeHead(404).end("no plan\n");
    } else if (n <= plan.failures && plan.fail === "drop") {
      req.socket.destroy();
    } else if (n <= plan.failures) {
      res.writeHead(504).end(GATEWAY_BODY);
    } else {
      res.writeHead(plan.status ?? 200).end(plan.body ?? "");
    }
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const port = (server.address() as AddressInfo).port;
  const bin = join(dir, "github-stub-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/bash
printf '%s\\n' "$*" >> "$GH_CALLS"
args=()
for a in "$@"; do
  [[ $a == https://* ]] && a="http://127.0.0.1:$GH_PORT/$GH_CASE/\${a#https://}"
  args+=("$a")
done
exec "$GH_REAL_CURL" "\${args[@]}" --retry-delay 1
`,
  );
  chmodSync(join(bin, "curl"), 0o755);
  return {
    plan: (id, url, plan) => plans.set(key(id, url), plan),
    hits: (id, url) => hits.get(key(id, url)) ?? 0,
    env: (id, calls) => ({
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      GH_PORT: String(port),
      GH_CASE: id,
      GH_REAL_CURL: realCurl,
      GH_CALLS: calls,
    }),
    bin,
    stop: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

// Seconds a recorded curl call waits between tries in total, from the last
// --retry and --retry-delay it was given (the wrapper's own delay is not in
// the record). 0 when either is missing.
export function retryWaitSeconds(call: string): number {
  const last = (flag: string) => {
    const all = [...call.matchAll(new RegExp(`(?:^| )${flag} (\\d+)`, "g"))];
    return all.length ? Number(all.at(-1)![1]) : 0;
  };
  return last("--retry") * last("--retry-delay");
}

// Recorded calls for one URL.
export function callsFor(calls: string, url: string): string[] {
  return calls.split("\n").filter((line) => line.includes(url));
}

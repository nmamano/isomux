// CLI client for the admin Unix socket. Invoked via
//   bun run server/index.ts owner-login --name "Nil"
// The early branch at the top of server/index.ts dynamically imports this
// module only on a CLI invocation, so the rest of the server's heavy
// boot machinery doesn't load. We deliberately keep imports here minimal
// — node:http with socketPath is the simplest portable way to do
// HTTP-over-unix-socket from a one-shot client.

import { request } from "http";
import { homedir } from "os";
import { join } from "path";

const SOCKET_PATH = join(homedir(), ".isomux", "admin.sock");

interface OwnerLoginOk {
  ok: true;
  url: string;
  expiresAt: number;
  ttlMs: number;
}
interface OwnerLoginErr {
  ok: false;
  error: string;
}

function isOwnerLoginResponse(
  x: unknown,
): x is OwnerLoginOk | OwnerLoginErr {
  if (!x || typeof x !== "object") return false;
  const obj = x as Record<string, unknown>;
  return typeof obj.ok === "boolean";
}

export async function runAdminCli(argv: string[]): Promise<void> {
  // argv here is process.argv.slice(2); argv[0] is the subcommand.
  const cmd = argv[0];
  if (cmd !== "owner-login") {
    printUsageAndExit(`unknown CLI subcommand: ${cmd}`);
    return;
  }
  let name: string | null = null;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--name" && i + 1 < argv.length) {
      name = argv[i + 1];
      i++;
      continue;
    }
    if (argv[i] === "--help" || argv[i] === "-h") {
      printUsageAndExit(null);
      return;
    }
  }
  if (!name) {
    printUsageAndExit("--name is required");
    return;
  }
  const result = await sendOwnerLogin(name);
  if (result.ok) {
    const minutes = Math.round(result.ttlMs / 60000);
    process.stdout.write("\n");
    process.stdout.write(`${result.url}\n`);
    process.stdout.write("\n");
    process.stdout.write(
      `Open the URL above in your browser. Expires in ${minutes} minutes.\n`,
    );
  } else {
    process.stderr.write(`error: ${result.error}\n`);
    process.exit(1);
  }
}

function printUsageAndExit(errorMsg: string | null): void {
  if (errorMsg) {
    process.stderr.write(`error: ${errorMsg}\n\n`);
  }
  process.stderr.write(
    `usage: bun run server/index.ts owner-login --name <owner>\n` +
      `  Mints a one-time login URL for an existing owner. The URL points\n` +
      `  at the running server's configured public origin and is valid for\n` +
      `  15 minutes. Run this from a shell on the box hosting isomux; the\n` +
      `  admin socket only accepts loopback (Unix socket, mode 0600).\n`,
  );
  process.exit(errorMsg ? 1 : 0);
}

function sendOwnerLogin(
  name: string,
): Promise<OwnerLoginOk | OwnerLoginErr> {
  const body = JSON.stringify({ name });
  return new Promise((resolve) => {
    const req = request(
      {
        socketPath: SOCKET_PATH,
        path: "/admin/owner-login",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body).toString(),
        },
      },
      (res) => {
        let chunks = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => {
          chunks += chunk;
        });
        res.on("end", () => {
          try {
            const parsed: unknown = JSON.parse(chunks);
            if (isOwnerLoginResponse(parsed)) {
              resolve(parsed);
              return;
            }
            resolve({
              ok: false,
              error: `unexpected server response (HTTP ${res.statusCode}): ${chunks}`,
            });
          } catch {
            resolve({
              ok: false,
              error: `failed to parse server response (HTTP ${res.statusCode}): ${chunks}`,
            });
          }
        });
      },
    );
    req.on("error", (err: NodeJS.ErrnoException) => {
      // Any failure to reach the socket — file missing, no listener, perms
      // mismatch — most likely means the isomux server isn't running for
      // the calling user. Surface a single clear hint plus the raw error
      // so unusual cases (EACCES from a foreign UID, etc.) stay debuggable.
      resolve({
        ok: false,
        error: `could not reach isomux admin socket at ${SOCKET_PATH}. Is the server running as the same user as you? (${err.code ?? err.message})`,
      });
    });
    req.write(body);
    req.end();
  });
}

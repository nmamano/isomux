// `bun run server/isomux-office.ts owner-login --name "Nil"` prints the root
// command that mints an owner sign-in link. The early branch at the top of
// server/isomux-office.ts dynamically imports this module only on a CLI
// invocation, so the rest of the server's heavy boot machinery doesn't load.
//
// It does not connect: the admin socket refuses the server's own uid
// (server/admin-socket.ts), and running this repo's code as root would hand
// root to anyone who can edit it. The system curl run as root is the client.

import { ADMIN_SOCKET_PATH } from "./config.ts";

export function ownerLoginCommand(name: string, socketPath: string): string {
  const body = JSON.stringify({ name });
  return [
    "sudo curl -s --unix-socket",
    shellQuote(socketPath),
    "-X POST http://localhost/admin/owner-login",
    "-H 'Content-Type: application/json'",
    "--data",
    shellQuote(body),
  ].join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function runAdminCli(argv: string[]): void {
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
  process.stdout.write(
    `Run this as root on this machine. It prints a sign-in URL that expires in 15 minutes.\n\n` +
      `${ownerLoginCommand(name, ADMIN_SOCKET_PATH)}\n`,
  );
}

function printUsageAndExit(errorMsg: string | null): void {
  if (errorMsg) {
    process.stderr.write(`error: ${errorMsg}\n\n`);
  }
  process.stderr.write(
    `usage: bun run server/isomux-office.ts owner-login --name <owner>\n` +
      `  Prints the root command that mints a one-time sign-in URL for an\n` +
      `  existing owner. The admin socket answers only root.\n`,
  );
  process.exit(errorMsg ? 1 : 0);
}

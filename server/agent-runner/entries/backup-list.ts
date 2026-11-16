// The backup of the member's agent space (server/member-backup-send.ts),
// read as the member and written to stdout. Not runEntry: the output is a
// stream, not one JSON value.
import { listSpace } from "../../member-backup-send.ts";

try {
  const input = JSON.parse(await Bun.stdin.text()) as { agentRoot: string };
  await listSpace(input, async (chunk) => {
    if (!process.stdout.write(chunk))
      await new Promise<void>((resolve) =>
        process.stdout.once("drain", resolve),
      );
  });
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

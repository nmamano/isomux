// The backup of the member's agent space (server/member-backup-send.ts),
// read as the member and written to stdout. Not runEntry: the output is a
// stream, not one JSON value.
import {
  sendSpaceFiles,
  type SpaceFilesInput,
} from "../../member-backup-send.ts";

try {
  const input = JSON.parse(await Bun.stdin.text()) as SpaceFilesInput;
  await sendSpaceFiles(input, async (chunk) => {
    if (!process.stdout.write(chunk))
      await new Promise<void>((resolve) =>
        process.stdout.once("drain", resolve),
      );
  });
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

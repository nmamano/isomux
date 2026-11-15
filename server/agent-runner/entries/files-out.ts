// The move back on disable: the requested files of the member's agent
// space, read as the member and written to stdout as records
// (server/member-move-receive.ts sendFiles). Not runEntry: the output is
// the record stream, not one JSON value.
import { sendFiles, type MoveOutInput } from "../../member-move-receive.ts";

try {
  const input = JSON.parse(await Bun.stdin.text()) as MoveOutInput;
  await sendFiles(input, async (chunk) => {
    if (!process.stdout.write(chunk))
      await new Promise<void>((resolve) =>
        process.stdout.once("drain", resolve),
      );
  });
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

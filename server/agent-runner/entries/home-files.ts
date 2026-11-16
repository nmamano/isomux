// An office move (server/member-home-send.ts): the asked files of her home,
// read as the member and written to stdout. Not runEntry: the output is a
// stream, not one JSON value.
import { sendHomeFiles, type HomeFilesInput } from "../../member-home-send.ts";

try {
  const input = JSON.parse(await Bun.stdin.text()) as HomeFilesInput;
  await sendHomeFiles(input, async (chunk) => {
    if (!process.stdout.write(chunk))
      await new Promise<void>((resolve) =>
        process.stdout.once("drain", resolve),
      );
  });
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

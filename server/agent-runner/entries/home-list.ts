// An office move (server/member-home-send.ts): the listing of her home, read
// as the member and written to stdout. Not runEntry: the output is a
// stream, not one JSON value.
import { listHome, type HomeListInput } from "../../member-home-send.ts";

try {
  const input = JSON.parse(await Bun.stdin.text()) as HomeListInput;
  await listHome(input, async (chunk) => {
    if (!process.stdout.write(chunk))
      await new Promise<void>((resolve) =>
        process.stdout.once("drain", resolve),
      );
  });
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

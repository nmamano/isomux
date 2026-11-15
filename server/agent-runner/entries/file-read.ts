// Bytes of one file, read as the member (server/file-read-range.ts). Not
// runEntry: the output is a header line and the bytes, not one JSON value.
import { sendFileRange, type FileReadInput } from "../../file-read-range.ts";

try {
  const input = JSON.parse(await Bun.stdin.text()) as FileReadInput;
  await sendFileRange(input, async (chunk) => {
    if (!process.stdout.write(chunk))
      await new Promise<void>((resolve) =>
        process.stdout.once("drain", resolve),
      );
  });
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

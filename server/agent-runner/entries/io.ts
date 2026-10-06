// Shared I/O for the fixed entries: one JSON value in on stdin, one out on
// stdout, exit 0. A thrown error exits 1 with the message on stderr.
export async function runEntry(
  handle: (input: unknown) => unknown,
): Promise<void> {
  try {
    const text = await Bun.stdin.text();
    const output = await handle(text ? JSON.parse(text) : null);
    process.stdout.write(JSON.stringify(output ?? null));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}

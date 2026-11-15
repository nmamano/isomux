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

// An entry that takes a body: the JSON input is the first line of stdin
// (the runner's stream option), the rest is the body.
export async function runStreamEntry(
  handle: (input: unknown, body: AsyncIterable<Uint8Array>) => unknown,
): Promise<void> {
  try {
    const reader = Bun.stdin.stream().getReader();
    let head = Buffer.alloc(0);
    let newline = -1;
    while (newline < 0) {
      const { done, value } = await reader.read();
      if (done) throw new Error("the entry input has no end of line");
      head = Buffer.concat([head, Buffer.from(value)]);
      newline = head.indexOf(0x0a);
    }
    const input: unknown = JSON.parse(
      head.subarray(0, newline).toString("utf8"),
    );
    const rest = head.subarray(newline + 1);
    async function* body(): AsyncGenerator<Uint8Array> {
      if (rest.length > 0) yield rest;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    }
    const output = await handle(input, body());
    process.stdout.write(JSON.stringify(output ?? null));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}

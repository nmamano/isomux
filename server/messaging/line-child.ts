// A child process that speaks one JSON object per line: commands on its
// stdin, events on its stdout. The thin Bun glue behind the WhatsApp bridge
// and the Discord gateway child; their supervisors use fakes in tests.

export interface LineChild<C, E> {
  readonly pid: number;
  send(cmd: C): void;
  kill(): void;
  onEvent(listener: (event: E) => void): void;
  onExit(listener: (code: number | null) => void): void;
}

export interface LineChildSpec<C, E> {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  encode(cmd: C): string;
  // One stdout line to an event, or null to drop it.
  parse(line: string): E | null;
  // The log tag, for example "whatsapp".
  tag: string;
}

async function* lines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      yield buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
    }
  }
  if (buffered) yield buffered;
}

// Runs each listener on its own: one that throws must not stop the others,
// and must not escape, since a throw here ends the office server.
function callEach<T>(
  tag: string,
  listeners: ((value: T) => void)[],
  value: T,
): void {
  for (const listener of listeners) {
    try {
      listener(value);
    } catch {
      console.error(`[${tag}] a child listener failed`);
    }
  }
}

export function spawnLineChild<C, E>(
  spec: LineChildSpec<C, E>,
): LineChild<C, E> {
  const proc = Bun.spawn({
    cmd: spec.argv,
    cwd: spec.cwd,
    env: spec.env,
    stdin: "pipe",
    stdout: "pipe",
    // Third-party output can name contacts or carry secrets: none of it
    // reaches the log.
    stderr: "ignore",
  });
  const eventListeners: ((event: E) => void)[] = [];
  const exitListeners: ((code: number | null) => void)[] = [];
  const read = (async () => {
    try {
      for await (const line of lines(proc.stdout)) {
        const event = spec.parse(line);
        if (!event) {
          console.warn(`[${spec.tag}] dropped a line the child sent`);
          continue;
        }
        callEach(spec.tag, eventListeners, event);
      }
    } catch {
      console.warn(`[${spec.tag}] the child output failed`);
    }
  })();
  // The exit comes after every event the child wrote, so a `closed` event is
  // seen before the exit it explains.
  void Promise.all([proc.exited, read]).then(([code]) =>
    callEach(spec.tag, exitListeners, code),
  );
  return {
    pid: proc.pid,
    send(cmd) {
      try {
        // A write to a closed pipe can also fail later, as a rejection.
        void Promise.resolve(proc.stdin.write(spec.encode(cmd))).catch(
          () => {},
        );
        void Promise.resolve(proc.stdin.flush()).catch(() => {});
      } catch {
        // The child is gone; its exit reports it.
      }
    },
    kill() {
      proc.kill("SIGKILL");
    },
    onEvent(listener) {
      eventListeners.push(listener);
    },
    onExit(listener) {
      exitListeners.push(listener);
    },
  };
}

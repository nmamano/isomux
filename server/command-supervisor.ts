// The supervision a one-shot command run needs, shared by a sudo request's
// run (sudo-runner.ts) and an ask's Run (ask-command-runner.ts): the output
// read to its end, the timeout that stops the run, and the tail of the
// output that is kept.

// How long the output is read after the process exits: a background child
// can keep the pipes open for as long as it runs.
export const OUTPUT_DRAIN_MS = 300;

export interface SupervisedProcess {
  // The output streams, in the order onText numbers them.
  streams: ReadableStream<Uint8Array>[];
  // Settles when the process exits.
  exited: Promise<unknown>;
  // Signals the process (sudo) or its group (an ask's Run).
  terminate(signal: NodeJS.Signals): void;
}

export interface SupervisorOptions {
  timeoutMs: number;
  killGraceMs: number;
  // Each decoded chunk, with the index of its stream. A throw is logged and
  // the chunk dropped.
  onText(text: string, stream: number): void;
  drainMs?: number;
}

export interface Supervision {
  // Settles when the process exited and its output was read (or the drain
  // time passed). Never rejects.
  ended: Promise<void>;
  timedOut(): boolean;
}

// Reads every stream until the process exits and OUTPUT_DRAIN_MS more; at
// timeoutMs sends SIGTERM, and SIGKILL killGraceMs later.
export function superviseProcess(
  proc: SupervisedProcess,
  opts: SupervisorOptions,
): Supervision {
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const terminate = (signal: NodeJS.Signals) => {
    try {
      proc.terminate(signal);
    } catch {
      // gone already
    }
  };
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    terminate("SIGTERM");
    killTimer = setTimeout(() => terminate("SIGKILL"), opts.killGraceMs);
  }, opts.timeoutMs);

  let stopReading: () => void = () => {};
  const stop = new Promise<null>(
    (resolve) => (stopReading = () => resolve(null)),
  );
  const read = async (stream: ReadableStream<Uint8Array>, index: number) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await Promise.race([reader.read(), stop]);
        if (chunk === null || chunk.done) break;
        const text = decoder.decode(chunk.value, { stream: true });
        try {
          opts.onText(text, index);
        } catch (err) {
          console.error("[command-supervisor] an output listener threw:", err);
        }
      }
    } catch {
      // A read error ends this stream's output.
    } finally {
      reader.cancel().catch(() => {});
    }
  };
  const reading = Promise.all(proc.streams.map(read));
  const ended = (async () => {
    try {
      await proc.exited;
    } catch {
      // An exit that rejects still ends the run.
    }
    clearTimeout(timeoutTimer);
    if (killTimer) clearTimeout(killTimer);
    const drained = setTimeout(stopReading, opts.drainMs ?? OUTPUT_DRAIN_MS);
    await reading;
    clearTimeout(drained);
  })();
  return { ended, timedOut: () => timedOut };
}

export interface OutputTail {
  append(text: string): void;
  // The last `max` characters.
  value(): string;
}

// The last `max` characters of the output. `normalize` runs over the held
// text at each append and at the read (sudo strips its markers there, so a
// marker split across two chunks is still found); `slack` more characters
// are held so that it sees a whole marker at the cut.
export function createOutputTail(
  max: number,
  opts: { slack?: number; normalize?: (text: string) => string } = {},
): OutputTail {
  const normalize = opts.normalize ?? ((text: string) => text);
  const slack = opts.slack ?? 0;
  let held = "";
  return {
    append(text) {
      held = normalize(held + text);
      if (held.length > 2 * max) held = held.slice(-max - slack);
    },
    value: () => normalize(held).slice(-max),
  };
}

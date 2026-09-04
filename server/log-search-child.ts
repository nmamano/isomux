// Child process for the conversation-log search scan. Reads one JSON request on
// stdin, runs the shared core, writes one JSON envelope on stdout, exits.
//
// WHY A SEPARATE PROCESS AND NOT A WORKER THREAD - this is the ReDoS guard, and
// only a process actually delivers one in this runtime. Regex support needs a
// match timeout or an RE2-style engine. Everything below
// was measured, not assumed:
//
//   - A Worker CANNOT be stopped. `worker.terminate()` does not preempt running
//     JavaScript; termination is only observed when the worker returns to its
//     event loop. Two workers doing IDENTICAL total work: the one that awaits
//     between matches died 311ms after terminate(); the one that ran the same
//     loop without awaiting never died at all, and kept a core at 100%
//     indefinitely. Our scan awaits between stream CHUNKS, so a single chunk of
//     log lines is an unbounded synchronous burst with no interruption point -
//     exactly the shape that cannot be terminated.
//   - A PROCESS can. SIGKILL stopped that same non-yielding spinner in 3ms
//     (exit 137). That is a real wall-clock bound, which is what makes the
//     endpoint's 504 a truthful statement rather than a hopeful one.
//   - The cost is small enough not to matter here: a child's full
//     startup-to-exit measured ~34ms, against a rare, human- or agent-initiated
//     endpoint that is already capped at 3 concurrent runs.
//
// A process also still gives what the Worker gave: the office's single event
// loop never runs caller-supplied regexes or tens of megabytes of JSON parsing.
//
// The request arrives on STDIN rather than argv deliberately - argv is visible
// in `ps` to every user on the box, and the request carries the caller's search
// query.
//
// This file has NO transitive import of server/config.ts, so it never resolves
// STATE_ROOT: the logs directory is handed to it explicitly. That keeps the
// child independent of environment inheritance and lets tests point it at a
// fixture tree.

import { searchLogs, type LogQuery } from "./log-search.ts";
import { fileLogSource } from "./log-source.ts";

export interface SearchChildRequest {
  logsDir: string;
  agentId: string;
  query: LogQuery;
  budgetMs: number;
}

const raw = await new Response(Bun.stdin.stream()).text();

try {
  const req = JSON.parse(raw) as SearchChildRequest;
  const result = await searchLogs(
    fileLogSource(req.logsDir),
    req.agentId,
    req.query,
    { budgetMs: req.budgetMs },
  );
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (err) {
  // Structured failure on stdout so the parent never has to interpret an exit
  // code plus a stack trace. A SIGKILLed child writes nothing at all, which the
  // parent treats as the timeout it already knows it caused.
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
}

import { describe, expect, it } from "bun:test";
import {
  INTERRUPT_INPUT_BYTES,
  advanceCommandDelivery,
  commandInputBytes,
  looksLikeContinuationPrompt,
  queueCommand,
} from "./terminal-command.ts";

describe("commandInputBytes", () => {
  it("clears the full input line and leaves the command unexecuted", () => {
    const bytes = commandInputBytes("expr 6 \\* 7");
    expect(bytes).toBe("\x05\x15expr 6 \\* 7");
    expect(bytes).not.toMatch(/[\r\n]/u);
    expect(bytes).not.toContain("\x03");
  });

  it("asks for a fresh owner and types at a primary prompt without an interrupt", () => {
    const queued = queueCommand(null, "expr 6 \\* 7");
    expect(queued.requestStatus).toBe(true);
    expect("write" in queued).toBe(false);

    const output = advanceCommandDelivery(queued.state, {
      type: "output",
      data: "background output\r\n",
    });
    expect(output.write).toBeUndefined();
    expect(output.state?.phase).toBe("owner");

    const sent = advanceCommandDelivery(output.state, {
      type: "status",
      shell: true,
      process: "bash",
      line: "nil@auntie:~/nil$ half-typed",
    });
    expect(sent.write).toBe(commandInputBytes("expr 6 \\* 7"));
    expect(sent.write).not.toContain(INTERRUPT_INPUT_BYTES);
    expect(sent.handled).toBe(true);
    expect(sent.state).toBeNull();
  });

  it("interrupts a continuation prompt, then waits for its output and a fresh owner", () => {
    const queued = queueCommand(null, "echo AFTER");
    const continuation = advanceCommandDelivery(queued.state, {
      type: "status",
      shell: true,
      process: "zsh",
      line: "quote> partial",
    });
    expect(continuation.write).toBe(INTERRUPT_INPUT_BYTES);
    expect(continuation.handled).toBeUndefined();
    expect(continuation.state?.phase).toBe("interrupt_ack");

    const staleStatus = advanceCommandDelivery(continuation.state, {
      type: "status",
      shell: true,
      process: "zsh",
      line: "quote> partial",
    });
    expect(staleStatus.write).toBeUndefined();
    expect(staleStatus.state?.phase).toBe("interrupt_ack");

    const acknowledged = advanceCommandDelivery(staleStatus.state, {
      type: "output",
      data: "\r\r\nauntie% ",
    });
    expect(acknowledged.write).toBeUndefined();
    expect(acknowledged.requestStatus).toBe(true);
    expect(acknowledged.state?.phase).toBe("fresh_owner");

    const later = advanceCommandDelivery(acknowledged.state, {
      type: "output",
      data: "prompt redraw",
    });
    expect(later.requestStatus).toBeUndefined();

    // After one interrupt the command is typed even if the line still looks
    // like a continuation, so a prompt such as "nil> " cannot loop.
    const sent = advanceCommandDelivery(later.state, {
      type: "status",
      shell: true,
      process: "zsh",
      line: "> ",
    });
    expect(sent.write).toBe(commandInputBytes("echo AFTER"));
    expect(sent.handled).toBe(true);
  });

  it("replaces repeated cards and sends at most the latest command", () => {
    const first = queueCommand(null, "echo FIRST");
    const second = queueCommand(first.state, "echo SECOND");
    expect(second.requestStatus).toBeUndefined();
    const sent = advanceCommandDelivery(second.state, {
      type: "status",
      shell: true,
      process: "bash",
      line: "$ ",
    });
    expect(sent.write).toBe(commandInputBytes("echo SECOND"));
    expect(sent.write).not.toContain("FIRST");
  });

  it("lands no command after a foreign owner or terminal exit", () => {
    const queued = queueCommand(null, "sudo safe-command");
    const foreign = advanceCommandDelivery(queued.state, {
      type: "status",
      shell: false,
      process: "vim",
      line: "> ",
    });
    expect(foreign.write).toBeUndefined();
    expect(foreign.issue).toEqual({ kind: "busy", process: "vim" });
    expect(foreign.handled).toBe(true);

    const interrupted = advanceCommandDelivery(
      advanceCommandDelivery(
        advanceCommandDelivery(queued.state, {
          type: "status",
          shell: true,
          process: "bash",
          line: "> ",
        }).state,
        { type: "output", data: "^C" },
      ).state,
      { type: "status", shell: false, process: "python3", line: "" },
    );
    expect(interrupted.write).toBeUndefined();
    expect(interrupted.issue).toEqual({ kind: "busy", process: "python3" });

    const exited = advanceCommandDelivery(queued.state, { type: "exit" });
    expect(exited.write).toBeUndefined();
    expect(exited.issue).toEqual({ kind: "unavailable" });
    expect(exited.handled).toBe(true);
  });

  it("reports a visible failure when no fresh owner arrives", () => {
    const queued = queueCommand(null, "echo WAITING");
    const timedOut = advanceCommandDelivery(queued.state, { type: "timeout" });
    expect(timedOut.write).toBeUndefined();
    expect(timedOut.issue).toEqual({ kind: "unavailable" });
    expect(timedOut.handled).toBe(true);
    expect(timedOut.state).toBeNull();
  });

  it("reports a timeout before delivery state exists", () => {
    const result = advanceCommandDelivery(null, { type: "timeout" });
    expect(result.write).toBeUndefined();
    expect(result.issue).toEqual({ kind: "unavailable" });
    expect(result.handled).toBe(true);
    expect(result.state).toBeNull();
  });

  it("ignores an exit before delivery state exists", () => {
    const result = advanceCommandDelivery(null, { type: "exit" });
    expect(result).toEqual({ state: null });
  });
});

describe("looksLikeContinuationPrompt", () => {
  it("recognizes the default bash and zsh continuation prompts", () => {
    for (const line of ["> ", "> echo 'a", "quote> ", "if then> x", "dquote> "])
      expect(looksLikeContinuationPrompt(line)).toBe(true);
  });

  it("does not take common primary prompts for continuations", () => {
    for (const line of [
      "nil@auntie:~/nil$ ",
      "auntie% ",
      "❯ ",
      "➜  isomux git:(main) ",
      "~/nil/isomux> ",
      "",
    ])
      expect(looksLikeContinuationPrompt(line)).toBe(false);
  });
});

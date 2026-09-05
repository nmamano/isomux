import { describe, expect, it } from "bun:test";
import {
  INTERRUPT_INPUT_BYTES,
  advanceCommandDelivery,
  commandInputBytes,
  queueCommand,
} from "./terminal-command.ts";

describe("commandInputBytes", () => {
  it("clears the full input line and leaves the command unexecuted", () => {
    const bytes = commandInputBytes("expr 6 \\* 7");
    expect(bytes).toBe("\x05\x15expr 6 \\* 7");
    expect(bytes).not.toMatch(/[\r\n]/u);
    expect(bytes).not.toContain("\x03");
  });

  it("waits for a post-interrupt ^C and then a fresh shell status", () => {
    const queued = queueCommand(null, "expr 6 \\* 7");
    expect(queued.write).toBe(INTERRUPT_INPUT_BYTES);
    expect(queued.write).not.toContain("expr");

    const cachedStatus = advanceCommandDelivery(queued.state, {
      type: "status",
      shell: true,
      process: "bash",
    });
    expect(cachedStatus.write).toBeUndefined();
    expect(cachedStatus.state?.phase).toBe("interrupt_ack");

    const arbitraryOutput = advanceCommandDelivery(cachedStatus.state, {
      type: "output",
      data: "background output\r\n",
    });
    expect(arbitraryOutput.state?.phase).toBe("interrupt_ack");
    expect(arbitraryOutput.requestStatus).toBeUndefined();

    const caret = advanceCommandDelivery(arbitraryOutput.state, {
      type: "output",
      data: "^",
    });
    expect(caret.state?.phase).toBe("interrupt_ack");
    const acknowledged = advanceCommandDelivery(caret.state, {
      type: "output",
      data: "C\r\n$ ",
    });
    expect(acknowledged.state?.phase).toBe("fresh_owner");
    expect(acknowledged.write).toBeUndefined();
    expect(acknowledged.requestStatus).toBe(true);
    for (const data of ["prompt redraw", "background output"]) {
      const afterAcknowledgement = advanceCommandDelivery(acknowledged.state, {
        type: "output",
        data,
      });
      expect(afterAcknowledgement.state?.phase).toBe("fresh_owner");
      expect(afterAcknowledgement.requestStatus).toBeUndefined();
    }

    const freshStatus = advanceCommandDelivery(acknowledged.state, {
      type: "status",
      shell: true,
      process: "bash",
    });
    expect(freshStatus.write).toBe("\x05\x15expr 6 \\* 7");
    expect(freshStatus.write).not.toMatch(/[\r\n]/u);
    expect(freshStatus.write).not.toContain(INTERRUPT_INPUT_BYTES);
    expect(freshStatus.handled).toBe(true);
    expect(freshStatus.state).toBeNull();
  });

  it("replaces repeated cards and sends at most the latest command", () => {
    const first = queueCommand(null, "echo FIRST");
    const second = queueCommand(first.state, "echo SECOND");
    expect(second.write).toBeUndefined();
    const acknowledged = advanceCommandDelivery(second.state, {
      type: "output",
      data: "^C",
    });
    const sent = advanceCommandDelivery(acknowledged.state, {
      type: "status",
      shell: true,
      process: "bash",
    });
    expect(sent.write).toBe("\x05\x15echo SECOND");
    expect(sent.write).not.toContain("FIRST");
  });

  it("lands no command after a fresh foreign owner or terminal exit", () => {
    const queued = queueCommand(null, "sudo safe-command");
    const acknowledged = advanceCommandDelivery(queued.state, {
      type: "output",
      data: "^C",
    });
    expect(acknowledged.requestStatus).toBe(true);
    const foreign = advanceCommandDelivery(acknowledged.state, {
      type: "status",
      shell: false,
      process: "vim",
    });
    expect(foreign.write).toBeUndefined();
    expect(foreign.issue).toEqual({ kind: "busy", process: "vim" });
    expect(foreign.handled).toBe(true);

    const exited = advanceCommandDelivery(queued.state, { type: "exit" });
    expect(exited.write).toBeUndefined();
    expect(exited.issue).toEqual({ kind: "unavailable" });
    expect(exited.handled).toBe(true);
  });

  it("reports a visible failure when the interrupt is never acknowledged", () => {
    const queued = queueCommand(null, "echo WAITING");
    const arbitraryOutput = advanceCommandDelivery(queued.state, {
      type: "output",
      data: "output that was already in flight",
    });
    const timedOut = advanceCommandDelivery(arbitraryOutput.state, {
      type: "timeout",
    });
    expect(timedOut.write).toBeUndefined();
    expect(timedOut.issue).toEqual({ kind: "unavailable" });
    expect(timedOut.handled).toBe(true);
    expect(timedOut.state).toBeNull();
  });

  it("reports timeout and exit before delivery state exists", () => {
    for (const type of ["timeout", "exit"] as const) {
      const result = advanceCommandDelivery(null, { type });
      expect(result.write).toBeUndefined();
      expect(result.issue).toEqual({ kind: "unavailable" });
      expect(result.handled).toBe(true);
      expect(result.state).toBeNull();
    }
  });
});

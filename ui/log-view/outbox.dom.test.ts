// Task 51de8814: the outbox keeps every attempt across a reload, with its
// original id and payload, until the server acknowledges it.
import { beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { setApiShim } = await import("../api.ts");
const outbox = await import("./outbox.ts");

const attachment = {
  filename: "f1.png",
  originalName: "shot.png",
  mediaType: "image/png",
  size: 10,
};

beforeEach(() => {
  outbox._resetOutboxForTests();
  window.localStorage.clear();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it("restores an attempt that was in flight at reload as failed, with its id and payload", async () => {
  setApiShim(() => new Promise(() => {})); // never answers
  outbox.restoreOutbox("Boss", new Set(["a1"]));
  const sent = outbox.sendAttempt({
    agentId: "a1",
    text: "careful prompt",
    attachments: [attachment],
  });

  // A reload: module state is gone, localStorage is not.
  outbox._resetOutboxForTests();
  outbox.restoreOutbox("Boss", new Set(["a1"]));
  const [restored] = outbox.outboxFor("a1");
  expect(restored.id).toBe(sent!.id);
  expect(restored.text).toBe("careful prompt");
  expect(restored.attachments).toEqual([attachment]);
  expect(restored.status).toBe("failed");
  expect(restored.error).toEqual({ kind: "interrupted" });
});

it("removes the saved attempt once the server acknowledges it", async () => {
  setApiShim(async () => ({}));
  outbox.restoreOutbox("Boss", new Set(["a1"]));
  outbox.sendAttempt({ agentId: "a1", text: "fine" });
  await settle();
  expect(outbox.outboxFor("a1")).toEqual([]);
  outbox._resetOutboxForTests();
  outbox.restoreOutbox("Boss", new Set(["a1"]));
  expect(outbox.outboxFor("a1")).toEqual([]);
});

it("keeps the attempts of another member and drops those of a gone agent", async () => {
  setApiShim(() => new Promise(() => {}));
  outbox.restoreOutbox("Boss", new Set(["a1", "a2"]));
  outbox.sendAttempt({ agentId: "a1", text: "to a1" });
  outbox.sendAttempt({ agentId: "a2", text: "to a2" });

  outbox._resetOutboxForTests();
  outbox.restoreOutbox("Friend", new Set(["a1", "a2"]));
  expect(outbox.outboxFor("a1")).toEqual([]);

  outbox._resetOutboxForTests();
  outbox.restoreOutbox("Boss", new Set(["a1"]));
  expect(outbox.outboxFor("a1").map((a) => a.text)).toEqual(["to a1"]);
  expect(outbox.outboxFor("a2")).toEqual([]);
});

it("takeAttempt hands back the attachments and forgets the attempt", async () => {
  setApiShim(async () => {
    throw new TypeError("Failed to fetch");
  });
  outbox.restoreOutbox("Boss", new Set(["a1"]));
  const sent = outbox.sendAttempt({
    agentId: "a1",
    text: "with file",
    attachments: [attachment],
  });
  await settle();
  const taken = outbox.takeAttempt(sent!.id);
  expect(taken?.attachments).toEqual([attachment]);
  expect(outbox.outboxFor("a1")).toEqual([]);
  outbox._resetOutboxForTests();
  outbox.restoreOutbox("Boss", new Set(["a1"]));
  expect(outbox.outboxFor("a1")).toEqual([]);
});

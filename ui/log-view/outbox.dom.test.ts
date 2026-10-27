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
  outbox.restoreOutbox("Morgan", new Set(["a1"]));
  const sent = outbox.sendAttempt({
    agentId: "a1",
    text: "careful prompt",
    attachments: [attachment],
  });

  // A reload: module state is gone, localStorage is not.
  outbox._resetOutboxForTests();
  outbox.restoreOutbox("Morgan", new Set(["a1"]));
  const [restored] = outbox.outboxFor("a1");
  expect(restored.id).toBe(sent!.id);
  expect(restored.text).toBe("careful prompt");
  expect(restored.attachments).toEqual([attachment]);
  expect(restored.status).toBe("failed");
  expect(restored.error).toEqual({ kind: "interrupted" });
});

it("removes the saved attempt once the server acknowledges it", async () => {
  setApiShim(async () => ({}));
  outbox.restoreOutbox("Morgan", new Set(["a1"]));
  outbox.sendAttempt({ agentId: "a1", text: "fine" });
  await settle();
  expect(outbox.outboxFor("a1")).toEqual([]);
  outbox._resetOutboxForTests();
  outbox.restoreOutbox("Morgan", new Set(["a1"]));
  expect(outbox.outboxFor("a1")).toEqual([]);
});

it("keeps the attempts of another member and drops those of a gone agent", async () => {
  setApiShim(() => new Promise(() => {}));
  outbox.restoreOutbox("Morgan", new Set(["a1", "a2"]));
  outbox.sendAttempt({ agentId: "a1", text: "to a1" });
  outbox.sendAttempt({ agentId: "a2", text: "to a2" });

  outbox._resetOutboxForTests();
  outbox.restoreOutbox("Friend", new Set(["a1", "a2"]));
  expect(outbox.outboxFor("a1")).toEqual([]);

  outbox._resetOutboxForTests();
  outbox.restoreOutbox("Morgan", new Set(["a1"]));
  expect(outbox.outboxFor("a1").map((a) => a.text)).toEqual(["to a1"]);
  expect(outbox.outboxFor("a2")).toEqual([]);
});

// An attempt sent from the office that a phone's app widget opened carries the
// app and the page the member came from (task d7ac4f73). The context belongs to
// that page load: a resend in the same page keeps it, a restored attempt sends
// without it, so a reload never turns a retry into a refusal for an app
// registration that has since changed.
it("sends an attempt's app context while the page lives, and restores the attempt without it", async () => {
  const bodies: Record<string, unknown>[] = [];
  let fail = true;
  setApiShim(async (_method, _path, body) => {
    bodies.push(body as Record<string, unknown>);
    if (fail) throw new TypeError("Failed to fetch");
    return {};
  });
  outbox.restoreOutbox("Morgan", new Set(["a1"]));
  const appContext = {
    name: "hello",
    registration: 1,
    view: { path: "/recipes/3", title: "Pasta" },
  };
  const sent = outbox.sendAttempt({
    agentId: "a1",
    text: "from the app",
    appContext,
  });
  await settle();
  outbox.resendAttempt(sent!.id);
  await settle();
  expect(bodies.map((body) => body.appContext)).toEqual([
    appContext,
    appContext,
  ]);
  // The saved copy holds the attempt and not its page: the page path and title
  // come from app content, and must not outlive the page load in storage.
  const saved = Object.keys(localStorage)
    .map((key) => localStorage.getItem(key) ?? "")
    .join("\n");
  expect(saved).toContain("from the app");
  expect(saved).not.toContain("/recipes/3");

  outbox._resetOutboxForTests();
  outbox.restoreOutbox("Morgan", new Set(["a1"]));
  const [restored] = outbox.outboxFor("a1");
  expect(restored.id).toBe(sent!.id);
  fail = false;
  outbox.resendAttempt(restored.id);
  await settle();
  expect(bodies).toHaveLength(3);
  expect(bodies[2].text).toBe("from the app");
  expect(bodies[2].clientMessageId).toBe(sent!.id);
  expect(bodies[2]).not.toHaveProperty("appContext");
});

it("takeAttempt hands back the attachments and forgets the attempt", async () => {
  setApiShim(async () => {
    throw new TypeError("Failed to fetch");
  });
  outbox.restoreOutbox("Morgan", new Set(["a1"]));
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
  outbox.restoreOutbox("Morgan", new Set(["a1"]));
  expect(outbox.outboxFor("a1")).toEqual([]);
});

// Task 44872c41: runs are never deleted, so a cronjob run attempt is kept
// across a reload even though its stream id is no live agent, and it resends
// to the run's route.
it("restores a cronjob run attempt and resends it to the run's route", async () => {
  const paths: string[] = [];
  setApiShim(async (_method, path) => {
    paths.push(path);
    throw new TypeError("Failed to fetch");
  });
  outbox.restoreOutbox("Morgan", new Set(["a1"]));
  const sent = outbox.sendAttempt({
    agentId: "cronrun-r1",
    cronRun: { jobId: "j1", runId: "r1" },
    text: "follow up",
  });
  await settle();

  outbox._resetOutboxForTests();
  outbox.restoreOutbox("Morgan", new Set(["a1"]));
  const [restored] = outbox.outboxFor("cronrun-r1");
  expect(restored.id).toBe(sent!.id);
  expect(restored.cronRun).toEqual({ jobId: "j1", runId: "r1" });

  outbox.resendAttempt(restored.id);
  await settle();
  expect(paths).toEqual([
    "/api/cronjobs/j1/runs/r1/messages",
    "/api/cronjobs/j1/runs/r1/messages",
  ]);
});

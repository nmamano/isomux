// The GitHub issue sync (task 7fc83592), at its own boundary: createGithubSync
// over a real office.sqlite and the link store, against a fake of GitHub's
// issues API (test-support/fake-github.ts) that answers the way GitHub
// documents. The board side is an in-memory task list, so each test reads the
// tasks a pass wrote. Routes, the wire projection and the audit actor are in
// test-support/routes-github-sync-rest.test.ts.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openOfficeDatabase } from "./audit-store.ts";
import {
  createGithubLinkStore,
  createGithubSync,
  DEFAULT_GITHUB_SYNC_SECRET,
  GITHUB_FETCH_TIMEOUT_MS,
  GITHUB_MAX_WAIT_MS,
  GITHUB_SYNC_INTERVAL_MS,
  type GithubLinkInput,
  type GithubSyncScheduler,
  type GithubSyncTasks,
} from "./github-sync.ts";
import {
  FakeGithub,
  githubTime,
  type FakeIssue,
} from "./test-support/fake-github.ts";
import { removeStateDir } from "./test-support/temp-state.ts";
import type { TaskItem, TaskStatus } from "../shared/types.ts";

const roots: string[] = [];
const handles: Database[] = [];
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
  for (const root of roots.splice(0)) removeStateDir(root);
});

class FakeTasks implements GithubSyncTasks {
  items: TaskItem[] = [];
  failAdds = 0;
  private n = 0;
  list(): TaskItem[] {
    return this.items.map((t) => structuredClone(t));
  }
  add(
    title: string,
    createdBy: string,
    opts: Parameters<GithubSyncTasks["add"]>[2],
  ): TaskItem {
    if (this.failAdds > 0) {
      this.failAdds--;
      throw new Error("task store write failed");
    }
    this.n++;
    const task = {
      id: this.n.toString(16).padStart(8, "0"),
      title,
      createdBy,
      createdAt: this.n,
      status: "open",
      version: `v${this.n}`,
      ...structuredClone(opts),
    } as TaskItem;
    this.items.push(task);
    return structuredClone(task);
  }
  update(
    id: string,
    changes: Parameters<GithubSyncTasks["update"]>[1],
  ): TaskItem | null {
    const task = this.items.find((t) => t.id === id);
    if (!task) return null;
    Object.assign(task, structuredClone(changes));
    return structuredClone(task);
  }
  of(number: number, repo = "acme/widgets"): TaskItem | undefined {
    return this.items.find(
      (t) =>
        t.external?.number === number && t.external.repo.toLowerCase() === repo,
    );
  }
  // What a member does on the board.
  set(number: number, changes: Partial<TaskItem>): void {
    const task = this.of(number);
    if (!task) throw new Error(`no task for issue ${number}`);
    Object.assign(task, changes);
  }
  remove(number: number): void {
    this.items = this.items.filter((t) => t.external?.number !== number);
  }
}

interface FakeTimer {
  fn: () => void;
  ms: number;
  cleared: boolean;
  fired: boolean;
}
class FakeScheduler implements GithubSyncScheduler {
  timers: FakeTimer[] = [];
  setTimeout(fn: () => void, ms: number): unknown {
    const timer = { fn, ms, cleared: false, fired: false };
    this.timers.push(timer);
    return timer;
  }
  clearTimeout(handle: unknown): void {
    if (handle) (handle as FakeTimer).cleared = true;
  }
  pending(ms?: number): FakeTimer[] {
    return this.timers.filter(
      (t) => !t.cleared && !t.fired && (ms === undefined || t.ms === ms),
    );
  }
  fire(timer: FakeTimer): void {
    timer.fired = true;
    timer.fn();
  }
}

async function until(pred: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (pred()) return;
    await Bun.sleep(1);
  }
  throw new Error(`timed out: ${label}`);
}

function setup(
  opts: { repos?: string[]; link?: Partial<GithubLinkInput> } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "github-sync-test-"));
  roots.push(root);
  const db = openOfficeDatabase(join(root, "office.sqlite"));
  handles.push(db);
  const links = createGithubLinkStore(db);
  const gh = new FakeGithub(opts.repos);
  const tasks = new FakeTasks();
  const scheduler = new FakeScheduler();
  const rooms = new Set(["room-1", "room-2"]);
  let secret: { value: string; hosts: string[]; updatedAt: number } | null = {
    value: gh.token,
    hosts: ["api.github.com"],
    updatedAt: 1,
  };
  const secretReads: string[] = [];
  const sync = createGithubSync({
    db,
    links,
    tasks,
    fetch: gh.fetch as unknown as typeof fetch,
    scheduler,
    now: () => gh.clock,
    readSecret: (name) => {
      secretReads.push(name);
      return name === DEFAULT_GITHUB_SYNC_SECRET && secret
        ? { ...secret, hosts: [...secret.hosts] }
        : null;
    },
    roomExists: (id) => rooms.has(id),
  });
  const saved = links.set(
    "room-1",
    { repo: "Acme/Widgets", labels: ["isomux"], ...opts.link },
    "user-1",
  );
  if (!saved.ok) throw new Error(`link not saved: ${saved.message}`);
  return {
    db,
    links,
    gh,
    tasks,
    scheduler,
    rooms,
    sync,
    secretReads,
    setSecret(next: typeof secret) {
      secret = next;
    },
    status: () => links.get("room-1")!.status,
  };
}

const labelled = (fields: Partial<FakeIssue> = {}): Partial<FakeIssue> => ({
  labels: ["isomux"],
  ...fields,
});

describe("link store", () => {
  it("rejects a bad repo, labels or secret name, and fills the defaults", () => {
    const { links } = setup();
    const bad: unknown[] = [
      { repo: "acme", labels: ["a"] },
      { repo: "acme/", labels: ["a"] },
      { repo: "/widgets", labels: ["a"] },
      { repo: "ac me/widgets", labels: ["a"] },
      { repo: "acme/wid/gets", labels: ["a"] },
      { repo: "acme/.", labels: ["a"] },
      { repo: "acme/..", labels: ["a"] },
      { repo: `${"a".repeat(40)}/widgets`, labels: ["a"] },
      { repo: `acme/${"w".repeat(101)}`, labels: ["a"] },
      { repo: "acme/gadgets", labels: [] },
      { repo: "acme/gadgets", labels: ["  "] },
      { repo: "acme/gadgets", labels: ["x".repeat(51)] },
      {
        repo: "acme/gadgets",
        labels: Array.from({ length: 21 }, (_, i) => `l${i}`),
      },
      { repo: "acme/gadgets", labels: ["a"], secretName: "bad name" },
      { repo: "acme/gadgets", labels: "a" },
      { labels: ["a"] },
    ];
    for (const input of bad) {
      const result = links.set("room-2", input, "user-1");
      expect({ input, result }).toMatchObject({
        input,
        result: { ok: false, status: 400, code: "invalid_request" },
      });
    }
    expect(links.get("room-2")).toBeNull();

    const good = links.set(
      "room-2",
      {
        repo: "Acme/Gadgets.js",
        labels: [`${"x".repeat(50)}`, ...Array.from({ length: 19 }, String)],
      },
      "user-2",
    );
    expect(good.ok).toBe(true);
    expect(links.get("room-2")).toMatchObject({
      roomId: "room-2",
      repo: "Acme/Gadgets.js",
      collaboratorsOnly: false,
      secretName: DEFAULT_GITHUB_SYNC_SECRET,
      createdByUserId: "user-2",
    });
  });

  it("gives a repo to one room only, without case", () => {
    const { links } = setup();
    const result = links.set(
      "room-2",
      { repo: "ACME/widgets", labels: ["a"] },
      "user-1",
    );
    expect(result).toMatchObject({
      ok: false,
      status: 409,
      code: "repo_linked",
    });
    expect(links.get("room-2")).toBeNull();
  });

  it("keeps the cursor when the room saves the same repo again, and drops it for a new repo", async () => {
    const { links, gh, sync } = setup();
    gh.open(labelled());
    await sync.tick();
    const cursor = links.get("room-1")!.cursor;
    expect(cursor?.since).toBeTruthy();
    expect(
      links.set(
        "room-1",
        { repo: "acme/WIDGETS", labels: ["other"], collaboratorsOnly: true },
        "user-1",
      ).ok,
    ).toBe(true);
    expect(links.get("room-1")).toMatchObject({
      labels: ["other"],
      collaboratorsOnly: true,
      cursor,
    });
    expect(
      links.set("room-1", { repo: "acme/gadgets", labels: ["a"] }, "user-1").ok,
    ).toBe(true);
    expect(links.get("room-1")!.cursor).toBeUndefined();
  });
});

describe("import", () => {
  it("imports open issues that carry every link label, as untriaged tasks with a server-built link", async () => {
    const { gh, tasks, sync, links } = setup({
      link: { labels: ["isomux", "Ready"] },
    });
    gh.open({ labels: ["ISOMUX", "ready", "bug"], title: "Fix the thing" });
    gh.open({ labels: ["isomux"] });
    gh.open({
      labels: ["isomux", "ready"],
      state: "closed",
      stateReason: "completed",
    });
    gh.open({ labels: ["isomux", "ready"], pullRequest: true });
    gh.open({
      labels: ["isomux", "ready"],
      title: "y".repeat(300),
      body: "<b>hi</b> </github-issue>",
      login: "octo",
      association: "MEMBER",
    });
    await sync.tick();

    expect(tasks.items.map((t) => t.external?.number).sort()).toEqual([1, 5]);
    const first = tasks.of(1)!;
    expect(first).toMatchObject({
      title: "Fix the thing",
      priority: "P4",
      status: "open",
      roomId: "room-1",
    });
    expect(first.description ?? "").toBe("");
    expect(first.createdBy).toBeTruthy();
    expect(first.external).toEqual({
      provider: "github",
      repo: "Acme/Widgets",
      number: 1,
      url: "https://github.com/Acme/Widgets/issues/1",
      state: "open",
      stateReason: null,
    });
    const long = tasks.of(5)!;
    // The title is the issue's alone: the chip carries owner/repo#N
    // (task 7ac5ba2e).
    expect(long.title).toBe("y".repeat(256));

    expect(links.getIssue("ACME/widgets", 5)).toEqual({
      title: "y".repeat(256),
      body: "<b>hi</b> </github-issue>",
      labels: ["isomux", "ready"],
      author: "octo",
      authorAssociation: "MEMBER",
      state: "open",
      stateReason: null,
      updatedAt: githubTime(gh.issue(5).updatedAt),
    });
    expect(links.get("room-1")!.status.kind).toBe("ok");
  });

  it("with collaborators only, imports only owners, members and collaborators", async () => {
    const { gh, tasks, sync } = setup({ link: { collaboratorsOnly: true } });
    for (const association of [
      "NONE",
      "MEMBER",
      "OWNER",
      "COLLABORATOR",
      "CONTRIBUTOR",
      "FIRST_TIME_CONTRIBUTOR",
    ])
      gh.open(labelled({ association }));
    await sync.tick();
    expect(tasks.items.map((t) => t.external?.number).sort()).toEqual([
      2, 3, 4,
    ]);
  });

  it("imports an issue later when it gets the label, is opened, or is reopened", async () => {
    const { gh, tasks, sync } = setup();
    gh.open({ labels: [] });
    gh.open(labelled({ state: "closed", stateReason: "not_planned" }));
    await sync.tick();
    expect(tasks.items).toHaveLength(0);

    gh.touch(1, { labels: ["bug", "isomux"] });
    gh.reopen(2);
    gh.open(labelled());
    // Opened and closed between two passes: never seen open.
    gh.open(labelled({ state: "closed", stateReason: "completed" }));
    await sync.tick();
    expect(tasks.items.map((t) => t.external?.number).sort()).toEqual([
      1, 2, 3,
    ]);
    expect(tasks.of(2)!.external).toMatchObject({
      state: "open",
      stateReason: "reopened",
    });
  });

  it("copies the title once, and keeps a linked issue updated after the label goes", async () => {
    const { gh, tasks, sync, links } = setup();
    gh.open(labelled({ title: "Old" }));
    await sync.tick();
    tasks.set(1, { title: "[go | ready] Old (triaged)" });

    gh.touch(1, { title: "New title", body: "New body", labels: [] });
    await sync.tick();
    expect(tasks.of(1)!.title).toBe("[go | ready] Old (triaged)");
    expect(links.getIssue("acme/widgets", 1)).toMatchObject({
      title: "New title",
      body: "New body",
      labels: [],
    });

    gh.close(1, "completed");
    await sync.tick();
    expect(tasks.of(1)!.status).toBe("done");
  });

  it("does not import an issue again after a member deletes its task", async () => {
    const { gh, tasks, sync } = setup();
    gh.open(labelled());
    await sync.tick();
    tasks.remove(1);
    gh.comment(1);
    await sync.tick();
    gh.close(1, "completed");
    await sync.tick();
    gh.reopen(1);
    await sync.tick();
    expect(tasks.items).toHaveLength(0);
  });

  it("loses no issue when the task write fails, in the first pass or a later one", async () => {
    const { gh, tasks, sync } = setup();
    gh.open(labelled());
    tasks.failAdds = 1;
    await sync.tick();
    expect(tasks.items).toHaveLength(0);
    await sync.tick();
    expect(tasks.of(1)).toBeDefined();

    gh.open({ labels: [] });
    await sync.tick();
    gh.touch(2, { labels: ["isomux"] });
    tasks.failAdds = 1;
    await sync.tick();
    expect(tasks.of(2)).toBeUndefined();
    await sync.tick();
    expect(tasks.of(2)).toBeDefined();
    expect(tasks.items).toHaveLength(2);
  });
});

describe("status", () => {
  async function linked(...issues: Partial<FakeIssue>[]) {
    const env = setup();
    for (const fields of issues) env.gh.open(labelled(fields));
    if (issues.length === 0) env.gh.open(labelled());
    await env.sync.tick();
    return env;
  }

  // [the task's status when GitHub changes, the close reason, the status after]
  const closes: [TaskStatus, string | null, TaskStatus][] = [
    ["open", "completed", "done"],
    ["in_progress", "completed", "done"],
    ["obsolete", "completed", "done"],
    ["open", null, "done"],
    ["in_progress", null, "done"],
    ["open", "not_planned", "obsolete"],
    ["open", "duplicate", "obsolete"],
    ["in_progress", "not_planned", "in_progress"],
    ["in_progress", "duplicate", "in_progress"],
    ["done", "not_planned", "done"],
  ];
  for (const [before, reason, after] of closes) {
    it(`a close as ${reason} takes a ${before} task to ${after}, and the task shows the close`, async () => {
      const { gh, tasks, sync } = await linked();
      tasks.set(1, { status: before });
      gh.close(1, reason);
      await sync.tick();
      expect(tasks.of(1)!.status).toBe(after);
      expect(tasks.of(1)!.external).toMatchObject({
        state: "closed",
        stateReason: reason,
      });
    });
  }

  // [the close before, the task's status when GitHub reopens, the status after]
  const reopens: [string, TaskStatus, TaskStatus][] = [
    ["completed", "done", "open"],
    ["not_planned", "obsolete", "open"],
    ["completed", "obsolete", "open"],
    ["completed", "in_progress", "in_progress"],
    ["completed", "open", "open"],
  ];
  for (const [reason, before, after] of reopens) {
    it(`a reopen after a ${reason} close takes a ${before} task to ${after}`, async () => {
      const { gh, tasks, sync } = await linked();
      gh.close(1, reason);
      await sync.tick();
      tasks.set(1, { status: before });
      gh.reopen(1);
      await sync.tick();
      expect(tasks.of(1)!.status).toBe(after);
      expect(tasks.of(1)!.external).toMatchObject({
        state: "open",
        stateReason: "reopened",
      });
    });
  }

  it("acts on a change of state only: a member's status stands through comments and edits", async () => {
    const { gh, tasks, sync } = await linked({}, {});
    // GitHub closed #1; the member reopened its task.
    gh.close(1, "completed");
    await sync.tick();
    tasks.set(1, { status: "open" });
    // #2 is open on GitHub; the member closed its task.
    tasks.set(2, { status: "done" });
    gh.comment(1);
    gh.touch(2, { body: "edited" });
    await sync.tick();
    gh.touch(1, { labels: ["isomux", "bug"] });
    gh.comment(2);
    await sync.tick();
    expect(tasks.of(1)!.status).toBe("open");
    expect(tasks.of(2)!.status).toBe("done");
  });

  it("follows a task that a member moved to another room", async () => {
    const { gh, tasks, sync } = await linked();
    tasks.set(1, { roomId: "room-2" });
    gh.close(1, "completed");
    await sync.tick();
    expect(tasks.of(1)!.status).toBe("done");
    expect(tasks.items).toHaveLength(1);
  });
});

describe("polling", () => {
  it("sends the last ETag and writes nothing on 304", async () => {
    const { gh, tasks, sync } = setup();
    gh.open(labelled());
    await sync.tick();
    await sync.tick();
    const before = JSON.stringify(tasks.items);
    const from = gh.requests.length;
    await sync.tick();
    const third = gh.requests.slice(from);
    expect(third.length).toBeGreaterThan(0);
    expect(third.map((r) => r.status)).toEqual(third.map(() => 304));
    expect(third.every((r) => r.headers.get("if-none-match"))).toBe(true);
    expect(JSON.stringify(tasks.items)).toBe(before);
  });

  it("first pass: an issue that changes during the walk is picked up next pass", async () => {
    const { gh, tasks, sync } = setup();
    for (let i = 0; i < 150; i++) gh.open(labelled());
    let closed = 0;
    gh.afterServe = (request) => {
      if (closed || request.served.length === 0) return;
      // After the first page: an issue it carried closes, then an issue it
      // did not carry gets a comment.
      closed = request.served[0];
      gh.close(closed, "completed");
      const later = gh.issues().find((i) => !request.served.includes(i.number));
      gh.comment(later!.number);
    };
    await sync.tick();
    expect(closed).toBeGreaterThan(0);
    expect(tasks.items).toHaveLength(150);
    gh.afterServe = null;
    await sync.tick();
    await sync.tick();
    expect(tasks.of(closed)!.status).toBe("done");
  });

  it("later passes: an issue that changes between two pages makes no other issue skip", async () => {
    const { gh, tasks, sync } = setup();
    for (let i = 0; i < 150; i++) gh.open(labelled());
    await sync.tick();
    expect(tasks.items).toHaveLength(150);
    for (let n = 1; n <= 150; n++) gh.close(n, "completed");
    let moved = 0;
    gh.afterServe = (request) => {
      if (moved || request.served.length === 0) return;
      // An issue the first page carried gets a comment, which moves it to the
      // end of the updated order.
      moved = request.served[0];
      gh.comment(moved);
    };
    await sync.tick();
    gh.afterServe = null;
    await sync.tick();
    expect(moved).toBeGreaterThan(0);
    const open = tasks.items
      .filter((t) => t.status !== "done")
      .map((t) => t.external!.number);
    expect(open).toEqual([]);
  });

  it("does not stall when more than a page of issues share one updated_at", async () => {
    const { gh, tasks, sync } = setup();
    for (let i = 0; i < 150; i++) gh.open({ labels: [] });
    await sync.tick();
    const at = gh.advance();
    for (const issue of gh.issues())
      Object.assign(issue, { labels: ["isomux"], updatedAt: at });
    await sync.tick();
    await sync.tick();
    expect(tasks.items).toHaveLength(150);
  });

  it("runs one pass at a time", async () => {
    const { gh, sync } = setup();
    gh.open(labelled());
    let release!: () => void;
    gh.gate = new Promise<void>((r) => (release = r));
    const a = sync.tick();
    const b = sync.tick();
    await until(() => gh.requests.length > 0, "first request");
    await Bun.sleep(5);
    expect(gh.requests).toHaveLength(1);
    release();
    await Promise.all([a, b]);
    expect(gh.requests).toHaveLength(1);
  });

  it("a pass that was running when the room changed repo leaves the new repo's walk alone", async () => {
    const env = setup({ repos: ["acme/widgets", "acme/gadgets"] });
    const { gh, links, tasks, sync } = env;
    gh.open(labelled(), "acme/gadgets");
    gh.open(labelled());
    // The widgets answer is dated after every issue on either repo.
    gh.advance(10);
    let release!: () => void;
    gh.gate = new Promise<void>((r) => (release = r));
    const pass = sync.tick();
    await until(() => gh.requests.length > 0, "widgets request");
    expect(
      links.set("room-1", { repo: "acme/gadgets", labels: ["isomux"] }, "u").ok,
    ).toBe(true);
    release();
    await pass;
    gh.gate = null;
    await sync.tick();
    expect(gh.requestsFor("acme/gadgets").length).toBeGreaterThan(0);
    expect(tasks.of(1, "acme/gadgets")).toBeDefined();
    expect(links.get("room-1")).toMatchObject({ repo: "acme/gadgets" });
  });

  it("a request that never answers times out, and the other links still run", async () => {
    const env = setup({ repos: ["acme/widgets", "acme/gadgets"] });
    const { gh, links, tasks, sync, scheduler } = env;
    expect(
      links.set("room-2", { repo: "acme/gadgets", labels: ["isomux"] }, "u").ok,
    ).toBe(true);
    gh.open(labelled(), "acme/gadgets");
    gh.hang.add("acme/widgets");
    const pass = sync.tick();
    await until(
      () => gh.requestsFor("acme/widgets").length > 0,
      "widgets request",
    );
    await Bun.sleep(5);
    const timeout = scheduler.pending(GITHUB_FETCH_TIMEOUT_MS);
    expect(timeout).toHaveLength(1);
    scheduler.fire(timeout[0]);
    await pass;
    expect(tasks.of(1, "acme/gadgets")).toBeDefined();
    expect(env.status()).toMatchObject({ kind: "error", reason: "network" });
  });

  it("start runs a pass on the scheduler and schedules the next; stop clears it", async () => {
    const { gh, sync, scheduler } = setup();
    gh.open(labelled());
    const passTimers = () =>
      scheduler.pending().filter((t) => t.ms !== GITHUB_FETCH_TIMEOUT_MS);
    sync.start();
    await until(() => passTimers().length === 1, "a pass scheduled");
    expect(passTimers()[0].ms).toBeLessThanOrEqual(GITHUB_SYNC_INTERVAL_MS);
    scheduler.fire(passTimers()[0]);
    await until(
      () =>
        gh.requests.length > 0 &&
        scheduler.pending(GITHUB_SYNC_INTERVAL_MS).length === 1,
      "a pass ran and the next is scheduled",
    );
    expect(passTimers()).toHaveLength(1);
    sync.stop();
    expect(scheduler.pending()).toHaveLength(0);
  });
});

describe("link health", () => {
  it("a missing secret pauses the link without a request; the secret's arrival resumes it", async () => {
    const env = setup();
    env.gh.open(labelled());
    env.setSecret(null);
    await env.sync.tick();
    expect(env.status()).toMatchObject({ kind: "paused", reason: "missing" });
    expect(env.secretReads).toContain(DEFAULT_GITHUB_SYNC_SECRET);
    expect(env.gh.requests).toHaveLength(0);
    env.setSecret({
      value: env.gh.token,
      hosts: ["api.github.com"],
      updatedAt: 5,
    });
    await env.sync.tick();
    expect(env.tasks.of(1)).toBeDefined();
    expect(env.status().kind).toBe("ok");
  });

  it("a secret not allowed for api.github.com is never sent", async () => {
    const env = setup();
    env.gh.open(labelled());
    env.setSecret({
      value: env.gh.token,
      hosts: ["github.com", "evil.example"],
      updatedAt: 2,
    });
    await env.sync.tick();
    await env.sync.tick();
    expect(env.status()).toMatchObject({ kind: "paused", reason: "host" });
    expect(env.gh.requests).toHaveLength(0);
    env.setSecret({
      value: env.gh.token,
      hosts: ["api.github.com"],
      updatedAt: 3,
    });
    await env.sync.tick();
    expect(env.tasks.of(1)).toBeDefined();
  });

  it("a refused token pauses until the owner replaces it; a rotate resumes", async () => {
    const env = setup();
    env.gh.open(labelled());
    env.setSecret({ value: "wrong", hosts: ["api.github.com"], updatedAt: 2 });
    await env.sync.tick();
    expect(env.status()).toMatchObject({
      kind: "paused",
      reason: "refused",
      secretUpdatedAt: 2,
    });
    const tried = env.gh.requests.length;
    expect(tried).toBeGreaterThan(0);
    await env.sync.tick();
    await env.sync.tick();
    expect(env.gh.requests).toHaveLength(tried);
    // A rotate keeps the placeholder generation; only updatedAt moves.
    env.setSecret({
      value: env.gh.token,
      hosts: ["api.github.com"],
      updatedAt: 3,
    });
    await env.sync.tick();
    expect(env.tasks.of(1)).toBeDefined();
    expect(env.status().kind).toBe("ok");
  });

  it("no access (404, or 403 without a rate-limit sign) pauses until the link is saved again", async () => {
    for (const status of [404, 403]) {
      const env = setup();
      env.gh.open(labelled());
      env.gh.override = () =>
        Response.json(
          { message: "nope" },
          { status, headers: { "x-ratelimit-remaining": "4000" } },
        );
      await env.sync.tick();
      expect({ status, link: env.status() }).toMatchObject({
        status,
        link: { kind: "paused", reason: "no_access" },
      });
      const tried = env.gh.requests.length;
      await env.sync.tick();
      expect(env.gh.requests).toHaveLength(tried);
      env.gh.override = null;
      expect(
        env.links.set(
          "room-1",
          { repo: "Acme/Widgets", labels: ["isomux"] },
          "user-1",
        ).ok,
      ).toBe(true);
      await env.sync.tick();
      expect(env.tasks.of(1)).toBeDefined();
    }
  });

  it("a rate limit waits until GitHub's reset, at most an hour", async () => {
    const env = setup();
    env.gh.open(labelled());
    const resetIn = (seconds: number) => () =>
      Response.json(
        { message: "API rate limit exceeded" },
        {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(
              Math.floor(env.gh.clock / 1000) + seconds,
            ),
          },
        },
      );
    env.gh.override = resetIn(600);
    const start = env.gh.clock;
    await env.sync.tick();
    expect(env.status()).toMatchObject({
      kind: "waiting",
      reason: "rate_limit",
    });
    expect(env.status().until).toBeGreaterThanOrEqual(start + 599_000);
    env.gh.override = null;
    const tried = env.gh.requests.length;
    env.gh.advance(300);
    await env.sync.tick();
    expect(env.gh.requests).toHaveLength(tried);
    env.gh.advance(301);
    await env.sync.tick();
    expect(env.tasks.of(1)).toBeDefined();

    env.gh.override = resetIn(10 * 3600);
    env.gh.comment(1);
    const at = env.gh.clock;
    await env.sync.tick();
    expect(env.status().kind).toBe("waiting");
    expect(env.status().until).toBeLessThanOrEqual(at + GITHUB_MAX_WAIT_MS);
  });

  it("a 429 waits for Retry-After", async () => {
    const env = setup();
    env.gh.open(labelled());
    env.gh.override = () =>
      new Response("slow down", {
        status: 429,
        headers: { "retry-after": "120" },
      });
    await env.sync.tick();
    expect(env.status()).toMatchObject({
      kind: "waiting",
      reason: "rate_limit",
    });
    env.gh.override = null;
    const tried = env.gh.requests.length;
    env.gh.advance(60);
    await env.sync.tick();
    expect(env.gh.requests).toHaveLength(tried);
    env.gh.advance(61);
    await env.sync.tick();
    expect(env.tasks.of(1)).toBeDefined();
  });

  it("a server error or a network failure is shown and tried again next pass", async () => {
    const env = setup();
    env.gh.open(labelled());
    env.gh.override = () => new Response("boom", { status: 502 });
    await env.sync.tick();
    expect(env.status()).toMatchObject({ kind: "error", reason: "server" });
    env.gh.override = () => {
      throw new TypeError("fetch failed");
    };
    await env.sync.tick();
    expect(env.status()).toMatchObject({ kind: "error", reason: "network" });
    env.gh.override = null;
    await env.sync.tick();
    expect(env.tasks.of(1)).toBeDefined();
    expect(env.status().kind).toBe("ok");
  });

  it("drops a link whose room is gone, and an unlinked repo is not polled; tasks stay", async () => {
    const env = setup({ repos: ["acme/widgets", "acme/gadgets"] });
    expect(
      env.links.set("room-2", { repo: "acme/gadgets", labels: ["isomux"] }, "u")
        .ok,
    ).toBe(true);
    env.gh.open(labelled());
    env.gh.open(labelled(), "acme/gadgets");
    await env.sync.tick();
    expect(env.tasks.items).toHaveLength(2);

    env.rooms.delete("room-1");
    expect(env.links.remove("room-2")).toBe(true);
    const tried = env.gh.requests.length;
    env.gh.close(1, "completed");
    await env.sync.tick();
    expect(env.links.get("room-1")).toBeNull();
    expect(env.links.list()).toEqual([]);
    expect(env.gh.requests).toHaveLength(tried);
    expect(env.tasks.items).toHaveLength(2);
    expect(env.tasks.of(1)!.status).toBe("open");
  });
});

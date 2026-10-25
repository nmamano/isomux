// GitHub issues into the task board (task 7fc83592): an office owner links one
// repo to one room, and this poller imports the labelled issues as tasks and
// follows their open/closed state. Nothing writes to GitHub.
import type { Database } from "bun:sqlite";
import type {
  GithubLinkStatus,
  GithubLinkWire,
  TaskExternal,
  TaskItem,
  TaskPriority,
  TaskStatus,
} from "../shared/types.ts";
import type { GithubIssueData } from "../shared/github-issue.ts";
import type { AuditActor } from "../shared/audit.ts";
import { checkSecretName } from "../shared/secret-hosts.ts";
import { withAuditContextSync } from "./audit-context.ts";

export const GITHUB_SYNC_INTERVAL_MS = 2 * 60 * 1000;
export const GITHUB_FETCH_TIMEOUT_MS = 30 * 1000;
export const GITHUB_MAX_WAIT_MS = 60 * 60 * 1000;
export const DEFAULT_GITHUB_SYNC_SECRET = "GITHUB_SYNC_TOKEN";

// The stored link: the wire shape plus the poll state. cursor is set once the
// first pass over the open issues ends; until then walk holds its progress
// and the Date of its first answer, which becomes the cursor.
export interface GithubLink extends GithubLinkWire {
  cursor?: { since: string; etag?: string };
  walk?: { since?: string; date: string };
}

// PUT /api/rooms/:roomId/github-link body, before validation.
export interface GithubLinkInput {
  repo: string;
  labels: string[];
  collaboratorsOnly?: boolean;
  secretName?: string;
}

export type GithubLinkSetResult =
  | { ok: true; link: GithubLink }
  | {
      ok: false;
      status: 400 | 409;
      code: "invalid_request" | "repo_linked";
      message: string;
    };

export interface GithubLinkStore {
  list(): GithubLink[];
  get(roomId: string): GithubLink | null;
  // Creates or replaces the room's link. The same repo keeps the id, the
  // creator and the cursor; a new repo is a new link. Saving clears a pause.
  set(roomId: string, input: unknown, userId: string): GithubLinkSetResult;
  remove(roomId: string): boolean;
  saveCursor(linkId: string, cursor: GithubLink["cursor"]): void;
  saveStatus(linkId: string, status: GithubLinkStatus): void;
  // repo is matched without case.
  getIssue(repo: string, number: number): GithubIssueData | null;
  putIssue(repo: string, number: number, data: GithubIssueData): void;
  // The first pass's progress, kept until saveCursor ends it.
  saveWalk(linkId: string, walk: NonNullable<GithubLink["walk"]>): void;
}

const GITHUB_HOST = "api.github.com";
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const MAX_LINK_LABELS = 20;
const MAX_LABEL_LENGTH = 50;
const MAX_ISSUE_LABELS = 100;
const MAX_TITLE_LENGTH = 256;
const MAX_BODY_LENGTH = 65536;
const PER_PAGE = 100;
const MAX_REQUESTS_PER_PASS = 10;
const FIRST_DELAY_MS = 5000;
const DEFAULT_WAIT_MS = 60 * 1000;
const COLLABORATORS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const REASONS = new Set(["completed", "not_planned", "duplicate", "reopened"]);

const repoKey = (repo: string) => repo.toLowerCase();

export function toLinkWire(link: GithubLink): GithubLinkWire {
  const { cursor: _cursor, walk: _walk, ...wire } = link;
  return wire;
}

function invalid(message: string): GithubLinkSetResult {
  return { ok: false, status: 400, code: "invalid_request", message };
}

// Tables live in office.sqlite, so rows, tasks and cursors commit together.
export function createGithubLinkStore(db: Database): GithubLinkStore {
  const read = (row: { record: string } | null) =>
    row ? (JSON.parse(row.record) as GithubLink) : null;
  function write(link: GithubLink): void {
    db.query(
      `INSERT INTO github_links(id,room_id,repo_key,record) VALUES (?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET room_id=excluded.room_id,
       repo_key=excluded.repo_key, record=excluded.record`,
    ).run(link.id, link.roomId, repoKey(link.repo), JSON.stringify(link));
  }
  function byId(id: string): GithubLink | null {
    return read(
      db.query("SELECT record FROM github_links WHERE id=?").get(id) as {
        record: string;
      } | null,
    );
  }
  function getByRoom(roomId: string): GithubLink | null {
    return read(
      db
        .query("SELECT record FROM github_links WHERE room_id=?")
        .get(roomId) as { record: string } | null,
    );
  }
  function patch(id: string, change: (link: GithubLink) => void): void {
    const link = byId(id);
    if (!link) return;
    change(link);
    write(link);
  }
  return {
    list: () =>
      (
        db.query("SELECT record FROM github_links ORDER BY rowid").all() as {
          record: string;
        }[]
      ).map((row) => read(row)!),
    get: getByRoom,
    set(roomId, input, userId) {
      if (!input || typeof input !== "object")
        return invalid("body must be an object");
      const body = input as Record<string, unknown>;
      if (typeof body.repo !== "string") return invalid("repo is required");
      const repo = body.repo.trim();
      const name = repo.split("/")[1];
      if (!REPO.test(repo) || name === "." || name === "..")
        return invalid("repo must be owner/name");
      if (!Array.isArray(body.labels) || body.labels.length === 0)
        return invalid("labels must be a list of at least one label");
      if (body.labels.length > MAX_LINK_LABELS)
        return invalid(`at most ${MAX_LINK_LABELS} labels`);
      const labels: string[] = [];
      for (const label of body.labels) {
        const trimmed = typeof label === "string" ? label.trim() : "";
        if (!trimmed || trimmed.length > MAX_LABEL_LENGTH)
          return invalid(`each label is 1 to ${MAX_LABEL_LENGTH} characters`);
        labels.push(trimmed);
      }
      if (
        body.collaboratorsOnly !== undefined &&
        typeof body.collaboratorsOnly !== "boolean"
      )
        return invalid("collaboratorsOnly must be a boolean");
      const secretName = body.secretName ?? DEFAULT_GITHUB_SYNC_SECRET;
      if (checkSecretName(secretName))
        return invalid("secretName is not a valid secret name");
      return db.transaction((): GithubLinkSetResult => {
        const other = db
          .query("SELECT room_id FROM github_links WHERE repo_key=?")
          .get(repoKey(repo)) as { room_id: string } | null;
        if (other && other.room_id !== roomId)
          return {
            ok: false,
            status: 409,
            code: "repo_linked",
            message: "another room is linked to this repo",
          };
        const current = getByRoom(roomId);
        const sameRepo = current && repoKey(current.repo) === repoKey(repo);
        // A new repo is a new link with a new id: a pass still running for
        // the old repo writes by id, and finds nothing.
        if (current && !sameRepo)
          db.query("DELETE FROM github_links WHERE id=?").run(current.id);
        const kept = sameRepo ? current : null;
        const link: GithubLink = {
          id: kept?.id ?? crypto.randomUUID().replace(/-/g, "").slice(0, 12),
          roomId,
          repo,
          labels,
          collaboratorsOnly: body.collaboratorsOnly === true,
          secretName: secretName as string,
          createdByUserId: kept?.createdByUserId ?? userId,
          createdAt: kept?.createdAt ?? Date.now(),
          // Saving clears a pause: the owner may have fixed the access.
          status: { kind: "pending" },
          ...(kept?.cursor ? { cursor: kept.cursor } : {}),
          ...(kept?.walk ? { walk: kept.walk } : {}),
        };
        write(link);
        return { ok: true, link };
      })();
    },
    remove: (roomId) =>
      db.query("DELETE FROM github_links WHERE room_id=?").run(roomId).changes >
      0,
    saveCursor(linkId, cursor) {
      patch(linkId, (link) => {
        if (cursor) link.cursor = cursor;
        else delete link.cursor;
        delete link.walk;
      });
    },
    saveStatus(linkId, status) {
      patch(linkId, (link) => {
        link.status = status;
      });
    },
    getIssue: (repo, number) =>
      read(
        db
          .query(
            "SELECT record FROM github_issues WHERE repo_key=? AND number=?",
          )
          .get(repoKey(repo), number) as { record: string } | null,
      ) as GithubIssueData | null,
    putIssue(repo, number, data) {
      db.query(
        `INSERT INTO github_issues(repo_key,number,record) VALUES (?,?,?)
         ON CONFLICT(repo_key,number) DO UPDATE SET record=excluded.record`,
      ).run(repoKey(repo), number, JSON.stringify(data));
    },
    saveWalk(linkId, walk) {
      patch(linkId, (link) => {
        link.walk = walk;
      });
    },
  };
}

export interface GithubSyncTasks {
  list(): TaskItem[];
  add(
    title: string,
    createdBy: string,
    opts: { priority: TaskPriority; roomId: string; external: TaskExternal },
  ): TaskItem;
  update(
    id: string,
    changes: { status?: TaskStatus; external?: TaskExternal },
  ): TaskItem | null;
}

// The pass interval and each request's GITHUB_FETCH_TIMEOUT_MS timeout both run
// on this scheduler, so a test can fire either.
export interface GithubSyncScheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface GithubSyncDeps {
  db: Database;
  links: GithubLinkStore;
  tasks: GithubSyncTasks;
  fetch: typeof fetch;
  scheduler: GithubSyncScheduler;
  now: () => number;
  // An office secret by name, or null when there is none. updatedAt moves on
  // every change to the secret (a new value, hosts, note); a paused link tries
  // again when it moves. The generation does not: a rotate keeps it.
  readSecret: (
    name: string,
  ) => { value: string; hosts: string[]; updatedAt: number } | null;
  roomExists: (roomId: string) => boolean;
}

export interface GithubSync {
  start(): void;
  stop(): void;
  // One pass over every link. A pass that starts while one runs returns the
  // running one.
  tick(): Promise<void>;
}

// GitHub's timestamp form: ISO 8601 in whole seconds.
function githubTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function labelName(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const name = (value as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return null;
}

// One item of the issues list as the row stores it, or null when it is a pull
// request or not an issue at all. Every field is checked and bounded.
function issueOf(
  item: unknown,
): { number: number; data: GithubIssueData } | null {
  if (!item || typeof item !== "object") return null;
  const i = item as Record<string, unknown>;
  if (i.pull_request !== undefined) return null;
  const number = i.number;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1)
    return null;
  if (
    typeof i.updated_at !== "string" ||
    Number.isNaN(Date.parse(i.updated_at))
  )
    return null;
  const user = i.user as { login?: unknown } | null | undefined;
  const reason =
    typeof i.state_reason === "string" && REASONS.has(i.state_reason)
      ? (i.state_reason as GithubIssueData["stateReason"])
      : null;
  return {
    number,
    data: {
      title: (typeof i.title === "string" ? i.title : "").slice(
        0,
        MAX_TITLE_LENGTH,
      ),
      body: (typeof i.body === "string" ? i.body : "").slice(
        0,
        MAX_BODY_LENGTH,
      ),
      labels: (Array.isArray(i.labels) ? i.labels : [])
        .map(labelName)
        .filter((name): name is string => name !== null)
        .slice(0, MAX_ISSUE_LABELS)
        .map((name) => name.slice(0, MAX_LABEL_LENGTH)),
      author: typeof user?.login === "string" ? user.login : "",
      authorAssociation:
        typeof i.author_association === "string" ? i.author_association : "",
      state: i.state === "closed" ? "closed" : "open",
      stateReason: reason,
      updatedAt: i.updated_at,
    },
  };
}

// The board status a change of GitHub state asks for, or undefined to keep
// the member's. Last transition wins: this runs only when the state changed.
function statusFor(
  status: TaskStatus,
  data: Pick<GithubIssueData, "state" | "stateReason">,
): TaskStatus | undefined {
  if (data.state === "open")
    return status === "done" || status === "obsolete" ? "open" : undefined;
  if (data.stateReason === "not_planned" || data.stateReason === "duplicate")
    return status === "open" ? "obsolete" : undefined;
  return status === "done" ? undefined : "done";
}

// A wait GitHub asked for, in ms from now, capped at GITHUB_MAX_WAIT_MS.
function waitFor(headers: Headers, now: number): number {
  const retry = headers.get("retry-after");
  let until: number | null = null;
  if (retry !== null) {
    const seconds = Number(retry);
    until = Number.isFinite(seconds)
      ? now + seconds * 1000
      : Date.parse(retry) || null;
  }
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (until === null && Number.isFinite(reset) && reset > 0)
    until = reset * 1000;
  const wait = until === null ? DEFAULT_WAIT_MS : until - now;
  return Math.min(Math.max(wait, 1000), GITHUB_MAX_WAIT_MS);
}

class PassStop extends Error {
  constructor(readonly status: GithubLinkStatus | null) {
    super("github sync: pass stopped");
  }
}

export function createGithubSync(deps: GithubSyncDeps): GithubSync {
  let timer: unknown = null;
  let running: Promise<void> | null = null;
  let stopped = true;
  const inFlight = new Set<{ controller: AbortController; timer: unknown }>();

  function actorFor(link: GithubLink): AuditActor {
    return {
      kind: "github_sync",
      id: link.id,
      name: link.repo,
      ownerId: link.createdByUserId,
    };
  }

  function taskFor(repo: string, number: number): TaskItem | undefined {
    const key = repoKey(repo);
    return deps.tasks
      .list()
      .find(
        (t) =>
          t.external?.provider === "github" &&
          t.external.number === number &&
          repoKey(t.external.repo) === key,
      );
  }

  // One issue: its row and its task commit together, the task write last, so
  // a failed task write leaves no row that would mark the issue as seen.
  function apply(link: GithubLink, number: number, data: GithubIssueData) {
    const row = deps.links.getIssue(link.repo, number);
    if (row && row.updatedAt === data.updatedAt) return;
    const task = taskFor(link.repo, number);
    if (!row && !task) {
      if (data.state !== "open") return;
      const have = new Set(data.labels.map((l) => l.toLowerCase()));
      if (!link.labels.every((l) => have.has(l.toLowerCase()))) return;
      if (link.collaboratorsOnly && !COLLABORATORS.has(data.authorAssociation))
        return;
      deps.db.transaction(() => {
        deps.links.putIssue(link.repo, number, data);
        withAuditContextSync(actorFor(link), "githubSync.import", () =>
          // The bare issue title: the row's chip names the repo and number.
          // GitHub requires a title; the fallback keeps a row from being blank.
          deps.tasks.add(
            data.title.trim() || `${link.repo}#${number}`,
            "GitHub",
            {
              priority: "P4",
              roomId: link.roomId,
              external: {
                provider: "github",
                repo: link.repo,
                number,
                url: `https://github.com/${link.repo}/issues/${number}`,
                state: data.state,
                stateReason: data.stateReason,
              },
            },
          ),
        );
      })();
      return;
    }
    deps.db.transaction(() => {
      deps.links.putIssue(link.repo, number, data);
      const prev = task?.external;
      if (
        !task ||
        !prev ||
        (prev.state === data.state && prev.stateReason === data.stateReason)
      )
        return;
      const status = statusFor(task.status, data);
      withAuditContextSync(actorFor(link), "githubSync.update", () =>
        deps.tasks.update(task.id, {
          external: {
            ...prev,
            state: data.state,
            stateReason: data.stateReason,
          },
          ...(status ? { status } : {}),
        }),
      );
    })();
  }

  async function request(
    url: string,
    token: string,
    etag: string | undefined,
  ): Promise<{ status: number; headers: Headers; items: unknown[] | null }> {
    const controller = new AbortController();
    const entry = {
      controller,
      timer: deps.scheduler.setTimeout(
        () => controller.abort(),
        GITHUB_FETCH_TIMEOUT_MS,
      ),
    };
    inFlight.add(entry);
    try {
      const response = await deps.fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "isomux",
          ...(etag ? { "If-None-Match": etag } : {}),
        },
        signal: controller.signal,
      });
      let items: unknown[] | null = null;
      if (response.status === 200) {
        const parsed = (await response.json()) as unknown;
        if (!Array.isArray(parsed))
          throw new PassStop({
            kind: "error",
            reason: "server",
            checkedAt: deps.now(),
          });
        items = parsed;
      }
      return { status: response.status, headers: response.headers, items };
    } catch (error) {
      if (error instanceof PassStop) throw error;
      throw new PassStop({
        kind: "error",
        reason: "network",
        checkedAt: deps.now(),
      });
    } finally {
      deps.scheduler.clearTimeout(entry.timer);
      inFlight.delete(entry);
    }
  }

  // The status a refused answer stands for, or null for 200 and 304.
  function refusal(
    status: number,
    headers: Headers,
    secretUpdatedAt: number,
  ): GithubLinkStatus | null {
    const now = deps.now();
    if (status === 200 || status === 304) return null;
    const limited =
      status === 429 ||
      (status === 403 &&
        (headers.get("x-ratelimit-remaining") === "0" ||
          headers.has("retry-after")));
    if (limited)
      return {
        kind: "waiting",
        reason: "rate_limit",
        until: now + waitFor(headers, now),
        checkedAt: now,
      };
    if (status === 401)
      return {
        kind: "paused",
        reason: "refused",
        secretUpdatedAt,
        checkedAt: now,
      };
    if (status === 403 || status === 404)
      return {
        kind: "paused",
        reason: "no_access",
        secretUpdatedAt,
        checkedAt: now,
      };
    return { kind: "error", reason: "server", checkedAt: now };
  }

  function issuesUrl(
    link: GithubLink,
    first: boolean,
    since: string | undefined,
    page: number,
  ): string {
    const url = new URL(`https://${GITHUB_HOST}/repos/${link.repo}/issues`);
    url.searchParams.set("state", first ? "open" : "all");
    url.searchParams.set("sort", "updated");
    url.searchParams.set("direction", "asc");
    url.searchParams.set("per_page", String(PER_PAGE));
    if (since) url.searchParams.set("since", since);
    if (page > 1) url.searchParams.set("page", String(page));
    return url.href;
  }

  // One link's pass. GitHub pages by offset, so a change during the walk
  // moves items between pages: each request asks for page 1 again since the
  // newest updated_at so far. Only a full page that adds no newer item (many
  // issues changed in one second) follows the next page.
  // Returns the link's new status, or null to keep it (a wait or a pause
  // that still holds).
  async function pollLink(link: GithubLink): Promise<GithubLinkStatus | null> {
    const now = deps.now();
    if (link.status.kind === "waiting" && (link.status.until ?? 0) > now)
      return null;
    const secret = deps.readSecret(link.secretName);
    if (!secret) return { kind: "paused", reason: "missing", checkedAt: now };
    // The token goes only where its owner allowed it.
    if (!secret.hosts.includes(GITHUB_HOST))
      return {
        kind: "paused",
        reason: "host",
        secretUpdatedAt: secret.updatedAt,
        checkedAt: now,
      };
    if (
      link.status.kind === "paused" &&
      (link.status.reason === "refused" ||
        link.status.reason === "no_access") &&
      link.status.secretUpdatedAt === secret.updatedAt
    )
      return null;

    const first = !link.cursor;
    let since = first ? link.walk?.since : link.cursor!.since;
    let walkDate = link.walk?.date;
    let page = 1;
    for (let sent = 0; sent < MAX_REQUESTS_PER_PASS; sent++) {
      const etag =
        !first && page === 1 && since === link.cursor!.since
          ? link.cursor!.etag
          : undefined;
      const answer = await request(
        issuesUrl(link, first, since, page),
        secret.value,
        etag,
      );
      const refused = refusal(answer.status, answer.headers, secret.updatedAt);
      if (refused) throw new PassStop(refused);
      if (answer.status === 304) return ok();
      const items = answer.items ?? [];
      if (first && !walkDate) {
        const date = Date.parse(answer.headers.get("date") ?? "");
        walkDate = githubTime(Number.isNaN(date) ? deps.now() : date);
      }
      let newest = since ? Date.parse(since) : -Infinity;
      for (const item of items) {
        const issue = issueOf(item);
        const at =
          item && typeof item === "object"
            ? Date.parse(String((item as { updated_at?: unknown }).updated_at))
            : NaN;
        if (issue) apply(link, issue.number, issue.data);
        if (!Number.isNaN(at)) newest = Math.max(newest, at);
      }
      const moved =
        Number.isFinite(newest) &&
        newest !== (since ? Date.parse(since) : -Infinity);
      const next = moved ? githubTime(newest) : since;
      if (items.length < PER_PAGE) {
        if (first) deps.links.saveCursor(link.id, { since: walkDate! });
        else
          deps.links.saveCursor(link.id, {
            since: next!,
            // The answer's ETag is for since=<next>, page 1 only.
            ...(!moved && page === 1 && answer.headers.get("etag")
              ? { etag: answer.headers.get("etag")! }
              : {}),
          });
        return ok();
      }
      if (moved) {
        since = next;
        page = 1;
      } else page++;
      if (first) deps.links.saveWalk(link.id, { since, date: walkDate! });
      else if (moved) deps.links.saveCursor(link.id, { since: since! });
    }
    // The request cap: the next pass goes on from the saved progress.
    return ok();
  }

  const ok = (): GithubLinkStatus => ({ kind: "ok", checkedAt: deps.now() });

  async function pass(): Promise<void> {
    for (const link of deps.links.list()) {
      try {
        // A room that closed while the server was down keeps no link.
        if (!deps.roomExists(link.roomId)) {
          deps.links.remove(link.roomId);
          continue;
        }
        const status = await pollLink(link);
        if (status) deps.links.saveStatus(link.id, status);
      } catch (error) {
        // A failed issue write stops this link's pass where it was: the
        // cursor and the ETag stay, so the next pass fetches it again.
        if (error instanceof PassStop) {
          if (error.status) deps.links.saveStatus(link.id, error.status);
        } else console.error(`[github-sync] ${link.repo}: pass stopped`, error);
      }
    }
  }

  function tick(): Promise<void> {
    running ??= pass()
      .catch((error) => console.error("[github-sync] pass failed", error))
      .finally(() => {
        running = null;
      });
    return running;
  }

  function schedule(ms: number): void {
    if (stopped) return;
    timer = deps.scheduler.setTimeout(() => {
      timer = null;
      void tick().then(() => schedule(GITHUB_SYNC_INTERVAL_MS));
    }, ms);
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      schedule(FIRST_DELAY_MS);
    },
    stop() {
      stopped = true;
      if (timer !== null) deps.scheduler.clearTimeout(timer);
      timer = null;
      for (const entry of inFlight) {
        deps.scheduler.clearTimeout(entry.timer);
        entry.controller.abort();
      }
      inFlight.clear();
    },
    tick,
  };
}

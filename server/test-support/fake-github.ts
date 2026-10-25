// A fake of the slice of the GitHub REST API the issue sync reads (task
// 7fc83592): GET /repos/{owner}/{repo}/issues with state, since, sort,
// direction, per_page and page, offset pages with a Link rel="next" header,
// ETag / If-None-Match, a Date header from the fake clock, and Bearer auth.
// It answers the way GitHub documents, not the way the sync is built, so a
// test that drives it holds for any correct client.

export const FAKE_GITHUB_TOKEN = "ghp_fake_sync_token_0123456789";
export const FAKE_T0 = Date.parse("2026-10-25T10:00:00Z");

export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  login: string;
  association: string;
  state: "open" | "closed";
  stateReason: string | null;
  createdAt: number; // ms, whole seconds
  updatedAt: number;
  pullRequest?: boolean;
}

export interface FakeRequest {
  url: URL;
  headers: Headers;
  status: number;
  // The issue numbers the answer carried, in order.
  served: number[];
}

// GitHub's timestamp form: ISO 8601 in whole seconds.
export function githubTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export class FakeGithub {
  clock = FAKE_T0;
  token = FAKE_GITHUB_TOKEN;
  readonly repos = new Map<string, FakeIssue[]>();
  readonly requests: FakeRequest[] = [];
  // Answer this instead of the issues, when it returns a Response.
  override: ((url: URL) => Response | undefined) | null = null;
  // Runs after each answer is built, before it is returned: a change made
  // here lands between two requests of one pass.
  afterServe: ((request: FakeRequest) => void) | null = null;
  // Repos (lowercased) whose requests never answer until their signal aborts.
  readonly hang = new Set<string>();
  // Awaited before each answer.
  gate: Promise<void> | null = null;
  private nextNumber = new Map<string, number>();

  constructor(repos: string[] = ["acme/widgets"]) {
    for (const repo of repos) this.repos.set(repo.toLowerCase(), []);
  }

  advance(seconds = 1): number {
    this.clock += seconds * 1000;
    return this.clock;
  }

  issues(repo = "acme/widgets"): FakeIssue[] {
    const list = this.repos.get(repo.toLowerCase());
    if (!list) throw new Error(`fake github: no repo ${repo}`);
    return list;
  }

  issue(number: number, repo = "acme/widgets"): FakeIssue {
    const found = this.issues(repo).find((i) => i.number === number);
    if (!found) throw new Error(`fake github: no issue ${number}`);
    return found;
  }

  // A new issue, created and updated one second after the clock.
  open(fields: Partial<FakeIssue> = {}, repo = "acme/widgets"): FakeIssue {
    const key = repo.toLowerCase();
    const number = fields.number ?? (this.nextNumber.get(key) ?? 0) + 1;
    this.nextNumber.set(key, Math.max(number, this.nextNumber.get(key) ?? 0));
    const at = this.advance();
    const issue: FakeIssue = {
      number,
      title: `Issue ${number}`,
      body: `Body of issue ${number}`,
      labels: [],
      login: "someone",
      association: "NONE",
      state: "open",
      stateReason: null,
      createdAt: at,
      updatedAt: at,
      ...fields,
    };
    this.issues(repo).push(issue);
    return issue;
  }

  // Any change on GitHub bumps updated_at.
  touch(
    number: number,
    changes: Partial<FakeIssue> = {},
    repo = "acme/widgets",
  ): FakeIssue {
    const issue = this.issue(number, repo);
    Object.assign(issue, changes, { updatedAt: this.advance() });
    return issue;
  }

  close(number: number, reason: string | null, repo = "acme/widgets") {
    return this.touch(number, { state: "closed", stateReason: reason }, repo);
  }

  reopen(number: number, repo = "acme/widgets") {
    return this.touch(number, { state: "open", stateReason: "reopened" }, repo);
  }

  comment(number: number, repo = "acme/widgets") {
    return this.touch(number, {}, repo);
  }

  requestsFor(repo: string): FakeRequest[] {
    const path = `/repos/${repo.toLowerCase()}/issues`;
    return this.requests.filter((r) => r.url.pathname.toLowerCase() === path);
  }

  readonly fetch = async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const headers = new Headers(init.headers);
    const record: FakeRequest = { url, headers, status: 0, served: [] };
    this.requests.push(record);
    if (url.protocol !== "https:" || url.host !== "api.github.com") {
      throw new Error(`fake github: request to ${url.href}`);
    }
    const match = /^\/repos\/([^/]+)\/([^/]+)\/issues$/.exec(url.pathname);
    const key = match ? `${match[1]}/${match[2]}`.toLowerCase() : "";
    if (this.hang.has(key)) {
      const signal = init.signal;
      if (!signal) {
        await new Promise((r) => setTimeout(r, 200));
        throw new Error("fake github: a hung request had no abort signal");
      }
      await new Promise<void>((_, reject) => {
        const fail = () => reject(new Error("fake github: request aborted"));
        if (signal.aborted) fail();
        signal.addEventListener("abort", fail);
      });
    }
    if (this.gate) await this.gate;
    const response = this.answer(url, headers, key, record);
    record.status = response.status;
    this.afterServe?.(record);
    return response;
  };

  private answer(
    url: URL,
    headers: Headers,
    key: string,
    record: FakeRequest,
  ): Response {
    const common = {
      date: new Date(this.clock).toUTCString(),
      "x-ratelimit-remaining": "4999",
      "x-ratelimit-reset": String(Math.floor(this.clock / 1000) + 3600),
    };
    const overridden = this.override?.(url);
    if (overridden) return overridden;
    const auth = headers.get("authorization") ?? "";
    if (!/^(Bearer|token) /.test(auth) || auth.split(" ")[1] !== this.token) {
      return Response.json(
        { message: "Bad credentials" },
        { status: 401, headers: common },
      );
    }
    const list = this.repos.get(key);
    if (!list) {
      return Response.json(
        { message: "Not Found" },
        { status: 404, headers: common },
      );
    }
    const q = url.searchParams;
    const state = q.get("state") ?? "open";
    const since = q.get("since");
    const sinceMs = since === null ? null : Date.parse(since);
    if (sinceMs !== null && Number.isNaN(sinceMs)) {
      return Response.json(
        { message: "Validation Failed" },
        { status: 422, headers: common },
      );
    }
    const sort = q.get("sort") ?? "created";
    const direction = q.get("direction") ?? "desc";
    const perPage = Math.min(Number(q.get("per_page") ?? 30), 100);
    const page = Number(q.get("page") ?? 1);
    const field = sort === "updated" ? "updatedAt" : "createdAt";
    const all = list
      .filter((i) => state === "all" || i.state === state)
      .filter((i) => sinceMs === null || i.updatedAt >= sinceMs)
      .sort((a, b) =>
        direction === "asc"
          ? a[field] - b[field] || a.number - b.number
          : b[field] - a[field] || b.number - a.number,
      );
    const slice = all.slice((page - 1) * perPage, page * perPage);
    const [owner, name] = key.split("/");
    const items = slice.map((i) => ({
      number: i.number,
      title: i.title,
      body: i.body,
      labels: i.labels.map((label) => ({ name: label })),
      user: { login: i.login },
      author_association: i.association,
      state: i.state,
      state_reason: i.stateReason,
      created_at: githubTime(i.createdAt),
      updated_at: githubTime(i.updatedAt),
      // Never where the task links: the sync builds its own URL.
      html_url: `https://evil.example/${owner}/${name}/${i.number}`,
      ...(i.pullRequest ? { pull_request: { url: "https://x" } } : {}),
    }));
    const extra: Record<string, string> = {};
    if (page * perPage < all.length) {
      const next = new URL(url.href);
      next.searchParams.set("page", String(page + 1));
      extra.link = `<${next.href}>; rel="next"`;
    }
    const text = JSON.stringify(items);
    const etag = `"${Bun.hash(text + (extra.link ?? "")).toString(16)}"`;
    if (headers.get("if-none-match") === etag) {
      return new Response(null, {
        status: 304,
        headers: { ...common, etag },
      });
    }
    record.served = slice.map((i) => i.number);
    return new Response(text, {
      status: 200,
      headers: {
        ...common,
        ...extra,
        etag,
        "content-type": "application/json",
      },
    });
  }
}

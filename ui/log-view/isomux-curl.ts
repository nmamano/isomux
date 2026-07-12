// Parser for curl commands that target the isomux server's own API.
//
// The chat transcript is full of Bash tool calls like
//   curl -s -X POST localhost:4000/api/agents/<id>/messages -H 'Content-Type:
//   application/json' -d '{"text":"..."}'
// Since we know the shape of our own API, we can render these as a structured
// card (method badge, route, key payload fields) instead of raw shell text.
//
// This module is deliberately conservative: parseIsomuxCurl() returns null for
// anything it can't FULLY understand (compound commands, redirections, command
// substitution, unknown flags, non-isomux hosts), and the caller falls back to
// the plain rendering. A false null costs nothing; a false parse would show a
// wrong summary.

export type CurlBodyField = { key: string; value: string };

export type IsomuxCurlRequest = {
  /** Uppercased HTTP method ("GET", "POST", ...). */
  method: string;
  /** Path + query string, e.g. "/api/memory?scope=agent". Always starts with "/". */
  path: string;
  /** Human label for known routes ("Send agent message"), or null if unknown. */
  action: string | null;
  /**
   * Top-level fields of the JSON object body, stringified for display.
   * Empty array for an empty object body ("{}"); null when there is no body
   * or the body isn't a JSON object.
   */
  bodyFields: CurlBodyField[] | null;
  /** Raw body text when present but not parseable as a JSON object. */
  bodyRaw: string | null;
  /** True when an Authorization header is present (value is never surfaced). */
  hasAuth: boolean;
  /**
   * Trailing pipeline, verbatim, e.g. "| jq '.tasks'". Null if none.
   *
   * Accepted tails are shell-checked (each stage must tokenize under the same
   * conservative rules as the curl itself — no compound commands,
   * redirections, or substitutions), command-gated (see FILTER_COMMANDS), and
   * length-capped (MAX_PIPE_TAIL). They are NOT semantically validated — a
   * `sed w` script can still write a file — so the UI MUST render this string
   * verbatim and untruncated. That is the safety property: the collapsed card
   * never shows less of the tail than the raw rendering would.
   */
  pipeTail: string | null;
};

// --- shell tokenizer ---------------------------------------------------------

type Tokenized = { tokens: string[]; pipeTail: string | null };

/**
 * Tokenize a single simple shell command. Handles single/double quotes,
 * backslash escapes, and backslash-newline continuations. Returns null on any
 * shell construct beyond a simple command optionally piped into something
 * (compound commands, redirections, subshells, command substitution).
 * `$VAR` references are kept literally — they read well in a summary
 * (e.g. a path containing $AGENT_ID).
 */
function tokenize(command: string): Tokenized | null {
  const src = command.trim();
  const tokens: string[] = [];
  let cur = "";
  let hasCur = false;
  let i = 0;
  const n = src.length;
  const push = () => {
    if (hasCur) {
      tokens.push(cur);
      cur = "";
      hasCur = false;
    }
  };
  while (i < n) {
    const c = src[i];
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) return null;
      cur += src.slice(i + 1, end);
      hasCur = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i++;
      let closed = false;
      while (i < n) {
        const d = src[i];
        if (d === '"') {
          closed = true;
          i++;
          break;
        }
        if (d === "\\" && i + 1 < n && '"\\$`'.includes(src[i + 1])) {
          cur += src[i + 1];
          i += 2;
          continue;
        }
        // Command substitution inside double quotes actually executes.
        if (d === "`" || (d === "$" && src[i + 1] === "(")) return null;
        cur += d;
        i++;
      }
      if (!closed) return null;
      hasCur = true;
      continue;
    }
    if (c === "\\") {
      if (i + 1 >= n) return null;
      if (src[i + 1] === "\n") {
        // line continuation
        i += 2;
        continue;
      }
      cur += src[i + 1];
      hasCur = true;
      i += 2;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      push();
      i++;
      continue;
    }
    // An unescaped newline separates commands — too complex, bail.
    if (c === "\n") return null;
    if (c === "|") {
      if (src[i + 1] === "|") return null; // `||` is control flow, not a pipe
      push();
      return { tokens, pipeTail: src.slice(i).trim() };
    }
    if (";&<>`()".includes(c)) return null;
    if (c === "$" && src[i + 1] === "(") return null;
    cur += c;
    hasCur = true;
    i++;
  }
  push();
  return { tokens, pipeTail: null };
}

// Commands accepted as pipeline stages after the curl. A coarse gate that
// keeps obviously-active commands (another curl, xargs, tee, sh, ...) out of
// the card. It deliberately does NOT try to prove purity: several of these
// can have side effects through their arguments (sed `w`, sort -o, ...), and
// validating each command's option grammar and mini-language would be brittle
// across implementations. Instead, the card's safety property is display, not
// validation: accepted tails are short (MAX_PIPE_TAIL) and rendered verbatim
// and untruncated, so the collapsed card can never conceal part of the
// command that the raw rendering would have shown. awk is excluded because
// its program text is arbitrary code (system()) with no redeeming common use
// in these transcripts.
const FILTER_COMMANDS = new Set([
  "jq",
  "sed",
  "grep",
  "head",
  "tail",
  "cat",
  "cut",
  "tr",
  "sort",
  "uniq",
  "wc",
  "column",
]);

// Longest pipe tail we accept. Longer tails fall back to raw rendering; this
// keeps the card tidy and guarantees the verbatim tail fits in the summary.
const MAX_PIPE_TAIL = 80;

/**
 * Validate a captured pipe tail (starting with "|"). Every stage must
 * tokenize under the same conservative rules as the curl itself (so `; rm x`,
 * redirections, and substitutions in the tail bail out) and must invoke an
 * allowed filter command. `python -m json.tool` is allowed as a special case.
 * See FILTER_COMMANDS for what this does and does not guarantee.
 */
function isSafePipeTail(tail: string): boolean {
  const stage = tokenize(tail.slice(1));
  if (!stage || stage.tokens.length === 0) return false;
  const [cmd, ...rest] = stage.tokens;
  const allowed =
    FILTER_COMMANDS.has(cmd) ||
    ((cmd === "python" || cmd === "python3") &&
      rest[0] === "-m" &&
      rest[1] === "json.tool");
  if (!allowed) return false;
  return stage.pipeTail === null || isSafePipeTail(stage.pipeTail);
}

// --- curl flag tables --------------------------------------------------------

// Boolean long options that don't change what we display. Not a blanket
// claim that they preserve request semantics: -L/--location can change the
// effective target via server redirects. It's accepted because the target is
// this trusted local service, whose redirects (if any) it controls.
const BOOLEAN_LONG = new Set([
  "--silent",
  "--show-error",
  "--fail",
  "--fail-with-body",
  "--location",
  "--insecure",
  "--include",
  "--verbose",
  "--compressed",
  "--globoff",
  "--no-buffer",
  "--no-progress-meter",
  "--http1.1",
  "--http2",
  "--get",
]);

// Single-letter boolean flags (may appear clustered, e.g. -sS or -fsSL).
const BOOLEAN_SHORT = new Set([
  "s",
  "S",
  "f",
  "L",
  "k",
  "i",
  "v",
  "g",
  "N",
  "G",
  "4",
  "6",
]);

type ArgKind = "method" | "header" | "data" | "form" | "url" | "ignore";

// Single-letter flags that take a value (attached or as the next token).
//
// The "ignore" kind is reserved for options that are transport/presentation
// neutral: they may not name a filesystem path, carry credentials, add
// request headers, or change the request's method/target/body — because the
// card silently omits them, an ignored option must not hide anything the raw
// rendering would reveal. Options with concealed semantics (-o/--output
// writes a file, -T/--upload-file changes method and body, -u/--user and
// -b/--cookie carry credentials, -A/-e add request headers) are deliberately
// ABSENT from these tables, so they reject the parse and fall back to raw
// rendering. -w/--write-out is also rejected: since curl 8.3.0, write-out's
// %output{file} directive writes to a file, so it is not output-text-only.
const ARG_SHORT: Record<string, ArgKind> = {
  X: "method",
  H: "header",
  d: "data",
  F: "form",
  m: "ignore",
};

const ARG_LONG: Record<string, ArgKind> = {
  "--request": "method",
  "--header": "header",
  "--data": "data",
  "--data-raw": "data",
  "--data-binary": "data",
  "--data-ascii": "data",
  "--data-urlencode": "data",
  "--form": "form",
  "--url": "url",
  "--max-time": "ignore",
  "--connect-timeout": "ignore",
  "--retry": "ignore",
};

// Header names the card may silently omit. Anything else (Cookie carries
// credentials, User-Agent/Referer/arbitrary headers add request semantics the
// card doesn't show) rejects the parse — otherwise generic -H would bypass
// the rejection of the dedicated credential/header flags above. Authorization
// is admitted but only surfaced as a boolean (hasAuth); its value is never
// displayed.
const ALLOWED_HEADERS = new Set(["content-type", "authorization"]);

// --- URL matching ------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

/**
 * If `url` points at the isomux server (loopback host on one of `ports`),
 * return its path+query (normalized to start with "/"). Otherwise null.
 */
function matchIsomuxUrl(
  url: string,
  ports: ReadonlySet<string>,
): string | null {
  let rest = url;
  let defaultPort = "80";
  const scheme = /^(https?):\/\//i.exec(rest);
  if (scheme) {
    rest = rest.slice(scheme[0].length);
    if (scheme[1].toLowerCase() === "https") defaultPort = "443";
  }
  const m = /^(\[[^\]]*\]|[^/:?#]+)(?::(\d+))?([/?#].*)?$/.exec(rest);
  if (!m) return null;
  if (!LOOPBACK_HOSTS.has(m[1].toLowerCase())) return null;
  if (!ports.has(m[2] ?? defaultPort)) return null;
  const path = m[3] ?? "/";
  return path.startsWith("/") ? path : `/${path}`;
}

// --- route naming ------------------------------------------------------------

// Known isomux routes worth a human label in the card. "*" matches exactly one
// path segment. Kept to the routes agents actually hit from transcripts; an
// unknown isomux path still gets a card, just without the label.
const TASK_ROUTES: Array<[string, string, string]> = [
  ["GET", "", "List tasks"],
  ["POST", "", "Create task"],
  ["POST", "/*/claim", "Claim task"],
  ["POST", "/*/done", "Complete task"],
  ["PATCH", "/*", "Update task"],
  ["DELETE", "/*", "Delete task"],
];

const ROUTE_LABELS: Array<[string, string, string]> = [
  // The task board is exposed both at /tasks and /api/tasks.
  ...TASK_ROUTES.map(([m, suffix, label]): [string, string, string] => [
    m,
    `/tasks${suffix}`,
    label,
  ]),
  ...TASK_ROUTES.map(([m, suffix, label]): [string, string, string] => [
    m,
    `/api/tasks${suffix}`,
    label,
  ]),
  ["POST", "/api/agents/*/messages", "Send agent message"],
  ["GET", "/api/agents/*/scheduled-messages", "List scheduled messages"],
  ["DELETE", "/api/agents/*/scheduled-messages/*", "Cancel scheduled message"],
  ["POST", "/api/agents/*/read-file", "Share file to chat"],
  ["POST", "/api/agents/*/preview-url", "Screenshot page to chat"],
  ["POST", "/api/agents/*/diff", "Show diff in chat"],
  ["POST", "/api/agents/*/edit-file", "Offer file in editor"],
  ["POST", "/api/agents/*/terminal-command", "Suggest terminal command"],
  ["GET", "/api/memory", "Read memory"],
  ["POST", "/api/memory", "Append memory"],
  ["PUT", "/api/memory", "Replace memory"],
  ["GET", "/api/cronjobs", "List cronjobs"],
];

export function describeIsomuxRoute(
  method: string,
  path: string,
): string | null {
  const cleanPath = path.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  const segs = cleanPath.split("/").filter(Boolean);
  for (const [m, pattern, label] of ROUTE_LABELS) {
    if (m !== method) continue;
    const patSegs = pattern.split("/").filter(Boolean);
    if (patSegs.length !== segs.length) continue;
    if (patSegs.every((p, idx) => p === "*" || p === segs[idx])) return label;
  }
  return null;
}

// --- humanized labels ----------------------------------------------------------

function truncateLabel(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

const MEMORY_SCOPE_PHRASES: Record<string, string> = {
  agent: "memories for this agent",
  room: "room memories",
  office: "office memories",
  boss: "boss memories",
};

/**
 * Plain-language, parameter-aware description of a parsed request, e.g.
 * "Read memories for this agent" or "Send a message to Isomuxer4". Uses query
 * params, body fields, and (when available) an agent-id -> display-name
 * resolver. Returns null when the route has no specific phrasing; callers
 * fall back to `action` (the static route label) or method + path.
 */
export function humanizeIsomuxRequest(
  req: IsomuxCurlRequest,
  resolveAgentName?: (id: string) => string | null,
): string | null {
  const [pathOnly, queryStr] = req.path.split(/[?#]/);
  const segs = (pathOnly ?? "/").split("/").filter(Boolean);
  if (segs[0] === "api") segs.shift();
  let query: URLSearchParams;
  try {
    query = new URLSearchParams(queryStr ?? "");
  } catch {
    query = new URLSearchParams();
  }
  const field = (key: string): string | null =>
    req.bodyFields?.find((f) => f.key === key)?.value ?? null;
  const agentName = (id: string): string =>
    resolveAgentName?.(id) ?? truncateLabel(id, 18);
  const m = req.method;

  // Memory
  if (segs.length === 1 && segs[0] === "memory") {
    const scope = query.get("scope") ?? field("scope");
    const phrase = (scope && MEMORY_SCOPE_PHRASES[scope]) || "memories";
    if (m === "GET") return `Read ${phrase}`;
    if (m === "POST")
      return scope === "agent"
        ? "Save a memory for this agent"
        : scope && MEMORY_SCOPE_PHRASES[scope]
          ? `Save a ${scope} memory`
          : "Save a memory";
    if (m === "PUT") return `Rewrite ${phrase}`;
  }

  // Task board (/tasks and /api/tasks)
  if (segs[0] === "tasks") {
    if (segs.length === 1) {
      if (m === "GET") {
        const status = query.get("status");
        if (status === "all") return "List all tasks";
        if (status) return `List ${status} tasks`;
        return "List open tasks";
      }
      if (m === "POST") {
        const title = field("title");
        return title
          ? `Create task: ${truncateLabel(title, 40)}`
          : "Create a task";
      }
    }
    if (segs.length === 2) {
      if (m === "PATCH") return `Update task ${segs[1]}`;
      if (m === "DELETE") return `Delete task ${segs[1]}`;
      if (m === "GET") return `Read task ${segs[1]}`;
    }
    if (segs.length === 3 && m === "POST") {
      if (segs[2] === "claim") {
        const assignee = field("assignee");
        return assignee
          ? `Claim task ${segs[1]} for ${assignee}`
          : `Claim task ${segs[1]}`;
      }
      if (segs[2] === "done") return `Mark task ${segs[1]} done`;
    }
  }

  // Agents
  if (segs[0] === "agents") {
    if (segs.length === 1 && m === "POST") {
      const name = field("name");
      return name
        ? `Spawn agent ${truncateLabel(name, 24)}`
        : "Spawn a new agent";
    }
    if (segs.length === 2) {
      const who = agentName(segs[1]);
      if (m === "PATCH") return `Edit ${who}'s settings`;
      if (m === "DELETE") return `Remove agent ${who}`;
    }
    if (segs.length >= 3) {
      const who = agentName(segs[1]);
      const sub = segs[2];
      if (segs.length === 3) {
        if (sub === "messages" && m === "POST")
          return field("deliverAt")
            ? `Schedule a message to ${who}`
            : `Send a message to ${who}`;
        if (sub === "scheduled-messages" && m === "GET")
          return `List ${who}'s scheduled messages`;
        if (sub === "read-file" && m === "POST") return "Share a file to chat";
        if (sub === "preview-url" && m === "POST")
          return "Screenshot a page to chat";
        if (sub === "diff" && m === "POST") return "Show a diff in chat";
        if (sub === "edit-file" && m === "POST")
          return "Offer a file in the editor";
        if (sub === "terminal-command" && m === "POST")
          return "Suggest a terminal command";
        if (sub === "new-conversation" && m === "POST")
          return `Clear ${who}'s conversation`;
        if (sub === "send-now" && m === "POST")
          return `Flush ${who}'s queue now`;
        if (sub === "abort" && m === "POST") return `Interrupt ${who}`;
        if (sub === "resume" && m === "POST")
          return `Resume a session for ${who}`;
        if (sub === "sessions" && m === "GET") return `List ${who}'s sessions`;
        if (sub === "move" && m === "POST") return `Move ${who}`;
        if (sub === "revive" && m === "POST") return `Revive ${who}`;
      }
      if (segs.length === 4) {
        if (sub === "scheduled-messages" && m === "DELETE")
          return `Cancel a scheduled message to ${who}`;
        if (sub === "queue" && m === "DELETE")
          return `Cancel a queued message to ${who}`;
        if (sub === "messages" && m === "PATCH")
          return `Edit a message in ${who}'s chat`;
      }
    }
  }

  // Rooms
  if (segs[0] === "rooms") {
    if (segs.length === 1 && m === "POST") {
      const name = field("name");
      return name ? `Create room ${truncateLabel(name, 24)}` : "Create a room";
    }
    if (segs.length === 2) {
      if (m === "PATCH") return "Update a room";
      if (m === "DELETE") return "Close a room";
    }
    if (segs.length === 3) {
      if (segs[2] === "settings" && m === "PUT") return "Update room settings";
      if (segs[2] === "swap-desks" && m === "POST")
        return "Swap desks in a room";
    }
  }

  // Cronjobs
  if (segs[0] === "cronjobs") {
    if (segs.length === 1) {
      if (m === "GET") return "List cronjobs";
      if (m === "POST") return "Create a cronjob";
    }
    if (segs.length === 2) {
      if (m === "GET") return "Read a cronjob";
      if (m === "PATCH") return "Update a cronjob";
      if (m === "DELETE") return "Delete a cronjob";
    }
    if (segs.length === 3 && segs[2] === "runs") {
      if (m === "GET") return "List cronjob runs";
      if (m === "POST") return "Trigger a cronjob run";
    }
    if (segs.length === 4 && segs[2] === "runs" && m === "GET")
      return "Read a cronjob run";
  }
  if (segs.length === 1 && segs[0] === "cron-runs" && m === "GET")
    return "List recent cron runs";

  return null;
}

// --- body formatting ---------------------------------------------------------

function displayValue(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return (s ?? "").replace(/\s+/g, " ");
}

// --- main entry point --------------------------------------------------------

/**
 * Parse a Bash command string; return a structured request if it is a single
 * curl invocation against the isomux server (optionally piped into a filter),
 * else null. `ports` is the set of local ports the isomux server may listen
 * on (default: the documented 4000).
 */
export function parseIsomuxCurl(
  command: string,
  ports: readonly string[] = ["4000"],
): IsomuxCurlRequest | null {
  const tokenized = tokenize(command);
  if (!tokenized) return null;
  const { tokens, pipeTail } = tokenized;
  if (tokens.length === 0 || tokens[0] !== "curl") return null;
  if (
    pipeTail !== null &&
    (pipeTail.length > MAX_PIPE_TAIL || !isSafePipeTail(pipeTail))
  )
    return null;

  let method: string | null = null;
  let url: string | null = null;
  let hasAuth = false;
  const dataParts: string[] = [];
  const formParts: string[] = [];
  let getStyle = false; // -G/--get sends -d data as query params

  const applyArg = (kind: ArgKind, value: string): boolean => {
    switch (kind) {
      case "method":
        if (method !== null) return false;
        method = value.toUpperCase();
        return true;
      case "header": {
        const name = value.split(":", 1)[0].trim().toLowerCase();
        if (!ALLOWED_HEADERS.has(name)) return false;
        if (name === "authorization") hasAuth = true;
        return true;
      }
      case "data":
        dataParts.push(value);
        return true;
      case "form":
        formParts.push(value);
        return true;
      case "url":
        if (url !== null) return false;
        url = value;
        return true;
      case "ignore":
        return true;
    }
  };

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      const name = eq === -1 ? tok : tok.slice(0, eq);
      if (BOOLEAN_LONG.has(name)) {
        if (eq !== -1) return null;
        if (name === "--get") getStyle = true;
        continue;
      }
      const kind = ARG_LONG[name];
      if (!kind) return null;
      const value = eq !== -1 ? tok.slice(eq + 1) : tokens[++i];
      if (value === undefined) return null;
      if (!applyArg(kind, value)) return null;
      continue;
    }
    if (tok.startsWith("-") && tok.length > 1) {
      // Cluster of short flags, e.g. -sS, -fsSL, -sXPOST. A value-taking flag
      // ends the cluster: the rest of the token (or the next token) is its
      // value, matching curl's own parsing.
      for (let j = 1; j < tok.length; j++) {
        const ch = tok[j];
        if (BOOLEAN_SHORT.has(ch)) {
          if (ch === "G") getStyle = true;
          continue;
        }
        const kind = ARG_SHORT[ch];
        if (!kind) return null;
        const attached = tok.slice(j + 1);
        const value = attached !== "" ? attached : tokens[++i];
        if (value === undefined) return null;
        if (!applyArg(kind, value)) return null;
        break;
      }
      continue;
    }
    // Positional argument: the URL.
    if (!applyArg("url", tok)) return null;
  }

  if (url === null) return null;
  const path = matchIsomuxUrl(url, new Set(ports));
  if (path === null) return null;

  const hasBody = !getStyle && (dataParts.length > 0 || formParts.length > 0);
  const resolvedMethod = method ?? (hasBody ? "POST" : "GET");

  let bodyFields: CurlBodyField[] | null = null;
  let bodyRaw: string | null = null;
  if (hasBody) {
    if (formParts.length > 0) {
      bodyFields = formParts.map((part) => {
        const eq = part.indexOf("=");
        return eq === -1
          ? { key: part, value: "" }
          : { key: part.slice(0, eq), value: displayValue(part.slice(eq + 1)) };
      });
    } else {
      const raw = dataParts.length === 1 ? dataParts[0] : dataParts.join("&");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
      if (
        parsed !== undefined &&
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        bodyFields = Object.entries(parsed as Record<string, unknown>).map(
          ([key, value]) => ({ key, value: displayValue(value) }),
        );
      } else {
        bodyRaw = raw;
      }
    }
  }

  return {
    method: resolvedMethod,
    path,
    action: describeIsomuxRoute(resolvedMethod, path),
    bodyFields,
    bodyRaw,
    hasAuth,
    pipeTail,
  };
}

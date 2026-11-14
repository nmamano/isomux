// An in-memory server for the Integrations page tests, built to the Lead's
// contract (2026-10-13) and the shapes Worker 2 gave: an owner manages any
// member's secrets, MCP servers and variables through /api/users/<name>/...;
// a member manages their own; an owner never reads a member's secret value or
// variable values; a member reads the office's items as names, hosts and
// notes. Every request is recorded, and any path can be held open to test
// answers that arrive late.

import { ApiError, setApiShim, type ApiMethod } from "../api.ts";
import type {
  ApiTokenWire,
  ConnectionsListRes,
  ConnectionTestResult,
  McpServerWire,
  MemberProviderStatus,
  SecretWire,
} from "../../shared/contract-shapes.ts";
import type {
  BackendModelWire,
  EnvVariableSource,
  ProviderAccountWire,
} from "../../shared/types.ts";
import { DEFAULT_VOICE_NAME } from "../../shared/voice.ts";

export type Call = { method: ApiMethod; path: string; body: unknown };

type Scope = {
  secrets: (SecretWire & { value: string })[];
  servers: McpServerWire[];
  values: Record<string, string>;
  notes: Record<string, string>;
};

const emptyScope = (): Scope => ({
  secrets: [],
  servers: [],
  values: {},
  notes: {},
});

export const EMPTY_CONNECTIONS: ConnectionsListRes = {
  variables: [],
  signIns: [],
  claudeConnectors: [],
  mcpServers: [],
  engineMcpServers: [],
  secrets: [],
};

export function secret(
  name: string,
  over: Partial<SecretWire & { value: string }> = {},
): SecretWire & { value: string } {
  return {
    name,
    hosts: ["api.example.com"],
    form: { kind: "authorization" },
    createdAt: 1_760_000_000_000,
    valueSetAt: 1_760_000_000_000,
    updatedAt: 1_760_000_000_000,
    note: null,
    apps: [],
    value: `value-of-${name}`,
    ...over,
  };
}

export function server(
  name: string,
  over: Partial<McpServerWire> = {},
): McpServerWire {
  return {
    name,
    url: `https://${name}.example.com/mcp`,
    secret: null,
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_000_000,
    note: null,
    oauth: null,
    ...over,
  };
}

// The sign-in link of a start the fake runs for a member.
export const memberSignInLink = (member: string) =>
  `https://sign-in.example/${member.toLowerCase()}`;

export class IntegrationsFake {
  calls: Call[] = [];
  scopes = new Map<string, Scope>();
  connections: ConnectionsListRes = EMPTY_CONNECTIONS;
  // GET /api/users/<name>/connections: a member's list, for an owner only,
  // by lower-case member name; a member with no entry reads an empty list.
  memberConnections = new Map<string, ConnectionsListRes>();
  accounts: ProviderAccountWire[] = [];
  // GET /api/users/<name>/provider-accounts: a member's own sign-ins, for an
  // owner only, by lower-case member name; the writes change them.
  memberAccounts = new Map<string, ProviderAccountWire[]>();
  providers: MemberProviderStatus[] = [
    { provider: "claude", status: "connected" },
    { provider: "codex", status: "not_connected" },
  ];
  officeSettings: Record<string, unknown> = {};
  // GET /api/apps: the apps the viewer can see, with their owners.
  apps: { name: string; userId: string | null; username: string | null }[] = [];
  testResult: ConnectionTestResult = {
    ok: true,
    kind: "secret",
    host: "api.example.com",
    account: "octocat",
  };
  // GET /api/me/api-tokens: the viewer's own tokens.
  apiTokens: ApiTokenWire[] = [];
  // GET /api/users/<name>/voice, by lower-case member name; a member with no
  // entry reads the defaults and no key. PATCH merges into it.
  voices = new Map<string, Record<string, unknown>>();
  // GET /api/users/<name>/pager-settings, by lower-case member name.
  pagers = new Map<string, Record<string, unknown>>();
  // GET /api/me/integration-changes: the viewer's own "changed for you" list.
  changes: Record<string, unknown>[] = [];
  // GET /api/me/opencode: the office's free limit and where the viewer's
  // agents get OPENCODE_API_KEY.
  openCode: {
    freeLimitAt: number | null;
    keySource: EnvVariableSource | null;
  } = { freeLimitAt: null, keySource: null };
  // GET /api/me/opencode answers 500 while this is set.
  openCodeFails = false;
  // POST /api/backends/opencode/models: what the viewer's agents can pick,
  // or the route's failed answer (200 with no models and an error).
  openCodeModels: BackendModelWire[] = [];
  openCodeModelsError: { error: string; authError: boolean } | null = null;
  private holds = new Map<string, Promise<void>>();

  constructor(
    // The caller: who the session is, and whether they own the office.
    public viewer: { username: string; owner: boolean },
    // Every member the office knows, by name.
    public members: string[] = [viewer.username],
  ) {}

  scope(key: string): Scope {
    const k = key === "office" ? "office" : key.toLowerCase();
    let scope = this.scopes.get(k);
    if (!scope) {
      scope = emptyScope();
      this.scopes.set(k, scope);
    }
    return scope;
  }

  // Hold every request to `path` until the returned release runs.
  hold(path: string): () => void {
    let release!: () => void;
    this.holds.set(
      path,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return () => {
      this.holds.delete(path);
      release();
    };
  }

  // A fresh office on a fresh device: no tab remembered from another test.
  install(): this {
    window.localStorage.removeItem("isomux-integrations-tab");
    setApiShim((method, path, body) => this.handle(method, path, body));
    return this;
  }

  requests(method: ApiMethod, pattern: RegExp | string): Call[] {
    return this.calls.filter(
      (call) =>
        call.method === method &&
        (typeof pattern === "string"
          ? call.path === pattern
          : pattern.test(call.path)),
    );
  }

  // The fake's answer to one request; a test that wraps the shim calls it.
  async handle(
    method: ApiMethod,
    path: string,
    body: unknown,
  ): Promise<unknown> {
    this.calls.push({ method, path, body });
    const held = this.holds.get(path);
    if (held) await held;
    return this.route(method, path, body as Record<string, unknown>);
  }

  private forbidden(): never {
    throw new ApiError(403, "forbidden", "Forbidden");
  }

  private notFound(): never {
    throw new ApiError(404, "not_found", "Not found");
  }

  private route(
    method: ApiMethod,
    path: string,
    body: Record<string, unknown> = {},
  ): unknown {
    const { owner, username } = this.viewer;
    if (path === "/api/me/provider-accounts" && method === "GET")
      return { accounts: this.accounts };
    if (path === "/api/me/provider-accounts/refresh" && method === "POST")
      return { accounts: this.accounts };
    if (path === "/api/me/connections") return this.connections;
    if (path === "/api/office/settings") return this.officeSettings;
    if (path === "/api/apps" && method === "GET") return this.apps;
    // The Browser Use tab's status: the viewer's own Chrome, none paired.
    if (path === "/api/me/browser" && method === "GET")
      return {
        paired: false,
        online: false,
        member: { id: "self", name: username },
        version: "0.0.0",
        browsers: [],
      };
    if (path.startsWith("/api/memory"))
      return { text: "", version: "0", size: 0, cap: 4000 };
    // The Pager and API tokens tabs: the viewer's own, read-only here.
    if (path === "/api/me/api-tokens" && method === "GET")
      return { apiTokens: this.apiTokens };
    if (path === "/api/me/integration-changes" && method === "GET")
      return { items: this.changes };
    if (path === "/api/me/opencode" && method === "GET") {
      if (this.openCodeFails)
        throw new ApiError(500, "internal_error", "Internal error");
      return this.openCode;
    }
    if (path === "/api/backends/opencode/models" && method === "POST")
      return this.openCodeModelsError
        ? { models: [], ...this.openCodeModelsError }
        : { models: this.openCodeModels };
    // A member's voice and pager settings: the member, or an owner.
    const setting = path.match(
      /^\/api\/users\/([^/]+)\/(voice|pager-settings)$/,
    );
    if (setting) {
      const who = decodeURIComponent(setting[1]).toLowerCase();
      if (!this.members.some((m) => m.toLowerCase() === who)) this.notFound();
      if (!owner && who !== username.toLowerCase()) this.forbidden();
      const voice = setting[2] === "voice";
      const store = voice ? this.voices : this.pagers;
      const current = {
        ...(voice
          ? {
              voiceInput: "browser",
              voiceOutput: "browser",
              voiceName: DEFAULT_VOICE_NAME,
              keySource: null,
              keyName: null,
            }
          : { webhookUrlMasked: null, discordUserId: null, repeatMinutes: 5 }),
        ...store.get(who),
      };
      if (method === "GET") return current;
      if (method === "PATCH") {
        store.set(who, { ...current, ...body });
        return voice ? undefined : store.get(who);
      }
    }
    if (/^\/api\/users\/[^/]+\/push-devices$/.test(path) && method === "GET")
      return { publicKey: "", devices: [] };

    const office = path.startsWith("/api/office/");
    const userMatch = path.match(/^\/api\/users\/([^/]+)(\/.*)$/);
    if (!office && !userMatch) return {};
    const who = office ? "office" : decodeURIComponent(userMatch![1]);
    const rest = office ? path.slice("/api/office".length) : userMatch![2];
    if (
      who !== "office" &&
      !this.members.some((m) => m.toLowerCase() === who.toLowerCase())
    )
      this.notFound();
    const self = who.toLowerCase() === username.toLowerCase();
    // Office items: owners change them; a member reads summaries. Member
    // items: the member, or an owner.
    const mayWrite = who === "office" ? owner : self || owner;
    const scope = this.scope(who);

    // A member's own Claude and Codex sign-ins, for an owner's session only
    // (task f183fac3). A start makes the member's personal wire wait with a
    // link, a cancel ends it, a sign-out signs the member out. The answer is
    // read when the request arrives: a held request answers with that state.
    const signIns = rest.match(
      /^\/provider-accounts(?:\/refresh|\/(claude|codex)\/(login|callback|cancel|disconnect))?$/,
    );
    if (signIns && who !== "office") {
      if (!owner) this.forbidden();
      const key = who.toLowerCase();
      const accounts = this.memberAccounts.get(key) ?? [];
      const [, provider, action] = signIns as unknown as [
        string,
        "claude" | "codex" | undefined,
        string | undefined,
      ];
      if (!provider) return { accounts };
      const put = (wire: ProviderAccountWire) => {
        this.memberAccounts.set(key, [
          ...accounts.filter(
            (a) => !(a.provider === provider && a.scope === "personal"),
          ),
          wire,
        ]);
        return wire;
      };
      const base = {
        provider,
        scope: "personal" as const,
        canBrowserLogin: true,
      };
      if (action === "login") {
        const account = put({
          ...base,
          accountStatus: "not_connected",
          loginStatus: "waiting_external",
          login: { phase: "waiting", authUrl: memberSignInLink(who) },
        });
        return { account, authUrl: memberSignInLink(who) };
      }
      if (action === "cancel") {
        put({ ...base, accountStatus: "not_connected", loginStatus: "idle" });
        return { canceled: true };
      }
      if (action === "disconnect") {
        put({ ...base, accountStatus: "not_connected", loginStatus: "idle" });
        return { accounts: this.memberAccounts.get(key) };
      }
      return { submitted: true };
    }

    // A member's connections list: an owner's session only.
    if (rest === "/connections" && method === "GET" && who !== "office") {
      if (!owner) this.forbidden();
      return this.memberConnections.get(who.toLowerCase()) ?? EMPTY_CONNECTIONS;
    }

    // Variables.
    if (rest === "/env/names") {
      if (who === "office")
        return {
          variables: Object.keys(scope.values)
            .sort()
            .map((name) => ({ name, note: scope.notes[name] ?? null })),
        };
      if (!owner) this.forbidden();
      // Worker 2's shape: a name with no note has no key.
      return {
        names: Object.keys(scope.values).sort(),
        notes: { ...scope.notes },
        providers: this.providers,
      };
    }
    if (rest === "/env") {
      // Values: the office's for owners, a member's for that member only.
      if (who === "office" ? !owner : !self) this.forbidden();
      if (method === "GET")
        return { mode: "managed", values: scope.values, notes: scope.notes };
      if (method === "PUT") {
        scope.values = { ...(body.values as Record<string, string>) };
        scope.notes = { ...((body.notes as Record<string, string>) ?? {}) };
        return undefined;
      }
    }
    const envOne = rest.match(/^\/env\/([^/]+)$/);
    if (envOne) {
      if (!mayWrite) this.forbidden();
      const name = decodeURIComponent(envOne[1]);
      if (method === "PUT") {
        scope.values[name] = String(body.value);
        if (typeof body.note === "string" && body.note)
          scope.notes[name] = body.note;
        else delete scope.notes[name];
        return undefined;
      }
      if (method === "DELETE") {
        if (!(name in scope.values)) this.notFound();
        delete scope.values[name];
        delete scope.notes[name];
        return undefined;
      }
    }

    // Secrets.
    const secretMatch = rest.match(
      /^\/secrets(?:\/([^/]+))?(\/value|\/reissue|\/test)?$/,
    );
    if (secretMatch) {
      const name = secretMatch[1] && decodeURIComponent(secretMatch[1]);
      const tail = secretMatch[2];
      if (!name) {
        if (method === "GET") {
          if (who === "office" && !owner)
            return {
              secrets: scope.secrets.map(({ name, hosts, note }) => ({
                name,
                hosts,
                note,
              })),
            };
          if (!mayWrite) this.forbidden();
          return {
            secrets: scope.secrets.map(({ value: _, ...rest }) => rest),
          };
        }
        if (!mayWrite) this.forbidden();
        if (scope.secrets.some((s) => s.name === body.name))
          throw new ApiError(409, "secret_exists", "exists");
        scope.secrets.push(
          secret(String(body.name), {
            hosts: body.hosts as string[],
            form: body.form as SecretWire["form"],
            note: (body.note as string) ?? null,
            value: String(body.value),
            apps: (body.apps as string[]) ?? [],
          }),
        );
        return {};
      }
      const found = scope.secrets.find((s) => s.name === name);
      if (!found) this.notFound();
      if (tail === "/value" && method === "GET") {
        // Show: the secret's own member, or an owner on an office secret.
        if (who === "office" ? !owner : !self) this.forbidden();
        return { value: found.value };
      }
      if (!mayWrite) this.forbidden();
      if (tail === "/value" && method === "PUT") {
        found.value = String(body.value);
        return {};
      }
      if (tail === "/reissue") return {};
      if (tail === "/test") return { result: this.testResult };
      if (method === "PATCH") {
        Object.assign(found, body);
        return {};
      }
      if (method === "DELETE") {
        scope.secrets = scope.secrets.filter((s) => s.name !== name);
        return undefined;
      }
    }

    // MCP servers.
    const mcpMatch = rest.match(
      /^\/mcp-servers(?:\/([^/]+))?(\/test|\/sign-in)?$/,
    );
    if (mcpMatch) {
      const name = mcpMatch[1] && decodeURIComponent(mcpMatch[1]);
      const tail = mcpMatch[2];
      if (!name) {
        if (method === "GET") {
          if (who === "office" && !owner)
            return {
              servers: scope.servers.map(({ name, url, note }) => ({
                name,
                host: new URL(url).hostname,
                note,
              })),
            };
          if (!mayWrite) this.forbidden();
          return { servers: scope.servers };
        }
        if (!mayWrite) this.forbidden();
        scope.servers.push(
          server(String(body.name), {
            url: String(body.url),
            secret: (body.secret as string | null) ?? null,
            note: (body.note as string) ?? null,
            oauth: body.oauth ? { clientId: null, signedIn: false } : null,
          }),
        );
        return {};
      }
      const found = scope.servers.find((s) => s.name === name);
      if (!found) this.notFound();
      if (!mayWrite) this.forbidden();
      if (tail === "/test")
        return {
          result: {
            ok: true,
            kind: "mcp",
            host: new URL(found.url).hostname,
            server: null,
            tools: 3,
          },
        };
      if (tail === "/sign-in")
        return { authorizationUrl: "https://auth.example.com/authorize" };
      if (method === "PATCH") {
        Object.assign(found, body);
        return {};
      }
      if (method === "DELETE") {
        scope.servers = scope.servers.filter((s) => s.name !== name);
        return undefined;
      }
    }
    return {};
  }
}

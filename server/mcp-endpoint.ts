// The office's MCP server at /mcp (streamable HTTP, stateless). A member adds
// it to Claude, Claude Code or Codex with a personal API token as the bearer.
// An agent below Standard (office, folder and web stops) reaches the office
// only here, with its own token and its pack as the limits. Each tool call is
// one office route, run through the REST executor as the token's identity, so
// the route's authorization, preconditions, audit row and room projection
// apply unchanged.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Identity } from "./identity/index.ts";
import type { ApiTokenInboxDrainRes } from "../shared/contract-shapes.ts";
import { AGENT_ACCESS_STOPS } from "../shared/agent-access.ts";
import { routeAllowedByLimits } from "../shared/api-token-limits.ts";
import { matchRoute } from "./routes/match.ts";
import { API_ROUTES } from "./routes/table.ts";

export type McpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface McpDispatchResult {
  status: number;
  body: unknown;
}

export interface McpEndpointDeps {
  // Runs one office route as `identity` through the REST executor, with
  // `via: "mcp"` in the handler context.
  dispatch(
    identity: Identity,
    method: McpMethod,
    path: string,
    body?: unknown,
  ): Promise<McpDispatchResult>;
  // Resolves when the token's log gains an entry, when `timeoutMs` passes or
  // when `signal` aborts, whichever comes first.
  waitForTokenLogEntry(
    tokenId: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void>;
}

// The most array elements and object keys one tool call's arguments may hold,
// for this server and the folder one. Without a cap the SDK validates
// arguments of any size, and one request can exhaust the server's memory. The
// largest input a tool needs is an ask's 10 options. The request body keeps the
// SDK's 4 MiB default rather than a lower one: both endpoints authenticate the
// token before the SDK reads the body.
export const MCP_MAX_TOOL_INPUT_ELEMENTS = 1000;

const MAX_WAIT_SECONDS = 25;
const DEFAULT_CONVERSATION_LIMIT = 20;
const MAX_CONVERSATION_LIMIT = 100;

// One JSON-RPC exchange of the MCP streamable HTTP transport. The caller has
// already resolved `identity` to a personal API token or to the token of an
// agent at the office, folder or web stop.
export async function handleMcpRequest(
  req: Request,
  identity: Identity,
  deps: McpEndpointDeps,
): Promise<Response> {
  // Stateless: no session to resume, so no SSE stream (GET) or session end
  // (DELETE).
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({
        error: { code: "method_not_allowed", message: "Use POST." },
      }),
      {
        status: 405,
        headers: { "Content-Type": "application/json", Allow: "POST" },
      },
    );
  }
  const server = buildServer(identity, deps, req.signal);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(req);
  } finally {
    await server.close().catch(() => {});
  }
}

// The names of the tools the office MCP server lists for `identity`. An
// OpenCode agent below standard allows exactly these, by name (task
// e77304b1): its rules cannot use a wildcard.
export function officeMcpToolNames(identity: Identity): string[] {
  const names: string[] = [];
  buildServer(
    identity,
    {
      dispatch: () => Promise.reject(new Error("no dispatch for a tool list")),
      waitForTokenLogEntry: () => Promise.resolve(),
    },
    AbortSignal.abort(),
    (name) => names.push(name),
  );
  return names;
}

function buildServer(
  identity: Identity,
  deps: McpEndpointDeps,
  requestSignal: AbortSignal,
  onTool?: (name: string) => void,
): McpServer {
  const server = new McpServer(
    { name: "isomux", version: "1.0.0" },
    { maxToolInputElements: MCP_MAX_TOOL_INPUT_ELEMENTS },
  );
  // The SDK answers tools/list only once a tool was registered, and a pack can
  // grant none: a placeholder registered and removed at once makes the list
  // an empty one instead of "method not found".
  server.registerTool("placeholder", {}, () => json(null)).remove();
  if (onTool) {
    const register = server.registerTool.bind(server);
    server.registerTool = ((name: string, ...rest: unknown[]) => {
      onTool(name);
      return (register as (...args: unknown[]) => unknown)(name, ...rest);
    }) as typeof server.registerTool;
  }
  const call = (method: McpMethod, path: string, body?: unknown) =>
    deps.dispatch(identity, method, path, body);
  const asAgent = identity.scope === "agent" && !!identity.agentId;
  // A tool is listed only when the token's limits let it call every route the
  // tool uses.
  const mayCall = (...routes: Array<[McpMethod, string]>) =>
    routes.every(([method, path]) => {
      const match = matchRoute(API_ROUTES, method, path);
      return (
        match !== null &&
        routeAllowedByLimits(identity.apiTokenLimits, match.route.tokenArea)
      );
    });

  if (mayCall(["GET", "/agents"])) {
    server.registerTool(
      "list_agents",
      {
        description:
          "List the agents in the office rooms you can access. pendingPrompt is not null when the agent waits for a member's answer.",
        annotations: { readOnlyHint: true },
      },
      async () => {
        const res = await call("GET", "/agents");
        if (res.status !== 200) return routeError(res);
        const rows = (res.body as AgentRow[]).map((agent) => ({
          id: agent.id,
          name: agent.name,
          roomName: agent.roomName,
          topic: agent.topic ?? null,
          pendingPrompt: agent.pendingPrompt ?? null,
          busy: agent.inFlightTurn != null,
        }));
        return json(rows);
      },
    );
  }

  if (
    mayCall(["GET", "/api/agents/_/sessions"], ["GET", "/api/agents/_/logs"])
  ) {
    server.registerTool(
      "read_conversation",
      {
        description:
          "Read the newest entries of an agent's current conversation: messages to the agent and its replies.",
        inputSchema: {
          agentId: z.string().min(1),
          limit: z.number().int().min(1).max(MAX_CONVERSATION_LIMIT).optional(),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ agentId, limit }) => {
        const agentPath = `/api/agents/${encodeURIComponent(agentId)}`;
        const sessions = await call("GET", `${agentPath}/sessions`);
        if (sessions.status !== 200) return routeError(sessions);
        const { currentSessionId, sessions: list } = sessions.body as {
          currentSessionId: string | null;
          sessions: Array<{ sessionId: string }>;
        };
        const sessionId = currentSessionId ?? list[0]?.sessionId ?? null;
        if (sessionId === null) return json({ agentId, entries: [] });
        const query = new URLSearchParams({
          session: sessionId,
          tier: "conversation",
          limit: String(limit ?? DEFAULT_CONVERSATION_LIMIT),
        });
        const logs = await call("GET", `${agentPath}/logs?${query}`);
        if (logs.status !== 200) return routeError(logs);
        const read = logs.body as {
          topic: string | null;
          pendingPrompt: string | null;
          truncated: boolean;
          entries: Array<{ kind: string; timestamp: number; content: string }>;
        };
        return json({
          agentId,
          sessionId,
          topic: read.topic,
          pendingPrompt: read.pendingPrompt,
          truncated: read.truncated,
          entries: read.entries.map((entry) => ({
            kind: entry.kind,
            timestamp: entry.timestamp,
            content: entry.content,
          })),
        });
      },
    );
  }

  if (mayCall(["POST", "/api/agents/_/messages"])) {
    server.registerTool(
      "send_message",
      {
        description: asAgent
          ? "Send a message to an agent as yourself. Its reply comes to your chat and can take minutes."
          : "Send a message to an agent as the member. Returns the sequence of the message in this token's log; pass it to read_replies as `after`. The agent's reply can take minutes.",
        inputSchema: {
          agentId: z.string().min(1),
          text: z.string().min(1),
        },
      },
      async ({ agentId, text }) => {
        // The office runs a leading "/" as a command, with no decision by the
        // agent. Only the member types commands.
        if (text.startsWith("/")) {
          return toolError(
            "command_not_allowed",
            "Text that starts with / runs a command. The member types commands in the office.",
          );
        }
        const res = await call(
          "POST",
          `/api/agents/${encodeURIComponent(agentId)}/messages`,
          { text },
        );
        if (res.status !== 200) return routeError(res);
        const sent = res.body as {
          messageId: string;
          sentAt?: number;
          sequence?: number;
        };
        return json(
          asAgent
            ? { messageId: sent.messageId }
            : {
                messageId: sent.messageId,
                sentAt: sent.sentAt,
                sequence: sent.sequence,
              },
        );
      },
    );
  }

  registerTaskTools(server, call, mayCall);
  if (asAgent)
    registerAskTools(
      server,
      call,
      mayCall,
      `/api/agents/${encodeURIComponent(identity.agentId ?? "")}/asks`,
    );

  // A reply to a messaging contact (task d03a61d8): an agent's own, as an
  // ask. Listed for
  // every agent that may open asks; the route refuses a row it does not have,
  // since a row added during a session would not show in a tool list.
  if (asAgent && mayCall(["POST", "/api/messaging/routes/_/messages"])) {
    server.registerTool(
      "messaging_reply",
      {
        description:
          "Reply to a contact of your manager in a messaging app (WhatsApp). routeId is in the message's label line. Per chat, the reply waits for your manager's Send in their Inbox (the answer comes to your chat) or goes out at once (status sent). After a 504, the message may have gone out: do not send it again.",
        inputSchema: {
          routeId: z.string().min(1),
          text: z.string().min(1),
        },
      },
      async ({ routeId, text }) => {
        const res = await call(
          "POST",
          `/api/messaging/routes/${encodeURIComponent(routeId)}/messages`,
          { text },
        );
        return res.status >= 200 && res.status < 300
          ? json(res.body)
          : routeError(res);
      },
    );
  }

  // The token's own inbox: an API token's only. An agent's replies come to
  // its chat.
  if (
    identity.scope === "api" &&
    mayCall(["POST", "/api/me/api-token-inbox/drain"])
  ) {
    server.registerTool(
      "read_replies",
      {
        description: `Read this token's log after a sequence: the agents' replies and the messages sent with this token. If there is nothing new, waits up to waitSeconds (at most ${MAX_WAIT_SECONDS}) for an entry. Pass the latest sequence you have read as \`after\`.`,
        inputSchema: {
          after: z.number().int().min(0),
          waitSeconds: z.number().min(0).optional(),
        },
      },
      async ({ after, waitSeconds }, extra) => {
        const waitMs =
          Math.min(
            Math.max(waitSeconds ?? MAX_WAIT_SECONDS, 0),
            MAX_WAIT_SECONDS,
          ) * 1000;
        const tokenId = identity.apiTokenId ?? "";
        // The waiter goes in before the first read, so an entry written
        // between the read and the wait still wakes it.
        const stop = new AbortController();
        const abort = () => stop.abort();
        requestSignal.addEventListener("abort", abort);
        extra.signal.addEventListener("abort", abort);
        try {
          const woke =
            waitMs > 0
              ? deps.waitForTokenLogEntry(tokenId, waitMs, stop.signal)
              : Promise.resolve();
          const first = await call("POST", "/api/me/api-token-inbox/drain", {
            after,
          });
          if (first.status !== 200) return routeError(first);
          if (
            (first.body as ApiTokenInboxDrainRes).entries.length > 0 ||
            waitMs === 0
          )
            return json(replies(first.body as ApiTokenInboxDrainRes));
          await woke;
          const second = await call("POST", "/api/me/api-token-inbox/drain", {
            after,
          });
          if (second.status !== 200) return routeError(second);
          return json(replies(second.body as ApiTokenInboxDrainRes));
        } finally {
          stop.abort();
          requestSignal.removeEventListener("abort", abort);
          extra.signal.removeEventListener("abort", abort);
        }
      },
    );
  }

  return server;
}

type Call = (
  method: McpMethod,
  path: string,
  body?: unknown,
) => Promise<McpDispatchResult>;
type MayCall = (...routes: Array<[McpMethod, string]>) => boolean;

const TASK_PRIORITY = z.enum(["P0", "P1", "P2", "P3", "P4"]);
const TASK_STATUS = z.enum(["open", "in_progress", "done", "obsolete"]);

// The task board tools, by the tasks area.
function registerTaskTools(server: McpServer, call: Call, mayCall: MayCall) {
  const taskPath = (id: string) => `/api/tasks/${encodeURIComponent(id)}`;
  const reply = (res: McpDispatchResult) =>
    res.status >= 200 && res.status < 300 ? json(res.body) : routeError(res);

  if (mayCall(["GET", "/api/tasks"])) {
    server.registerTool(
      "list_tasks",
      {
        description:
          "List the tasks on the board you can see. Without a status: the open and in-progress tasks, P4 left out. assignee and title (text in the title) narrow the list.",
        inputSchema: {
          status: z.enum([...TASK_STATUS.options, "all"]).optional(),
          assignee: z.string().min(1).optional(),
          title: z.string().min(1).optional(),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ status, assignee, title }) => {
        const query = new URLSearchParams();
        if (status) query.set("status", status);
        if (assignee) query.set("assignee", assignee);
        if (title) query.set("title", title);
        const qs = query.size > 0 ? `?${query}` : "";
        return reply(await call("GET", `/api/tasks${qs}`));
      },
    );
  }
  if (mayCall(["GET", "/api/tasks/_"])) {
    server.registerTool(
      "get_task",
      {
        description: "Read one task by its id.",
        inputSchema: { id: z.string().min(1) },
        annotations: { readOnlyHint: true },
      },
      async ({ id }) => reply(await call("GET", taskPath(id))),
    );
  }
  if (mayCall(["POST", "/api/tasks"])) {
    server.registerTool(
      "create_task",
      {
        description: "File a new task on the board.",
        inputSchema: {
          title: z.string().min(1),
          description: z.string().optional(),
          priority: TASK_PRIORITY.optional(),
          assignee: z.string().min(1).optional(),
        },
      },
      async (args) => reply(await call("POST", "/api/tasks", args)),
    );
  }
  if (mayCall(["PATCH", "/api/tasks/_"])) {
    server.registerTool(
      "update_task",
      {
        description:
          "Change a task. version is the task's version from your latest read; a stale one fails with the current task. priority null clears it; assignee null clears it.",
        inputSchema: {
          id: z.string().min(1),
          version: z.string().min(1),
          title: z.string().min(1).optional(),
          description: z.string().optional(),
          priority: TASK_PRIORITY.nullable().optional(),
          status: TASK_STATUS.optional(),
          assignee: z.string().min(1).nullable().optional(),
        },
      },
      async ({ id, ...body }) => reply(await call("PATCH", taskPath(id), body)),
    );
  }
  if (mayCall(["POST", "/api/tasks/_/claim"])) {
    server.registerTool(
      "claim_task",
      {
        description:
          "Claim a task: it moves to in_progress with the assignee you name (no assignee keeps the current one).",
        inputSchema: {
          id: z.string().min(1),
          assignee: z.string().min(1).optional(),
        },
      },
      async ({ id, assignee }) =>
        reply(
          await call(
            "POST",
            `${taskPath(id)}/claim`,
            assignee ? { assignee } : {},
          ),
        ),
    );
  }
  if (mayCall(["POST", "/api/tasks/_/done"])) {
    server.registerTool(
      "complete_task",
      {
        description: "Mark a task done.",
        inputSchema: { id: z.string().min(1) },
      },
      async ({ id }) => reply(await call("POST", `${taskPath(id)}/done`)),
    );
  }
}

// An agent's own asks, by the asks area at write. Answering an ask stays the
// member's.
function registerAskTools(
  server: McpServer,
  call: Call,
  mayCall: MayCall,
  asksPath: string,
) {
  const askPath = (askId: string) => `${asksPath}/${encodeURIComponent(askId)}`;
  const reply = (res: McpDispatchResult) =>
    res.status >= 200 && res.status < 300 ? json(res.body) : routeError(res);
  const ASK_OPTIONS = z.array(z.string().min(1)).min(1).max(10);

  if (mayCall(["POST", asksPath])) {
    server.registerTool(
      "open_ask",
      {
        description:
          "Ask your manager a question in their Inbox. options are the answers they can tap, recommended is your pick (one of the options), priority is P0-P4. The answer comes to your chat. step asks for a change only the member can make: an agent's access level (agent-access), one room of a member's room access (member-room; grant true gives it, false takes it), a member's role (member-role), a member's permission pack (member-pack; pack null for none), your manager's own preferences (member-preferences) or room lists (member-view; list shown, tucked, notif or push), the office settings (office-settings), the backup settings (backup-settings), a member's sign-in link (sign-in-link), a member's sign-out on every device (member-sessions), a member's pending sign-in links taken back (sign-in-links-revoke), a personal API token for the member (api-token), an API token revoked (api-token-revoke) or the office's outside access (office-access); set holds the keys to change. The card has an Apply button, and the ask closes when the change is made. A sign-in link or token shows only on the member's card, never to you. pack (token limits with areas) goes only with access office, folder or web.",
        inputSchema: {
          prompt: z.string().min(1),
          options: ASK_OPTIONS.optional(),
          recommended: z.string().min(1).optional(),
          priority: TASK_PRIORITY.optional(),
          step: z
            .discriminatedUnion("kind", [
              z.object({
                kind: z.literal("agent-access"),
                agentId: z.string().min(1),
                access: z.enum(AGENT_ACCESS_STOPS),
                pack: z.record(z.string(), z.unknown()).optional(),
              }),
              z.object({
                kind: z.literal("member-room"),
                username: z.string().min(1),
                roomId: z.string().min(1),
                grant: z.boolean(),
              }),
              z.object({
                kind: z.literal("member-role"),
                username: z.string().min(1),
                role: z.enum(["owner", "member"]),
              }),
              z.object({
                kind: z.literal("member-pack"),
                username: z.string().min(1),
                pack: z.record(z.string(), z.unknown()).nullable(),
              }),
              z.object({
                kind: z.literal("member-preferences"),
                set: z.record(z.string(), z.unknown()),
              }),
              z.object({
                kind: z.literal("member-view"),
                list: z.enum(["shown", "tucked", "notif", "push"]),
                roomId: z.string().min(1),
                on: z.boolean(),
              }),
              z.object({
                kind: z.literal("office-settings"),
                set: z.record(z.string(), z.unknown()),
              }),
              z.object({
                kind: z.literal("backup-settings"),
                set: z.record(z.string(), z.unknown()),
              }),
              z.object({
                kind: z.literal("sign-in-link"),
                username: z.string().min(1),
              }),
              z.object({
                kind: z.literal("member-sessions"),
                username: z.string().min(1),
              }),
              z.object({
                kind: z.literal("sign-in-links-revoke"),
                username: z.string().min(1),
              }),
              z.object({
                kind: z.literal("api-token"),
                name: z.string().min(1),
                expiresInDays: z.union([
                  z.literal(30),
                  z.literal(365),
                  z.null(),
                ]),
                limits: z.record(z.string(), z.unknown()).optional(),
              }),
              z.object({
                kind: z.literal("api-token-revoke"),
                tokenId: z.string().min(1),
              }),
              z.object({
                kind: z.literal("office-access"),
                externalAccess: z.boolean(),
                publicOrigin: z.string(),
              }),
            ])
            .optional(),
        },
      },
      async (args) => reply(await call("POST", asksPath, args)),
    );
  }
  if (mayCall(["GET", asksPath])) {
    server.registerTool(
      "list_my_asks",
      {
        description: "List your open asks.",
        annotations: { readOnlyHint: true },
      },
      async () => reply(await call("GET", asksPath)),
    );
  }
  if (mayCall(["PATCH", askPath("_")])) {
    server.registerTool(
      "edit_ask",
      {
        description:
          "Change one of your open asks. An absent field keeps its value; options [] removes them; priority null removes it.",
        inputSchema: {
          askId: z.string().min(1),
          prompt: z.string().min(1).optional(),
          options: z.array(z.string().min(1)).max(10).optional(),
          recommended: z.string().optional(),
          priority: TASK_PRIORITY.nullable().optional(),
        },
      },
      async ({ askId, ...body }) =>
        reply(await call("PATCH", askPath(askId), body)),
    );
  }
  if (mayCall(["DELETE", askPath("_")])) {
    server.registerTool(
      "delete_ask",
      {
        description: "Delete one of your open asks.",
        inputSchema: { askId: z.string().min(1) },
      },
      async ({ askId }) => {
        const res = await call("DELETE", askPath(askId));
        return res.status >= 200 && res.status < 300
          ? json({ deleted: askId })
          : routeError(res);
      },
    );
  }
}

interface AgentRow {
  id: string;
  name: string;
  roomName: string;
  topic?: string | null;
  pendingPrompt?: string | null;
  inFlightTurn?: unknown;
}

function replies(drain: ApiTokenInboxDrainRes) {
  return {
    entries: drain.entries,
    firstSequence: drain.firstSequence,
    latestSequence: drain.latestSequence,
  };
}

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function toolError(code: string, message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}` }],
  };
}

// A route's error envelope as a tool error, with the route's own code.
function routeError(res: McpDispatchResult): CallToolResult {
  const error = (res.body as { error?: { code?: unknown; message?: unknown } })
    ?.error;
  const code =
    typeof error?.code === "string" ? error.code : `http_${res.status}`;
  const message =
    typeof error?.message === "string" && error.message !== code
      ? error.message
      : `The office answered ${res.status}.`;
  return toolError(code, message);
}

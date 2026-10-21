// The office's MCP server at /mcp (streamable HTTP, stateless). A member adds
// it to Claude, Claude Code or Codex with a personal API token as the bearer.
// Each tool call is one office route, run through the REST executor as the
// token's identity, so the route's authorization, preconditions, audit row
// and room projection apply unchanged.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Identity } from "./identity/index.ts";
import type { ApiTokenInboxDrainRes } from "../shared/contract-shapes.ts";

export interface McpDispatchResult {
  status: number;
  body: unknown;
}

export interface McpEndpointDeps {
  // Runs one office route as `identity` through the REST executor, with
  // `via: "mcp"` in the handler context.
  dispatch(
    identity: Identity,
    method: "GET" | "POST",
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

const MAX_WAIT_SECONDS = 25;
const DEFAULT_CONVERSATION_LIMIT = 20;
const MAX_CONVERSATION_LIMIT = 100;

// One JSON-RPC exchange of the MCP streamable HTTP transport. The caller has
// already resolved `identity` to a personal API token.
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

function buildServer(
  identity: Identity,
  deps: McpEndpointDeps,
  requestSignal: AbortSignal,
): McpServer {
  const server = new McpServer({ name: "isomux", version: "1.0.0" });
  const call = (method: "GET" | "POST", path: string, body?: unknown) =>
    deps.dispatch(identity, method, path, body);

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

  server.registerTool(
    "send_message",
    {
      description:
        "Send a message to an agent as the member. Returns the sequence of the message in this token's log; pass it to read_replies as `after`. The agent's reply can take minutes.",
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
        sentAt: number;
        sequence: number;
      };
      return json({
        messageId: sent.messageId,
        sentAt: sent.sentAt,
        sequence: sent.sequence,
      });
    },
  );

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

  return server;
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

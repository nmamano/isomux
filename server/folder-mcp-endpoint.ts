// Isomux's isomux_files MCP server at /mcp/files (streamable HTTP,
// stateless): the file tools of a Codex agent at the folder and web stops
// (server/folder-files.ts). Only that agent's own token gets in.
//
// Why MCP and not the app-server's dynamicTools: Codex fixes a thread's
// dynamic tools at thread/start, and thread/resume takes them from the
// thread's history (codex 0.164 core/src/session/mod.rs). A move on the
// access slider resumes the thread, so an agent moved from Standard to
// Folder would have no file tools, and one moved down to Office would keep
// them. An MCP server goes in the thread config, which every start and
// resume sends again.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { stopHasFolder, type AgentAccess } from "../shared/agent-access.ts";
import type { Identity } from "./identity/index.ts";
import { MCP_MAX_TOOL_INPUT_ELEMENTS } from "./mcp-endpoint.ts";
import {
  FOLDER_FILES_MCP_SERVER,
  type FolderFilesRequest,
  type FolderFilesResult,
  type FolderFilesTool,
} from "./folder-files.ts";

export {
  FOLDER_FILES_MCP_PATH,
  FOLDER_FILES_MCP_SERVER,
} from "./folder-files.ts";

// The agent as the server's record has it at the time of the call.
export interface FolderFilesAgent {
  agentType: string;
  access: AgentAccess;
  folder: string;
  codexHome?: string;
}

export interface FolderMcpDeps {
  // null: no such agent.
  agentNow(agentId: string): FolderFilesAgent | null;
  run(req: FolderFilesRequest): Promise<FolderFilesResult>;
}

function errorResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { code, message: code } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const PATH_HINT =
  "An absolute path, or a path relative to your folder. Only files inside your folder can be read.";

// The tools, with Codex's own descriptions shortened. Arguments are checked
// in the child (folder-files.ts); the schemas only describe them.
const TOOLS: {
  name: FolderFilesTool;
  description: string;
  inputSchema: Record<string, z.ZodType>;
}[] = [
  {
    name: "read_file",
    description:
      "Reads a text file in your folder, with line numbers (L<n>: text).",
    inputSchema: {
      file_path: z.string().describe(PATH_HINT),
      offset: z
        .number()
        .optional()
        .describe("The line to start at, from 1. Default 1."),
      limit: z
        .number()
        .optional()
        .describe("The number of lines to read. Default 2000."),
    },
  },
  {
    name: "list_dir",
    description:
      "Lists a folder inside your folder, indented by depth: '/' after a folder, '@' after a symlink, which it does not follow.",
    inputSchema: {
      dir_path: z.string().describe(PATH_HINT),
      offset: z
        .number()
        .optional()
        .describe("The entry to start at, from 1. Default 1."),
      limit: z
        .number()
        .optional()
        .describe("The number of entries to list. Default 25."),
      depth: z
        .number()
        .optional()
        .describe("How many levels to list. Default 2."),
    },
  },
  {
    name: "grep_files",
    description:
      "Finds the files in your folder with a line that matches a regular expression, newest first. Gives the paths, not the lines: read a file with read_file.",
    inputSchema: {
      pattern: z.string().describe("A JavaScript regular expression."),
      include: z
        .string()
        .optional()
        .describe('A glob that the files must match, for example "*.ts".'),
      path: z
        .string()
        .optional()
        .describe(
          `The folder or file to search. Default: your folder. ${PATH_HINT}`,
        ),
      limit: z
        .number()
        .optional()
        .describe("The number of paths to give. Default 100, at most 2000."),
    },
  },
];

function buildServer(agent: FolderFilesAgent, deps: FolderMcpDeps): McpServer {
  const server = new McpServer(
    { name: FOLDER_FILES_MCP_SERVER, version: "1.0.0" },
    { maxToolInputElements: MCP_MAX_TOOL_INPUT_ELEMENTS },
  );
  for (const tool of TOOLS)
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: true },
      },
      async (args): Promise<CallToolResult> => {
        const result = await deps.run({
          tool: tool.name,
          args,
          folder: agent.folder,
          access: agent.access,
          ...(agent.codexHome ? { codexHome: agent.codexHome } : {}),
        });
        return result.ok
          ? { content: [{ type: "text", text: result.text }] }
          : { content: [{ type: "text", text: result.error }], isError: true };
      },
    );
  return server;
}

// One JSON-RPC exchange. 403 unless `identity` is the token of a Codex agent
// whose stop, now, has the folder tools.
export async function handleFolderMcpRequest(
  req: Request,
  identity: Identity | null,
  deps: FolderMcpDeps,
): Promise<Response> {
  if (!identity) {
    const res = errorResponse(401, "unauthenticated");
    res.headers.set("WWW-Authenticate", "Bearer");
    return res;
  }
  // The record now, not the stop the token was issued at.
  const agent =
    identity.scope === "agent" && identity.agentId
      ? deps.agentNow(identity.agentId)
      : null;
  if (!agent || agent.agentType !== "codex" || !stopHasFolder(agent.access))
    return errorResponse(403, "forbidden");
  // Stateless, as /mcp: no SSE stream (GET) or session end (DELETE).
  if (req.method !== "POST") {
    const res = errorResponse(405, "method_not_allowed");
    res.headers.set("Allow", "POST");
    return res;
  }
  const server = buildServer(agent, deps);
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

import type { NormalizedEvent } from "../types.ts";
import {
  openCodeSupervisor,
  type OpenCodeLease,
  type OpenCodeSupervisor,
} from "./supervisor.ts";

export interface OpenCodeTransportOptions {
  cwd: string;
  model: string;
  supervisor?: OpenCodeSupervisor;
  sessionId?: string;
  contractShapeSink?: (shape: string) => void;
}

type EventSink = (event: NormalizedEvent) => void;

export class OpenCodeTransport {
  private readonly supervisor: OpenCodeSupervisor;
  private readonly cwd: string;
  private readonly model: string;
  private readonly resumedSessionId?: string;
  private readonly contractShapeSink?: (shape: string) => void;
  private lease: OpenCodeLease | null = null;
  private sessionId: string | null = null;
  private abortController: AbortController | null = null;
  private closed = false;

  constructor(options: OpenCodeTransportOptions) {
    this.supervisor = options.supervisor ?? openCodeSupervisor;
    this.cwd = options.cwd;
    this.model = options.model;
    this.resumedSessionId = options.sessionId;
    this.contractShapeSink = options.contractShapeSink;
  }

  async initialize(sink: EventSink): Promise<string> {
    if (this.sessionId) return this.sessionId;
    this.lease = await this.supervisor.acquire();
    if (this.resumedSessionId) {
      this.sessionId = this.resumedSessionId;
    } else {
      const response = await this.request("/session", {
        method: "POST",
        body: JSON.stringify({ title: "Isomux OpenCode session" }),
      });
      const body = allowSession(await response.json());
      this.contractShapeSink?.("http:session:{id:string}");
      this.sessionId = body.id;
    }
    sink({ kind: "system_init", sessionId: this.sessionId, model: this.model });
    return this.sessionId;
  }

  async send(text: string, sink: EventSink): Promise<void> {
    const sessionId = await this.initialize(sink);
    this.lease!.beginTurn();
    this.abortController = new AbortController();
    const eventsReady = this.consumeEvents(sessionId, sink, this.abortController.signal);
    await eventsReady;
    const [providerID, modelID] = splitModel(this.model);
    try {
      await this.request(`/session/${encodeURIComponent(sessionId)}/prompt_async`, {
        method: "POST",
        body: JSON.stringify({
          model: { providerID, modelID },
          parts: [{ type: "text", text }],
        }),
      });
      this.contractShapeSink?.("http:prompt_async:success");
    } catch (error) {
      this.abortController.abort();
      this.lease!.endTurn();
      sink({
        kind: "turn_completed",
        status: "failed",
        error: error instanceof Error ? error.message : "OpenCode request failed.",
      });
    }
  }

  async abort(): Promise<void> {
    if (!this.sessionId) return;
    await this.request(`/session/${encodeURIComponent(this.sessionId)}/abort`, {
      method: "POST",
    }).catch(() => undefined);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abortController?.abort();
    this.lease?.endTurn();
    this.lease?.release();
  }

  private async consumeEvents(
    sessionId: string,
    sink: EventSink,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.request("/event", { signal });
    if (!response.body) throw new Error("OpenCode event stream has no body.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const assistantMessages = new Set<string>();
    const textByPart = new Map<string, string>();
    let buffer = "";
    void (async () => {
      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer = `${buffer}${decoder.decode(value, { stream: true })}`.replaceAll(
            "\r\n",
            "\n",
          );
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (!data) continue;
            const event = parseAllowedEvent(data);
            if (!event || event.sessionId !== sessionId) continue;
            this.contractShapeSink?.(`sse:${event.kind}`);
            if (event.kind === "assistant") assistantMessages.add(event.messageId);
            if (event.kind === "text" && assistantMessages.has(event.messageId)) {
              const prior = textByPart.get(event.partId) ?? "";
              if (event.text.startsWith(prior)) {
                const delta = event.text.slice(prior.length);
                if (delta) sink({ kind: "assistant_text", text: delta });
              }
              textByPart.set(event.partId, event.text);
            }
            if (event.kind === "idle") {
              this.lease?.endTurn();
              sink({ kind: "turn_completed", status: "completed" });
              this.abortController?.abort();
              return;
            }
            if (event.kind === "error") {
              this.lease?.endTurn();
              sink({
                kind: "turn_completed",
                status: "failed",
                error: "OpenCode reported a provider or transport error.",
              });
              this.abortController?.abort();
              return;
            }
          }
        }
        if (!signal.aborted) {
          this.lease?.endTurn();
          sink({
            kind: "turn_completed",
            status: "failed",
            error: "OpenCode event stream ended before turn completion.",
          });
        }
      } catch (error) {
        if (!signal.aborted) {
          this.lease?.endTurn();
          sink({
            kind: "turn_completed",
            status: "failed",
            error: `OpenCode event stream failed: ${error instanceof Error ? error.message : "unknown error"}`,
          });
        }
      }
    })();
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.lease) throw new Error("OpenCode transport is not initialized.");
    const url = new URL(path, this.lease.baseUrl);
    url.searchParams.set("directory", this.cwd);
    const response = await fetch(url, {
      ...init,
      headers: {
        authorization: this.lease.authHeader,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`OpenCode HTTP ${response.status} at ${path}.`);
    }
    return response;
  }
}

function splitModel(model: string): [string, string] {
  const slash = model.indexOf("/");
  if (slash < 1 || slash === model.length - 1) {
    throw new Error("OpenCode model must use provider/model form.");
  }
  return [model.slice(0, slash), model.slice(slash + 1)];
}

function allowSession(raw: unknown): { id: string } {
  if (!raw || typeof raw !== "object" || typeof (raw as { id?: unknown }).id !== "string") {
    throw new Error("OpenCode returned an invalid session shape.");
  }
  return { id: (raw as { id: string }).id };
}

type AllowedEvent =
  | { kind: "assistant"; sessionId: string; messageId: string }
  | { kind: "text"; sessionId: string; messageId: string; partId: string; text: string }
  | { kind: "idle"; sessionId: string }
  | { kind: "error"; sessionId: string };

export function parseAllowedEvent(data: string): AllowedEvent | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = raw.type;
  const properties = asRecord(raw.properties);
  const sessionId = stringField(properties, "sessionID");
  if (!sessionId) return null;
  if (type === "session.idle") return { kind: "idle", sessionId };
  if (type === "session.error") return { kind: "error", sessionId };
  if (type === "message.updated") {
    const info = asRecord(properties.info);
    const messageId = stringField(info, "id");
    if (info.role === "assistant" && messageId) {
      return { kind: "assistant", sessionId, messageId };
    }
  }
  if (type === "message.part.updated") {
    const part = asRecord(properties.part);
    const messageId = stringField(part, "messageID");
    const partId = stringField(part, "id");
    const text = stringField(part, "text");
    if (part.type === "text" && messageId && partId && text !== null) {
      return { kind: "text", sessionId, messageId, partId, text };
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

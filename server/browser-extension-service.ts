import manifest from "../browser-extension/manifest.json";
import { browserDisplay } from "./browser-extension-display";
import type { ServerWebSocket } from "bun";
import {
  BrowserExtensionBridge,
  browserCredentialHash,
  type ExtensionConnection,
} from "./browser-extension-bridge";
import {
  BrowserExtensionStore,
  extensionOrigin,
} from "./browser-extension-store";
import {
  BROWSER_EXTENSION_PROTOCOL,
  fields,
} from "../shared/browser-extension-protocol";

export interface ExtensionWsData {
  kind: "extension";
  origin: string;
  connection?: ExtensionConnection;
  deadline?: ReturnType<typeof setTimeout>;
  heartbeat?: ReturnType<typeof setInterval>;
  lastPong?: number;
  credentialHash?: string;
}
export const EXTENSION_SOCKET_PATH = "/browser-extension/ws";
export const EXTENSION_MAX_BYTES = 8 * 1024 * 1024;

// The host classifier runs first. This separate socket never uses office auth.
export function extensionUpgradeAllowed(
  req: Request,
  canonicalOrigin: string,
): boolean {
  const url = new URL(req.url);
  const canonical = new URL(canonicalOrigin);
  return (
    req.method === "GET" &&
    url.pathname === EXTENSION_SOCKET_PATH &&
    !url.search &&
    req.headers.get("host") === canonical.host &&
    (canonical.protocol === "https:" ||
      (canonical.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(canonical.hostname))) &&
    extensionOrigin(req.headers.get("origin") ?? "")
  );
}

export class BrowserExtensionService {
  readonly bridge: BrowserExtensionBridge;
  private sockets = new Set<ServerWebSocket<ExtensionWsData>>();
  constructor(
    readonly store: BrowserExtensionStore,
    private access: {
      memberExists(member: string): boolean;
      mayUse(member: string, agent: string): boolean;
      memberName?(member: string): string;
      agentName?(agent: string): string;
      agents?(member: string): string[];
    },
  ) {
    this.bridge = new BrowserExtensionBridge({
      memberForCredentialHash: (hash) => {
        const member = store.memberForHash(hash);
        return member && access.memberExists(member) ? member : undefined;
      },
      agents: (member) => access.agents?.(member) ?? [],
      mayUse: (member, agent) =>
        store.record(member).backend === "extension" &&
        access.mayUse(member, agent),
      ...(access.memberName && access.agentName
        ? {
            memberDisplay: (member: string) =>
              browserDisplay(member, access.memberName!(member)),
            agentDisplay: (agent: string) =>
              browserDisplay(agent, access.agentName!(agent)),
          }
        : {}),
    });
  }
  status(member: string) {
    return {
      member: browserDisplay(
        member,
        this.access.memberName?.(member) ?? member,
      ),
      version: manifest.version,
      backend: this.store.record(member).backend,
      selectionRequired: this.store.record(member).backend === null,
      paired: !!this.store.record(member).hash,
      online: !!this.bridge.forMember(member),
    };
  }
  disconnect(member: string, terminal = false): void {
    for (const ws of this.sockets) {
      if (ws.data.connection?.memberId !== member) continue;
      if (terminal) ws.send(JSON.stringify({ kind: "refused" }));
      ws.data.connection.close();
      ws.close(terminal ? 4003 : 1000);
    }
  }
  revalidate(): void {
    for (const ws of this.sockets) {
      const connection = ws.data.connection;
      if (!connection) continue;
      if (!this.access.memberExists(connection.memberId))
        this.disconnect(connection.memberId, true);
      else connection.revalidate();
    }
  }
  open(ws: ServerWebSocket<ExtensionWsData>): void {
    this.sockets.add(ws);
    ws.data.deadline = setTimeout(() => ws.close(1008), 5000);
  }
  message(ws: ServerWebSocket<ExtensionWsData>, data: string | Buffer): void {
    try {
      if (
        Buffer.byteLength(data) >
        (ws.data.connection ? EXTENSION_MAX_BYTES : 4096)
      )
        throw new Error();
      const msg = fields(JSON.parse(String(data)));
      if (!ws.data.connection) {
        if (
          msg.version !== BROWSER_EXTENSION_PROTOCOL ||
          msg.kind !== "hello" ||
          !extensionOrigin(ws.data.origin)
        )
          throw new Error();
        let credential: string;
        if (typeof msg.code === "string" && msg.credential === undefined) {
          const paired = this.store.redeem(msg.code, ws.data.origin, (member) =>
            this.access.memberExists(member),
          );
          this.disconnect(paired.member, true);
          credential = paired.credential;
          ws.send(
            JSON.stringify({
              kind: "paired",
              version: BROWSER_EXTENSION_PROTOCOL,
              credential,
            }),
          );
        } else if (
          typeof msg.credential === "string" &&
          msg.code === undefined &&
          /^[A-Za-z0-9_-]{43}$/.test(msg.credential)
        )
          credential = msg.credential;
        else throw new Error();
        if (
          !this.store.memberForHash(
            browserCredentialHash(credential),
            ws.data.origin,
          )
        )
          throw new Error();
        ws.data.connection = this.bridge.connect(credential, {
          send: (value) => {
            ws.send(JSON.stringify(value));
          },
          close: () => ws.close(),
        });
        ws.data.credentialHash = browserCredentialHash(credential);
        clearTimeout(ws.data.deadline);
        ws.data.lastPong = Date.now();
        ws.data.heartbeat = setInterval(() => this.heartbeat(ws), 15_000);
        ws.data.heartbeat.unref?.();
      } else if (msg.kind === "unpair") {
        const connection = ws.data.connection;
        if (
          msg.generation !== connection.generation ||
          this.bridge.forMember(connection.memberId) !== connection ||
          !this.access.memberExists(connection.memberId) ||
          this.store.memberForHash(ws.data.credentialHash!, ws.data.origin) !==
            connection.memberId
        )
          throw new Error();
        this.store.revoke(connection.memberId);
        ws.send(
          JSON.stringify({
            kind: "unpaired",
            generation: connection.generation,
          }),
        );
        connection.close();
      } else if (
        msg.kind === "pong" &&
        msg.generation === ws.data.connection.generation
      ) {
        ws.data.lastPong = Date.now();
      } else ws.data.connection.receive(msg);
    } catch {
      ws.send(JSON.stringify({ kind: "refused" }));
      ws.data.connection?.close();
      ws.close(4003);
    }
  }
  heartbeat(ws: ServerWebSocket<ExtensionWsData>): void {
    this.revalidate();
    if (!this.sockets.has(ws)) return;
    if (Date.now() - ws.data.lastPong! > 45_000) {
      ws.data.connection?.close();
      return;
    }
    ws.send(
      JSON.stringify({
        kind: "ping",
        generation: ws.data.connection?.generation,
      }),
    );
  }
  close(ws: ServerWebSocket<ExtensionWsData>): void {
    clearTimeout(ws.data.deadline);
    clearInterval(ws.data.heartbeat);
    this.sockets.delete(ws);
    ws.data.connection?.close();
  }
  stop(): void {
    for (const ws of [...this.sockets]) {
      this.close(ws);
      ws.close();
    }
  }
}

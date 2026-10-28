import { recordAudit } from "./audit-store.ts";
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
  extensionOutdated,
  fields,
  validExtensionPackage,
  type Fields,
  type MemberBrowserStatus,
} from "../shared/browser-extension-protocol";

export interface ExtensionWsData {
  kind: "extension";
  origin: string;
  connection?: ExtensionConnection;
  deadline?: ReturnType<typeof setTimeout>;
  heartbeat?: ReturnType<typeof setInterval>;
  // The last message from the extension, of any kind: a sign of life.
  lastSeen?: number;
  // The code for the socket close that the connection's own close sends.
  closeCode?: number;
  credentialHash?: string;
}
export const EXTENSION_SOCKET_PATH = "/browser-extension/ws";
export const EXTENSION_MAX_BYTES = 8 * 1024 * 1024;

// The host classifier runs first. This separate socket never uses office auth.
// The Origin check only keeps web pages out: a page cannot send a
// chrome-extension Origin, but any non-browser client can. The control is the
// first frame's pairing code or credential (both 256 bits, see
// browser-extension-store.ts). A wrong one closes the socket and leaves the
// member's live code and connections alone.
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
  // The package each credential's extension reported in this server run; null
  // when its hello had none (before 0.4.5). Read only for paired browsers.
  private packages = new Map<string, string | null>();
  constructor(
    readonly store: BrowserExtensionStore,
    private access: {
      memberExists(member: string): boolean;
      mayUse(member: string, agent: string): boolean;
      memberName?(member: string): string;
      agentName?(agent: string): string;
      agents?(member: string): string[];
      officeOrigins?(): string[];
    },
  ) {
    this.bridge = new BrowserExtensionBridge({
      memberForCredentialHash: (hash) => {
        const member = store.memberForHash(hash);
        return member && access.memberExists(member) ? member : undefined;
      },
      browserName: (hash) => store.browserForHash(hash)?.browser.name ?? "",
      agents: (member) => access.agents?.(member) ?? [],
      mayUse: (member, agent) => access.mayUse(member, agent),
      officeOrigins: () => access.officeOrigins?.() ?? [],
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
  status(member: string): MemberBrowserStatus {
    const browsers = this.store.browsers(member).map((b) => {
      const reported = this.packages.get(b.hash);
      return {
        id: b.id,
        name: b.name,
        pairedAt: b.pairedAt,
        online: !!this.bridge.forCredentialHash(b.hash),
        ...(reported === undefined ? {} : { package: reported }),
        outdated: extensionOutdated(reported, manifest.version),
      };
    });
    return {
      member: browserDisplay(
        member,
        this.access.memberName?.(member) ?? member,
      ),
      version: manifest.version,
      paired: browsers.length > 0,
      online: browsers.some((b) => b.online),
      browsers,
    };
  }
  // Names of the member's paired browsers whose extension is out of date.
  outdatedBrowsers(member: string): string[] {
    return this.store
      .browsers(member)
      .filter((b) =>
        extensionOutdated(this.packages.get(b.hash), manifest.version),
      )
      .map((b) => b.name);
  }
  // Ends the member's live connections, or only the one with this credential.
  disconnect(
    member: string,
    terminal = false,
    credentialHash?: string,
    cause = "revoked",
  ): void {
    for (const ws of this.sockets) {
      if (ws.data.connection?.memberId !== member) continue;
      if (
        credentialHash !== undefined &&
        ws.data.credentialHash !== credentialHash
      )
        continue;
      if (terminal) ws.send(JSON.stringify({ kind: "refused" }));
      this.end(ws, cause, terminal ? 4003 : 1000);
    }
  }
  revalidate(): void {
    for (const ws of this.sockets) {
      const connection = ws.data.connection;
      if (!connection) continue;
      if (!this.access.memberExists(connection.memberId))
        this.disconnect(connection.memberId, true, undefined, "member_removed");
      else connection.revalidate();
    }
  }
  open(ws: ServerWebSocket<ExtensionWsData>): void {
    this.sockets.add(ws);
    ws.data.deadline = setTimeout(() => ws.close(1008), 5000);
  }
  message(ws: ServerWebSocket<ExtensionWsData>, data: string | Buffer): void {
    const bytes = Buffer.byteLength(data);
    const live = ws.data.connection;
    let msg: Fields | undefined;
    if (live) {
      ws.data.lastSeen = Date.now();
      // After the hello, a message the service cannot take ends this
      // connection with a code the extension reconnects after. Refused and
      // 4003 make it stop until the member pairs again (task f63edd81).
      try {
        msg = fields(JSON.parse(String(data)));
      } catch {
        this.end(ws, "bad_message", 1008, { bytes });
        return;
      }
      if (msg.kind === "pong") return;
      if (msg.kind !== "unpair") {
        try {
          if (bytes > EXTENSION_MAX_BYTES) live.receiveOversized(msg, bytes);
          else live.receive(msg);
        } catch {
          this.end(ws, "receive_error", 1008, { bytes });
        }
        return;
      }
    }
    try {
      if (!live && bytes > 4096) throw new Error();
      msg ??= fields(JSON.parse(String(data)));
      if (!ws.data.connection) {
        if (
          msg.version !== BROWSER_EXTENSION_PROTOCOL ||
          msg.kind !== "hello" ||
          !extensionOrigin(ws.data.origin) ||
          (msg.package !== undefined && !validExtensionPackage(msg.package))
        )
          throw new Error();
        let credential: string;
        if (typeof msg.code === "string" && msg.credential === undefined) {
          const paired = this.store.redeem(msg.code, ws.data.origin, (member) =>
            this.access.memberExists(member),
          );
          recordAudit({
            actor: {
              kind: "member",
              id: paired.member,
              name: this.access.memberName?.(paired.member) ?? paired.member,
            },
            operation: "browserExtension.pair",
            targets: [paired.browser],
            fields: [],
          });
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
          close: () => ws.close(ws.data.closeCode),
        });
        console.info(
          "[browser-extension] " +
            JSON.stringify({
              reason: "connection_opened",
              generation: ws.data.connection.generation,
              auth: typeof msg.code === "string" ? "code" : "credential",
              ...(validExtensionPackage(msg.package)
                ? { package: msg.package }
                : {}),
            }),
        );
        ws.data.credentialHash = browserCredentialHash(credential);
        this.packages.set(
          ws.data.credentialHash,
          validExtensionPackage(msg.package) ? msg.package : null,
        );
        clearTimeout(ws.data.deadline);
        ws.data.lastSeen = Date.now();
        ws.data.heartbeat = setInterval(() => this.heartbeat(ws), 15_000);
        ws.data.heartbeat.unref?.();
      } else if (msg.kind === "unpair") {
        const connection = ws.data.connection;
        if (
          msg.generation !== connection.generation ||
          this.bridge.forCredentialHash(ws.data.credentialHash!) !==
            connection ||
          !this.access.memberExists(connection.memberId) ||
          this.store.memberForHash(ws.data.credentialHash!, ws.data.origin) !==
            connection.memberId
        )
          throw new Error();
        const browser = this.store.browserForHash(ws.data.credentialHash!)!;
        this.store.revokeBrowser(connection.memberId, browser.browser.id);
        recordAudit({
          actor: {
            kind: "member",
            id: connection.memberId,
            name:
              this.access.memberName?.(connection.memberId) ??
              connection.memberId,
          },
          operation: "browserExtension.unpair",
          targets: [browser.browser.id],
          fields: [],
        });
        ws.send(
          JSON.stringify({
            kind: "unpaired",
            generation: connection.generation,
          }),
        );
        connection.close("unpaired");
      }
    } catch {
      ws.send(JSON.stringify({ kind: "refused" }));
      this.end(ws, "refused", 4003);
    }
  }
  // Ends the socket's connection with a logged cause, and the socket with
  // code.
  private end(
    ws: ServerWebSocket<ExtensionWsData>,
    cause: string,
    code: number,
    detail: Fields = {},
  ): void {
    ws.data.closeCode = code;
    ws.data.connection?.close(cause, detail);
    ws.close(code);
  }
  heartbeat(ws: ServerWebSocket<ExtensionWsData>): void {
    this.revalidate();
    if (!this.sockets.has(ws)) return;
    const silent = Date.now() - ws.data.lastSeen!;
    if (silent > 45_000) {
      ws.data.connection?.close("pong_overdue", {
        msSinceLastMessage: silent,
      });
      return;
    }
    ws.send(
      JSON.stringify({
        kind: "ping",
        generation: ws.data.connection?.generation,
      }),
    );
  }
  close(
    ws: ServerWebSocket<ExtensionWsData>,
    code?: number,
    reason?: string,
  ): void {
    clearTimeout(ws.data.deadline);
    clearInterval(ws.data.heartbeat);
    this.sockets.delete(ws);
    ws.data.connection?.close("socket_closed", {
      ...(code === undefined ? {} : { code }),
      ...(reason ? { closeReason: reason.slice(0, 120) } : {}),
    });
  }
  stop(): void {
    for (const ws of [...this.sockets]) {
      this.close(ws);
      ws.close();
    }
  }
}

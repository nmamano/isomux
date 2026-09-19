import { createHash } from "node:crypto";
import {
  BROWSER_EXTENSION_PROTOCOL,
  fields,
  pageCommandAllowed,
  type BridgePeer,
  type Fields,
} from "../shared/browser-extension-protocol";

export const browserCredentialHash = (credential: string): string =>
  createHash("sha256").update(credential).digest("hex");

type Pending = {
  assignment: string;
  resolve(value: Fields): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
type Assignment = {
  id: string;
  agentId: string;
  session: string;
  browserSession: string;
  peer: BridgePeer;
  target?: Fields;
  children: Map<string, string>;
  popups: Map<string, Fields>;
  creating: boolean;
  closed: boolean;
};

// No HTTP listener or production route is registered here. The caller supplies
// a browser-only hash lookup and live member/agent authorization on every use.
export class BrowserExtensionBridge {
  private connections = new Map<string, ExtensionConnection>();
  constructor(
    private readonly access: {
      memberForCredentialHash(hash: string): string | undefined;
      mayUse(memberId: string, agentId: string): boolean;
    },
  ) {}

  connect(credential: string, peer: BridgePeer): ExtensionConnection {
    const hash = browserCredentialHash(credential);
    const member = this.access.memberForCredentialHash(hash);
    if (!member || this.connections.has(member))
      throw new Error("Browser connection refused");
    const connection = new ExtensionConnection(
      member,
      peer,
      (agent) =>
        this.access.memberForCredentialHash(hash) === member &&
        this.access.mayUse(member, agent),
      () => {
        if (this.connections.get(member) === connection)
          this.connections.delete(member);
      },
    );
    this.connections.set(member, connection);
    try {
      peer.send({
        kind: "ready",
        version: BROWSER_EXTENSION_PROTOCOL,
        generation: connection.generation,
      });
    } catch (error) {
      connection.close();
      throw error;
    }
    return connection;
  }

  forMember(memberId: string): ExtensionConnection | undefined {
    return this.connections.get(memberId);
  }
}

export class ExtensionConnection {
  readonly generation = crypto.randomUUID();
  private active = true;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private assignments = new Map<string, Assignment>();
  constructor(
    readonly memberId: string,
    private peer: BridgePeer,
    private authorize: (agentId: string) => boolean,
    private onClose: () => void,
  ) {}

  assign(
    agentId: string,
    peer: BridgePeer,
  ): { receive(message: unknown): Promise<void>; close(): void } {
    if (
      !this.active ||
      !this.authorize(agentId) ||
      [...this.assignments.values()].some((a) => a.agentId === agentId)
    ) {
      throw new Error("Browser assignment refused");
    }
    const assignment: Assignment = {
      id: crypto.randomUUID(),
      agentId,
      session: crypto.randomUUID(),
      browserSession: crypto.randomUUID(),
      peer,
      children: new Map(),
      popups: new Map(),
      creating: false,
      closed: false,
    };
    this.assignments.set(assignment.id, assignment);
    return {
      receive: (message) => this.dispatch(assignment, message),
      close: () => this.release(assignment),
    };
  }

  revalidate(): void {
    for (const a of this.assignments.values()) if (!this.authorize(a.agentId)) this.release(a);
  }

  private check(a: Assignment): void {
    if (
      !this.active ||
      a.closed ||
      this.assignments.get(a.id) !== a ||
      !this.authorize(a.agentId)
    ) {
      this.release(a);
      throw new Error("Browser control ended; pending outcomes may be unknown");
    }
  }

  private request(
    a: Assignment,
    method: string,
    params: Fields,
  ): Promise<Fields> {
    this.check(a);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), 30_000);
      this.pending.set(id, { assignment: a.id, resolve, reject, timer });
      try {
        this.peer.send({
          kind: "command",
          generation: this.generation,
          id,
          assignment: a.id,
          method,
          params,
        });
      } catch {
        this.close();
      }
    });
  }

  private knownTarget(targetId: string): boolean {
    return [...this.assignments.values()].some(
      (a) =>
        a.target?.targetId === targetId ||
        [...a.popups.values()].some((t) => t.targetId === targetId) ||
        [...a.children.values()].includes(targetId),
    );
  }

  receive(message: unknown): void {
    if (!this.active) return;
    try {
      const msg = fields(message);
      if (msg.generation !== this.generation) return;
      if (msg.kind === "result" && typeof msg.id === "number") {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        const owner = this.assignments.get(pending.assignment);
        if (!owner) return;
        if (!this.authorize(owner.agentId)) { this.release(owner); return; }
        this.check(owner);
        const result = msg.error ? undefined : fields(msg.result);
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.error) pending.reject(new Error("Browser command failed"));
        else pending.resolve(result!);
        return;
      }
      if (msg.kind !== "event" || typeof msg.assignment !== "string")
        throw new Error("Invalid event");
      const a = this.assignments.get(msg.assignment);
      if (!a) return;
      if (!this.authorize(a.agentId)) { this.release(a); return; }
      this.check(a);
      if (msg.method === "detached") {
        this.release(a);
        return;
      }
      if (!a.target || typeof msg.method !== "string") return;
      if (msg.method === "popup") {
        const params = fields(msg.params);
        const target = fields(params.targetInfo);
        const opener = [...a.popups.values()].at(-1) ?? a.target;
        if (target.type !== "page" || typeof target.targetId !== "string" || target.openerId !== opener.targetId || this.knownTarget(target.targetId) || typeof params.sessionId !== "string" || a.popups.size >= 8 || [...this.assignments.values()].some((owner) => owner.popups.has(params.sessionId as string) || owner.children.has(params.sessionId as string) || owner.session === params.sessionId || owner.browserSession === params.sessionId)) throw new Error("Invalid popup");
        a.popups.set(params.sessionId, target);
        a.peer.send({ method: "Target.attachedToTarget", params: { sessionId: params.sessionId, targetInfo: { ...target, attached: true }, waitingForDebugger: false } });
        return;
      }
      if (msg.method === "popupDetached") {
        const params = fields(msg.params);
        if (typeof params.sessionId !== "string") return;
        const popup = a.popups.get(params.sessionId);
        if (!popup) return;
        a.popups.delete(params.sessionId);
        a.peer.send({ method: "Target.detachedFromTarget", params: { sessionId: params.sessionId, targetId: popup.targetId } });
        return;
      }

      const child =
        typeof msg.sessionId === "string" ? msg.sessionId : undefined;
      if (child && !a.children.has(child) && !a.popups.has(child)) return;
      const params = fields(msg.params);
      if (msg.method === "Target.attachedToTarget") {
        const info = fields(params.targetInfo);
        if (
          info.type !== "iframe" ||
          typeof info.targetId !== "string" ||
          typeof params.sessionId !== "string" ||
          this.knownTarget(info.targetId) ||
          [...this.assignments.values()].some(
            (owner) =>
              owner.children.has(params.sessionId as string) ||
              owner.popups.has(params.sessionId as string) ||
              owner.session === params.sessionId ||
              owner.browserSession === params.sessionId,
          )
        )
          throw new Error("Invalid child target");
        a.children.set(params.sessionId, info.targetId);
      } else if (msg.method === "Target.detachedFromTarget") {
        if (
          typeof params.sessionId !== "string" ||
          !a.children.delete(params.sessionId)
        )
          return;
      } else if (msg.method.startsWith("Target.")) return;
      a.peer.send({
        method: msg.method,
        params,
        sessionId: child || a.session,
      });
    } catch {
      this.close();
    }
  }

  private async dispatch(a: Assignment, message: unknown): Promise<void> {
    let msg: Fields;
    try {
      msg = fields(message);
    } catch {
      this.release(a);
      return;
    }
    const { id, method, sessionId } = msg;
    if (!Number.isSafeInteger(id) || typeof method !== "string") {
      this.release(a);
      return;
    }
    try {
      this.check(a);
      const result = await this.command(
        a,
        method,
        fields(msg.params ?? {}),
        sessionId,
      );
      this.check(a);
      a.peer.send({ id, sessionId, result });
    } catch {
      if (this.active && !a.closed)
        a.peer.send({
          id,
          sessionId,
          error: { code: -32000, message: "Browser command refused or failed" },
        });
    }
  }

  private async command(
    a: Assignment,
    method: string,
    params: Fields,
    sessionId: unknown,
  ): Promise<Fields> {
    // A public newBrowserCDPSession remains a view of this assignment only.
    if (sessionId === a.browserSession) sessionId = undefined;
    if (sessionId === undefined) {
      switch (method) {
        case "Target.attachToBrowserTarget":
          return { sessionId: a.browserSession };
        case "Browser.getVersion":
          return {
            protocolVersion: "1.3",
            product: "Chrome/Extension",
            userAgent: "Chrome/Extension",
            revision: "",
          };
        case "Target.setAutoAttach":
          return {};
        case "Target.getTargets":
          return { targetInfos: a.target ? [a.target, ...a.popups.values()] : [] };
        case "Target.getTargetInfo":
          if (
            params.targetId !== undefined &&
            params.targetId !== a.target?.targetId
          )
            throw new Error("Unknown target");
          return a.target ? { targetInfo: a.target } : {};
        case "Target.createTarget": {
          if (
            a.target ||
            a.creating ||
            params.browserContextId !== undefined ||
            params.url !== "about:blank"
          )
            throw new Error("One task tab per agent");
          a.creating = true;
          const result = await this.request(a, "create", {});
          this.check(a);
          const target = fields(result.targetInfo);
          if (
            target.type !== "page" ||
            typeof target.targetId !== "string" ||
            this.knownTarget(target.targetId)
          )
            throw new Error("Invalid task target");
          a.target = target;
          a.peer.send({
            method: "Target.attachedToTarget",
            params: {
              sessionId: a.session,
              targetInfo: { ...target, attached: true },
              waitingForDebugger: false,
            },
          });
          return { targetId: target.targetId };
        }
        default:
          throw new Error("Unsupported browser command");
      }
    }
    if (
      typeof sessionId !== "string" ||
      !a.target ||
      (sessionId !== a.session && !a.children.has(sessionId) && !a.popups.has(sessionId))
    )
      throw new Error("Unknown session");
    if (method === "Target.getTargetInfo") {
      if (
        params.targetId !== undefined &&
        params.targetId !== (a.popups.get(sessionId)?.targetId ?? a.target.targetId)
      )
        throw new Error("Unknown target");
      return { targetInfo: a.popups.get(sessionId) ?? a.target };
    }
    if (!pageCommandAllowed(method, params))
      throw new Error("Unsupported page command");
    return this.request(a, "cdp", {
      method,
      params,
      sessionId: sessionId === a.session ? undefined : sessionId,
    });
  }

  private release(a: Assignment): void {
    if (a.closed) return;
    a.closed = true;
    this.assignments.delete(a.id);
    for (const [id, pending] of this.pending) {
      if (pending.assignment !== a.id) continue;
      clearTimeout(pending.timer);
      pending.reject(
        new Error("Browser control ended; pending outcomes may be unknown"),
      );
      this.pending.delete(id);
    }
    if (this.active) {
      try {
        this.peer.send({
          kind: "command",
          generation: this.generation,
          id: ++this.sequence,
          assignment: a.id,
          method: "detach",
          params: {},
        });
      } catch {}
    }
    a.peer.close();
  }

  close(): void {
    if (!this.active) return;
    this.active = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new Error("Browser disconnected; pending outcomes may be unknown"),
      );
    }
    this.pending.clear();
    for (const a of this.assignments.values()) this.release(a);
    this.onClose();
    this.peer.close();
  }
}

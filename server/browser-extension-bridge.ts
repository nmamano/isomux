import { createHash } from "node:crypto";
import {
  BROWSER_EXTENSION_PROTOCOL,
  validGrantDuration,
  validGrantScope,
  type BrowserGrantScope,
  type BrowserGrantDuration,
  fields,
  pageCommandAllowed,
  type BridgePeer,
  type Fields,
  type BrowserDisplay,
} from "../shared/browser-extension-protocol";

export const browserCredentialHash = (credential: string): string =>
  createHash("sha256").update(credential).digest("hex");

type Pending = {
  assignment: string;
  resolve(value: Fields): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  done: Promise<void>;
  settled(): void;
  timedOut: boolean;
};
interface GrantClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}
const grantClock: GrantClock = {
  now: () => Date.now(),
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};
type Assignment = {
  durationMinutes: BrowserGrantDuration;
  expiresAt: number | null;
  cancelExpiry?: () => void;
  id: string;
  scope: BrowserGrantScope;
  handle: string;
  session: string;
  browserSession: string;
  peer: BridgePeer;
  target?: Fields;
  children: Map<string, string>;
  popups: Map<string, Fields>;
  leafTargetId?: string;
  creating: boolean;
  connected: boolean;
  announced: boolean;
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
      memberDisplay?(member: string): BrowserDisplay;
      agentDisplay?(agent: string): BrowserDisplay;
      agents?(member: string): string[];
    },
    private clock: GrantClock = grantClock,
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
      this.access.memberDisplay
        ? () => this.access.memberDisplay!(member)
        : undefined,
      this.access.agentDisplay
        ? (agent) => this.access.agentDisplay!(agent)
        : undefined,
      () => this.access.agents?.(member) ?? [],
      this.clock,
      () => this.access.memberForCredentialHash(hash) === member,
    );
    this.connections.set(member, connection);
    try {
      peer.send({
        kind: "ready",
        version: BROWSER_EXTENSION_PROTOCOL,
        generation: connection.generation,
      });
      connection.sendMetadata();
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
    private memberDisplay?: () => BrowserDisplay,
    private agentDisplay?: (agent: string) => BrowserDisplay,
    private agents: () => string[] = () => [],
    private clock: GrantClock = grantClock,
    private ownerValid: () => boolean = () => true,
  ) {}

  assign(
    agentId: string,
    peer: BridgePeer,
    retainGrant = false,
    target?: string,
  ): { receive(message: unknown): Promise<void>; close(): void } {
    const id = this.offered(agentId, target);
    const assignment = id ? this.assignments.get(id) : undefined;
    if (!this.active || !this.authorize(agentId) || !assignment?.target || assignment.connected || this.pendingCount(assignment.id))
      throw new Error("Offer a tab with Allow agent control in the Chrome extension popup");
    this.check(assignment);
    assignment.peer = peer;
    assignment.connected = true;
    assignment.announced = false;
    return {
      receive: (message) => assignment.peer === peer && assignment.connected
        ? this.dispatch(assignment, message, agentId, peer) : Promise.resolve(),
      close: () => {
        if (!retainGrant) { this.release(assignment); return; }
        if (assignment.peer !== peer) return;
        assignment.connected = false;
        assignment.peer = { send() {}, close() {} };
      },
    };
  }

  private accessible(a: Assignment, agent: string): boolean {
    return this.active && this.ownerValid() && this.authorize(agent) &&
      (a.scope.kind === "all" || a.scope.agentId === agent);
  }

  targets(agent: string): { target: string; scope: BrowserGrantScope; title: string; url: string }[] {
    const result = [];
    for (const a of this.assignments.values()) {
      if (this.expired(a)) { this.release(a); continue; }
      if (!a.target || !this.accessible(a, agent)) continue;
      const page = [...a.popups.values()].find(t => t.targetId === a.leafTargetId) ?? a.target;
      result.push({ target: a.handle, scope: a.scope, title: typeof page.title === "string" ? page.title : "",
        url: typeof page.url === "string" ? page.url : "" });
    }
    return result;
  }

  offered(agentId: string, target?: string): string | undefined {
    const available = this.targets(agentId);
    const chosen = target !== undefined ? available.find(a => a.target === target) :
      available.find(a => a.scope.kind === "agent") ?? (available.length === 1 ? available[0] : undefined);
    return chosen ? [...this.assignments.values()].find(a => a.handle === chosen.target)?.id : undefined;
  }

  ambiguous(agent: string): boolean {
    const available = this.targets(agent);
    return !available.some(a => a.scope.kind === "agent") && available.length > 1;
  }

  revoke(agentId: string, target?: string): void {
    const id = this.offered(agentId, target);
    const a = id ? this.assignments.get(id) : undefined;
    if (a) this.release(a);
  }

  private authorized(a: Assignment): boolean {
    return this.ownerValid() && (a.scope.kind === "all" || this.authorize(a.scope.agentId));
  }

  private async offer(id: string, scope: BrowserGrantScope, durationMinutes: BrowserGrantDuration): Promise<void> {
    if (!this.ownerValid() || (scope.kind === "agent" && !this.authorize(scope.agentId)) || this.assignments.has(id) ||
        (scope.kind === "agent" && [...this.assignments.values()].some((a) => a.scope.kind === "agent" && a.scope.agentId === scope.agentId))) {
      this.peer.send({ kind: "offered", generation: this.generation, assignment: id, error: true });
      return;
    }
    const a: Assignment = {
      durationMinutes, expiresAt: null,
      id, scope, handle: crypto.randomUUID(), session: crypto.randomUUID(), browserSession: crypto.randomUUID(),
      peer: { send() {}, close() {} }, children: new Map(), popups: new Map(),
      creating: true, connected: false, announced: false, closed: false,
    };
    this.assignments.set(id, a);
    try {
      const result = await this.request(a, "attach", {});
      this.check(a);
      const target = fields(result.targetInfo);
      if (target.type !== "page" || typeof target.targetId !== "string" ||
          typeof target.url !== "string" || !/^https?:\/\//.test(target.url) || this.knownTarget(target.targetId))
        throw new Error("Invalid offered target");
      a.target = target;
      a.creating = false;
      a.expiresAt = durationMinutes === 0 ? null : this.clock.now() + durationMinutes * 60_000;
      if (a.expiresAt !== null) a.cancelExpiry = this.clock.schedule(() => {
        if (this.assignments.get(id) === a) this.release(a);
      }, durationMinutes * 60_000);
      this.peer.send({ kind: "offered", generation: this.generation, assignment: id,
        scope, durationMinutes, expiresAt: a.expiresAt });
      this.sendMetadata();
    } catch {
      this.release(a);
      if (this.active) this.peer.send({ kind: "offered", generation: this.generation, assignment: id, error: true });
    }
  }

  revalidate(): void {
    for (const a of this.assignments.values())
      if (!this.authorized(a) || this.expired(a)) this.release(a);
    this.sendMetadata();
  }

  sendMetadata(): void {
    if (!this.active || !this.memberDisplay || !this.agentDisplay) return;
    this.peer.send({
      kind: "metadata",
      generation: this.generation,
      member: this.memberDisplay(),
      agents: this.agents().filter((agent) => this.authorize(agent)).map((agent) => this.agentDisplay!(agent)),
      assignments: [...this.assignments.values()]
        .filter((a) => a.target && this.authorized(a))
        .map((a) => ({ id: a.id, scope: a.scope, ...(a.scope.kind === "agent" ? { agent: this.agentDisplay!(a.scope.agentId) } : {}), durationMinutes: a.durationMinutes, expiresAt: a.expiresAt })),
    });
  }

  private expired(a: Assignment): boolean {
    return a.expiresAt !== null && this.clock.now() >= a.expiresAt;
  }

  private check(a: Assignment): void {
    if (
      !this.active ||
      a.closed ||
      this.expired(a) ||
      this.assignments.get(a.id) !== a ||
      !this.authorized(a)
    ) {
      this.release(a);
      throw new Error("Browser control ended; pending outcomes may be unknown");
    }
  }

  async stopLoading(grant: string): Promise<void> {
    const a = this.assignments.get(grant);
    if (!a) throw new Error("Browser control ended");
    this.check(a);
    const popup = [...a.popups].find(([, target]) => target.targetId === a.leafTargetId);
    await this.request(a, "cdp", { method: "Page.stopLoading", params: {},
      sessionId: popup?.[0] });
  }

  pendingCount(grant: string): number {
    return [...this.pending.values()].filter(p => p.assignment === grant).length;
  }

  pendingTimedOut(grant: string): boolean {
    return [...this.pending.values()].some(p => p.assignment === grant && p.timedOut);
  }

  async drain(grant: string): Promise<void> {
    while (this.pendingCount(grant))
      await Promise.all([...this.pending.values()].filter(p => p.assignment === grant).map(p => p.done));
  }

  private request(
    a: Assignment,
    method: string,
    params: Fields,
  ): Promise<Fields> {
    this.check(a);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      let settled!: () => void;
      const done = new Promise<void>(r => { settled = r; });
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        if (method === "attach") { this.release(a); return; }
        // A timeout is not evidence of socket loss. Retain this entry until the
        // real response or ownership loss, so the next action cannot overtake it.
        pending.timedOut = true;
        reject(new Error("Browser command timed out"));
      }, 30_000);
      this.pending.set(id, { assignment: a.id, resolve, reject, timer, done, settled, timedOut: false });
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
      if (msg.kind === "offer") {
        if (typeof msg.assignment !== "string" || !/^[a-f0-9-]{36}$/.test(msg.assignment) || !validGrantScope(msg.scope) || !validGrantDuration(msg.durationMinutes))
          throw new Error("Invalid offer");
        void this.offer(msg.assignment, msg.scope, msg.durationMinutes);
        return;
      }
      if (msg.kind === "agents") { this.revalidate(); return; }
      if (msg.kind === "result" && typeof msg.id === "number") {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        const owner = this.assignments.get(pending.assignment);
        if (!owner) return;
        if (!this.authorized(owner) || this.expired(owner)) {
          this.release(owner);
          return;
        }
        this.check(owner);
        const result = msg.error ? undefined : fields(msg.result);
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        pending.settled();
        if (pending.timedOut) return;
        if (msg.error) pending.reject(new Error("Browser command failed"));
        else pending.resolve(result!);
        return;
      }
      if (msg.kind !== "event" || typeof msg.assignment !== "string")
        throw new Error("Invalid event");
      const a = this.assignments.get(msg.assignment);
      if (!a) return;
      if (!this.authorized(a) || this.expired(a)) {
        this.release(a);
        return;
      }
      this.check(a);
      if (msg.method === "detached") {
        this.release(a);
        return;
      }
      if (!a.target || typeof msg.method !== "string") return;
      if (msg.method === "popup") {
        const params = fields(msg.params);
        const target = fields(params.targetInfo);
        const openerId = a.leafTargetId ?? a.target.targetId;
        if (
          target.type !== "page" ||
          typeof target.targetId !== "string" ||
          target.openerId !== openerId ||
          this.knownTarget(target.targetId) ||
          typeof params.sessionId !== "string" ||
          a.popups.size >= 8 ||
          [...this.assignments.values()].some(
            (owner) =>
              owner.popups.has(params.sessionId as string) ||
              owner.children.has(params.sessionId as string) ||
              owner.session === params.sessionId ||
              owner.browserSession === params.sessionId,
          )
        )
          throw new Error("Invalid popup");
        a.popups.set(params.sessionId, target);
        a.leafTargetId = target.targetId;
        a.peer.send({
          method: "Target.attachedToTarget",
          params: {
            sessionId: params.sessionId,
            targetInfo: { ...target, attached: true },
            waitingForDebugger: false,
          },
        });
        return;
      }
      if (msg.method === "popupDetached") {
        const params = fields(msg.params);
        if (typeof params.sessionId !== "string") return;
        const popup = a.popups.get(params.sessionId);
        if (!popup) return;
        a.popups.delete(params.sessionId);
        if (a.leafTargetId === popup.targetId)
          a.leafTargetId = popup.openerId as string;
        a.peer.send({
          method: "Target.detachedFromTarget",
          params: { sessionId: params.sessionId, targetId: popup.targetId },
        });
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

  private async dispatch(a: Assignment, message: unknown, actor: string, peer: BridgePeer): Promise<void> {
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
      if (a.peer !== peer || !this.accessible(a, actor)) throw new Error("Browser control ended");
      const result = await this.command(
        a,
        method,
        fields(msg.params ?? {}),
        sessionId,
      );
      this.check(a);
      if (!this.accessible(a, actor)) throw new Error("Browser control ended");
      if (a.peer === peer) peer.send({ id, sessionId, result });
    } catch {
      if (this.active && !a.closed && a.peer === peer)
        peer.send({
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
          if (a.target && !a.announced) {
            a.announced = true;
            a.peer.send({ method: "Target.attachedToTarget", params: {
              sessionId: a.session, targetInfo: { ...a.target, attached: true }, waitingForDebugger: false,
            } });
            for (const [sessionId, target] of a.popups) a.peer.send({ method: "Target.attachedToTarget", params: {
              sessionId, targetInfo: { ...target, attached: true }, waitingForDebugger: false,
            } });
          }
          return {};
        case "Target.getTargets":
          return {
            targetInfos: a.target ? [a.target, ...a.popups.values()] : [],
          };
        case "Target.getTargetInfo":
          if (
            params.targetId !== undefined &&
            params.targetId !== a.target?.targetId
          )
            throw new Error("Unknown target");
          return a.target ? { targetInfo: a.target } : {};
        default:
          throw new Error("Unsupported browser command");
      }
    }
    if (
      typeof sessionId !== "string" ||
      !a.target ||
      (sessionId !== a.session &&
        !a.children.has(sessionId) &&
        !a.popups.has(sessionId))
    )
      throw new Error("Unknown session");
    if (method === "Target.getTargetInfo") {
      if (
        params.targetId !== undefined &&
        params.targetId !==
          (a.popups.get(sessionId)?.targetId ?? a.target.targetId)
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
    console.info("[browser-extension] " + JSON.stringify({ reason: "grant_released", generation: this.generation,
      assignment: a.id, controlSession: a.session, pending: this.pendingCount(a.id) }));
    a.closed = true;
    a.cancelExpiry?.();
    this.assignments.delete(a.id);
    for (const [id, pending] of this.pending) {
      if (pending.assignment !== a.id) continue;
      clearTimeout(pending.timer);
      pending.settled();
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
    this.sendMetadata();
  }

  close(): void {
    if (!this.active) return;
    this.active = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.settled();
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

// The Contabo implementation of the portable provider seam.
//
// TWO MEASURED FACTS ABOUT THIS API SHAPE THE WHOLE FILE (both verified live on
// 2026-08-09, both written up in control-plane/README.md):
//
//   1. Unrecognised query parameters are SILENTLY IGNORED. `?foo=bar` returns
//      the full unfiltered instance list rather than a 400. So a `find` that
//      trusts the server-side filter would, on a typo or a silent API change,
//      hand back an unrelated box - and adopting the wrong box is the
//      paid-duplicate failure class this design exists to prevent. Every row
//      the server returns is therefore re-verified here, and a response
//      containing any non-matching row is evidence the filter was ignored.
//
//   2. The documented default login user is not the one you get. `defaultUser`
//      is documented as defaulting to "admin", but a create that omits it
//      produces an `ubuntu` account - which is not even an accepted request
//      value (the enum is root/admin/administrator). We therefore always send
//      it explicitly and carry the chosen user forward as run evidence, rather
//      than letting first contact guess which account holds our key.
//
// Contabo offers NO idempotency key for the paid create endpoint (see
// http.ts), so an ambiguous create is resolvable only by `find`.

import { IndeterminateProviderError } from "../provider.ts";
import type {
  AssetState,
  CancelResult,
  CreateOutcome,
  CreateRequest,
  FindResult,
  InstanceView,
  LoginUser,
  PowerState,
  ProviderAdapter,
  RecyclableProvider,
  ReinstallRequest,
} from "../provider.ts";
import type { ContaboHttp } from "./http.ts";

/**
 * Raised when a search can neither find the box nor prove it is absent.
 *
 * The portable signature is `FindResult | null` and that is fixed by the design,
 * so "we cannot tell" has no value to return. It must not borrow `null`: null
 * is a claim of absence, and an unsound search has not earned it. Throwing is
 * what routes this to a human, which is exactly where the design sends an
 * unresolvable intent.
 */
export class IndeterminateFindError extends IndeterminateProviderError {}

/**
 * Prefix stamped into `displayName` so `find` has something to match on.
 *
 * The separator is a HYPHEN, not a colon, and that is not cosmetic. Measured
 * live 2026-08-09 (slice 2): Contabo validates displayName and answers
 * `400 {"message":["Only numbers, letters, spaces and - allowed."]}` to anything
 * else. A colon-separated stamp - which is what slice 1 shipped - would have
 * made every live create fail at the provider, and no fixture could catch it
 * because the rule lives on their side. Slice 1 never ordered a box, so the
 * defect was invisible until a real request carried the stamp.
 */
export const INTENT_STAMP_PREFIX = "isomux-cp-";

/** What the provider accepts in a displayName, measured rather than assumed. */
const PROVIDER_LEGAL_DISPLAY_NAME = /^[A-Za-z0-9 -]+$/;

export function intentStamp(intentId: string): string {
  const stamp = `${INTENT_STAMP_PREFIX}${intentId}`;
  if (!PROVIDER_LEGAL_DISPLAY_NAME.test(stamp)) {
    // Fail here rather than at the provider: a create rejected for a malformed
    // name is a wasted round trip on the one call that must not be repeated
    // blind, and `find` would then have nothing to match on either.
    throw new Error(
      `intent id ${JSON.stringify(intentId)} cannot be stamped into a Contabo ` +
        `displayName: only numbers, letters, spaces and - are accepted`,
    );
  }
  return stamp;
}

interface ContaboInstanceRow {
  instanceId?: number;
  displayName?: string;
  status?: string;
  cancelDate?: string | null;
  ipConfig?: { v4?: { ip?: string } };
}

interface ContaboListBody {
  data?: ContaboInstanceRow[];
  _pagination?: { totalElements?: number };
}

export interface ContaboAdapterOptions {
  http: ContaboHttp;
  /** Image to build from. Ubuntu 24.04 for this product. */
  imageId: string;
  /** Contract length in months. Contabo has no hourly billing; 1 is the floor. */
  periodMonths?: number;
  loginUser: LoginUser;
}

export class ContaboAdapter implements ProviderAdapter, RecyclableProvider {
  private readonly http: ContaboHttp;
  private readonly imageId: string;
  private readonly periodMonths: number;
  readonly loginUser: LoginUser;

  constructor(opts: ContaboAdapterOptions) {
    this.http = opts.http;
    this.imageId = opts.imageId;
    this.periodMonths = opts.periodMonths ?? 1;
    this.loginUser = opts.loginUser;
  }

  async create(req: CreateRequest): Promise<CreateOutcome> {
    const result = await this.http.request("POST", "/v1/compute/instances", {
      imageId: this.imageId,
      productId: req.plan,
      region: req.region,
      sshKeys: req.publicKeys,
      period: this.periodMonths,
      displayName: intentStamp(req.intentId),
      defaultUser: this.loginUser,
    });
    if (result.kind === "ambiguous") {
      return { outcome: "ambiguous", reason: result.reason };
    }
    if (result.kind === "rejected") {
      return { outcome: "rejected", reason: result.reason };
    }
    const id = firstRow(result.body)?.instanceId;
    if (id === undefined) {
      // A 2xx we cannot read is not a rejection: the box may well exist. Treat
      // it the way an unreadable outcome deserves to be treated.
      return {
        outcome: "ambiguous",
        reason: "provider accepted the order but returned no instanceId",
      };
    }
    return { outcome: "created", providerId: String(id) };
  }

  async get(providerId: string): Promise<InstanceView> {
    const result = await this.http.request(
      "GET",
      `/v1/compute/instances/${encodeURIComponent(providerId)}`,
    );
    if (result.kind === "rejected" && result.status === 404) {
      return { assetState: "absent", powerState: "unknown", raw: null };
    }
    // The transport's outcome CLASS has to survive this boundary. A timeout or a
    // 5xx establishes nothing about the instance, and collapsing it into a plain
    // Error would have the audit trail claim we learned it was gone.
    if (result.kind === "ambiguous") {
      throw new IndeterminateProviderError(
        `get(${providerId}) could not establish anything: ${result.reason}`,
      );
    }
    if (result.kind !== "ok") {
      throw new Error(`get(${providerId}) failed: ${result.reason}`);
    }
    const row = firstRow(result.body);
    if (!row) {
      // A 2xx we cannot read is not a refusal either.
      throw new IndeterminateProviderError(
        `get(${providerId}) returned a response with no readable instance row`,
      );
    }
    return {
      assetState: assetStateOf(row),
      powerState: powerStateOf(row.status),
      ipv4: row.ipConfig?.v4?.ip,
      raw: row,
    };
  }

  async reboot(providerId: string): Promise<void> {
    await this.action(providerId, "restart");
  }

  async powerOff(providerId: string): Promise<void> {
    await this.action(providerId, "stop");
  }

  async powerOn(providerId: string): Promise<void> {
    await this.action(providerId, "start");
  }

  async cancel(providerId: string): Promise<CancelResult> {
    const body = await this.http.okOrThrow(
      "POST",
      `/v1/compute/instances/${encodeURIComponent(providerId)}/cancel`,
    );
    const row = firstRow(body);
    return {
      assetState: "cancel_scheduled",
      serviceEndsAt: row?.cancelDate ?? undefined,
    };
  }

  /**
   * Resolve an intent to a box, reporting how much it can prove.
   *
   * `exact` is claimed only when the server honoured the filter AND exactly one
   * row matches. Anything else - a non-matching row in the response, more than
   * one match, or a total count larger than the page we read - is `unproven`,
   * which the machine escalates to a human rather than acting on.
   */
  async find(intentId: string): Promise<FindResult | null> {
    const stamp = intentStamp(intentId);
    const result = await this.http.request(
      "GET",
      `/v1/compute/instances?size=100&displayName=${encodeURIComponent(stamp)}`,
    );
    if (result.kind !== "ok") {
      throw new Error(`find(${intentId}) failed: ${result.reason}`);
    }
    const body = result.body as ContaboListBody | null;
    const rows = body?.data ?? [];
    const matches = rows.filter((r) => r.displayName === stamp);

    // The filter was ignored if the server handed back anything we did not ask
    // for. That also means the page we read is a slice of the WHOLE account.
    const filterHonoured = matches.length === rows.length;
    const total = body?._pagination?.totalElements;
    // Affirmative evidence only. A response with NO pagination metadata does
    // not prove we saw everything - it proves we were told nothing - so it can
    // never support an `exact` claim.
    const sawEverything = typeof total === "number" && total <= rows.length;

    if (matches.length === 0) {
      // "Nothing on this page" is only "no box" when we can show the search was
      // sound. If the filter was ignored, or the response was a slice, absence
      // is unestablished - and reporting it as a clean null would let a caller
      // treat an unfound-but-existing box as never created.
      if (filterHonoured && sawEverything) return null;
      throw new IndeterminateFindError(
        `find(${intentId}) cannot establish absence: ` +
          `${filterHonoured ? "the filter was honoured" : "the server ignored the filter"}, ` +
          `${sawEverything ? "the response was complete" : "the response was incomplete or unlabelled"}. ` +
          `This needs a human; it is not evidence that no box exists.`,
      );
    }
    const id = matches[0]?.instanceId;
    if (id === undefined) {
      throw new IndeterminateFindError(
        `find(${intentId}) matched a row with no instanceId`,
      );
    }
    const proven = filterHonoured && sawEverything && matches.length === 1;
    return {
      providerId: String(id),
      confidence: proven ? "exact" : "unproven",
    };
  }

  async reinstall(providerId: string, req: ReinstallRequest): Promise<void> {
    await this.http.okOrThrow(
      "PUT",
      `/v1/compute/instances/${encodeURIComponent(providerId)}`,
      {
        imageId: req.imageId,
        sshKeys: req.publicKeys,
        defaultUser: req.loginUser,
      },
    );
  }

  /**
   * Upload a public key as a Contabo "secret" so it can be injected at build
   * time. Contabo-specific: the portable interface takes provider-side key
   * handles and says nothing about how they got there.
   */
  async createSshSecret(name: string, publicKeyLine: string): Promise<number> {
    const body = await this.http.okOrThrow("POST", "/v1/secrets", {
      name,
      value: publicKeyLine,
      type: "ssh",
    });
    const id = (body as { data?: { secretId?: number }[] } | null)?.data?.[0]
      ?.secretId;
    if (id === undefined) {
      throw new Error(
        "Contabo accepted the key secret but returned no secretId",
      );
    }
    return id;
  }

  async deleteSecret(secretId: number): Promise<void> {
    await this.http.okOrThrow("DELETE", `/v1/secrets/${secretId}`);
  }

  private async action(providerId: string, name: string): Promise<void> {
    await this.http.okOrThrow(
      "POST",
      `/v1/compute/instances/${encodeURIComponent(providerId)}/actions/${name}`,
    );
  }
}

function firstRow(body: unknown): ContaboInstanceRow | undefined {
  const rows = (body as ContaboListBody | null)?.data;
  return Array.isArray(rows) ? rows[0] : undefined;
}

function assetStateOf(row: ContaboInstanceRow): AssetState {
  if (row.cancelDate) return "cancel_scheduled";
  switch (row.status) {
    case "provisioning":
    case "installing":
    case "manual_provisioning":
    case "pending_payment":
      return "order_pending";
    case "product_not_available":
    case "verification_required":
      return "order_ambiguous";
    default:
      return "active";
  }
}

function powerStateOf(status: string | undefined): PowerState {
  if (status === "running") return "running";
  if (status === "stopped") return "stopped";
  return "unknown";
}

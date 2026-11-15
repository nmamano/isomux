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
  SshPublicKey,
} from "../provider.ts";
import { KEY_ALGORITHM_FIELD, KEY_BLOB_FIELD } from "../key-lines.ts";
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
  /** Unknown until read: a non-empty string is the only product we report. */
  productId?: unknown;
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

const ROOT_AUTHORIZED_KEYS = "/root/.ssh/authorized_keys";

/**
 * The cloud-init user data that puts our keys on the box at its first boot, or
 * undefined when there are no keys.
 *
 * The key travels in the create call itself, so no build depends on Contabo's
 * secrets service (task e4eaba24: from 2026-11-14 that service failed every
 * create while a paying customer waited). It lands as a bare line in root's authorized_keys, the same
 * line Contabo's sshKeys wrote, so first contact, the expiry rewrite and
 * revocation see what they always saw.
 *
 * write_files, not cloud-init's ssh_authorized_keys: that module also puts the
 * key on the image's default sudo user, where revocation never looks. The
 * content starts with a newline because append is a plain append: a file with
 * no final newline would otherwise swallow our line into its last one. Every
 * scalar is JSON-quoted, which YAML reads as a double-quoted string.
 */
export function renderKeyUserData(
  loginUser: LoginUser,
  keys: SshPublicKey[],
): string | undefined {
  if (keys.length === 0) return undefined;
  if (loginUser !== "root") {
    // /home/<user> does not exist yet when write_files runs, and only root's
    // file is where revocation looks for it.
    throw new Error(
      `the run key can only be installed for root, not ${JSON.stringify(loginUser)}`,
    );
  }
  const lines = keys.map((k) => {
    if (
      !KEY_ALGORITHM_FIELD.test(k.algorithm) ||
      !KEY_BLOB_FIELD.test(k.blob)
    ) {
      throw new Error(
        "a run key must be one supported algorithm and one base64 blob",
      );
    }
    return `${k.algorithm} ${k.blob} isomux-cp\n`;
  });
  return (
    "#cloud-config\n" +
    "write_files:\n" +
    `  - path: ${JSON.stringify(ROOT_AUTHORIZED_KEYS)}\n` +
    `    content: ${JSON.stringify(`\n${lines.join("")}`)}\n` +
    '    owner: "root:root"\n' +
    '    permissions: "0600"\n' +
    "    append: true\n"
  );
}

function userDataField(
  loginUser: LoginUser,
  keys: SshPublicKey[],
): { userData?: string } {
  const userData = renderKeyUserData(loginUser, keys);
  return userData === undefined ? {} : { userData };
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
      ...userDataField(this.loginUser, req.publicKeys),
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
      ...(typeof row.productId === "string" && row.productId
        ? { product: row.productId }
        : {}),
      ...(row.instanceId === undefined || row.instanceId === null
        ? {}
        : { providerId: String(row.instanceId) }),
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
        ...userDataField(req.loginUser, req.publicKeys),
        defaultUser: req.loginUser,
      },
    );
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

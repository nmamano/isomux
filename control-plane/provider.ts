// The provider-agnostic seam for the hosted control plane.
//
// These seven signatures are fixed by internal-docs/control-plane-design.md and
// are not ours to extend: a provider-specific capability (Contabo's reinstall,
// used only to recycle a test box) lives on its own extension interface so the
// portable surface keeps meaning what the design says it means.
//
// Two properties the shapes carry deliberately:
//
//   - `create` returns an outcome CLASS rather than throwing, because
//     "ambiguous" needs different handling from "rejected". An ambiguous create
//     may already have spent money, so it is never retried - only resolved by
//     `find`. See intents.ts, which latches that rule durably.
//   - `find` reports how much it can prove. An adapter whose search is
//     best-effort must say `unproven`, and the machine treats that as grounds
//     for a human rather than as a reconciliation.

/**
 * A provider answer that establishes nothing - neither that the thing is there
 * nor that it is absent.
 *
 * It lives on the portable seam rather than inside one adapter because callers
 * have to treat it as ambiguity wherever it comes from: an audit row that says
 * `failed` for it would claim we learned something we did not.
 */
export class IndeterminateProviderError extends Error {}

/** What a create attempt actually established. Never thrown, always returned. */
export type CreateOutcome =
  | { outcome: "created"; providerId: string }
  | { outcome: "rejected"; reason: string }
  | { outcome: "ambiguous"; reason: string };

/** What we are paying for, as the provider sees it. */
export type AssetState =
  | "none"
  | "order_pending"
  | "order_ambiguous"
  | "active"
  | "cancel_scheduled"
  | "cancelled"
  | "absent";

export type PowerState = "running" | "stopped" | "unknown";

export interface InstanceView {
  assetState: AssetState;
  powerState: PowerState;
  ipv4?: string;
  /** The provider's own payload, kept for evidence. Never logged wholesale. */
  raw: unknown;
}

export interface CancelResult {
  assetState: AssetState;
  /** When service actually ends. Not every provider destroys on request. */
  serviceEndsAt?: string;
}

export interface FindResult {
  providerId: string;
  confidence: "exact" | "unproven";
}

export interface CreateRequest {
  /** Our intent id, so a repeated call can be correlated after an ambiguity. */
  intentId: string;
  plan: string;
  region: string;
  /** Provider-side handles for the public keys to inject at build time. */
  publicKeys: number[];
}

export interface ProviderAdapter {
  create(req: CreateRequest): Promise<CreateOutcome>;
  get(providerId: string): Promise<InstanceView>;
  reboot(providerId: string): Promise<void>;
  powerOff(providerId: string): Promise<void>;
  powerOn(providerId: string): Promise<void>;
  cancel(providerId: string): Promise<CancelResult>;
  find(intentId: string): Promise<FindResult | null>;
}

/**
 * Capabilities that exist on one provider and are not part of the portable
 * contract. Recycling a box between test cycles is the only slice-1 user: the
 * product model never requires a provider to be able to wipe and rebuild an
 * instance in place, so demanding it of every adapter would be inventing a
 * requirement the installer does not have.
 */
export interface RecyclableProvider {
  /**
   * Wipe and rebuild in place. Returns when the provider has accepted the
   * request, not when the box is reachable - callers wait on SSH themselves.
   */
  reinstall(providerId: string, req: ReinstallRequest): Promise<void>;
}

export interface ReinstallRequest {
  imageId: string;
  publicKeys: number[];
  /**
   * Which account the injected key lands on. Always sent explicitly: Contabo
   * documents a default that its images do not honour (see contabo/adapter.ts),
   * so relying on the default would mean guessing the login user on first
   * contact - and first contact is not a place for a fallback ladder.
   */
  loginUser: LoginUser;
}

/** The values Contabo's API accepts. `ubuntu` is NOT among them, even though a
 * default create produces exactly that account - the discrepancy is the reason
 * this type exists rather than a bare string. */
export type LoginUser = "root" | "admin" | "administrator";

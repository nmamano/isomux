import { createHash, randomBytes } from "node:crypto";
import type { Store } from "./store.ts";
import { clearAttention, raiseAttention } from "./attention.ts";

export const CERTIFICATE_CONTACT_STALE_MS = 3 * 24 * 60 * 60 * 1_000;
export const CERTIFICATE_CONTACT_REASON =
  "the hosted office has stopped checking certificate renewal";
/** A live office whose subscription is active or trialing has no active
 * credential, so its box cannot renew. The box still holds the token of the
 * newest credential issued to it. */
export const CERTIFICATE_CREDENTIAL_MISSING_REASON =
  "the hosted office has no active certificate renewal credential, so its " +
  "certificate will not renew; re-activate its newest revoked credential";

export interface CertificateCredentialRow {
  id: string;
  instance_id: string;
  token_hash: string;
  status: "active" | "revoked";
  created_at: number;
  /** The last status report from the box, not the last renew call. */
  last_used_at: number | null;
  revoked_at: number | null;
  version: number;
}

export interface IssuedCertificateCredential {
  id: string;
  token: string;
}

function digest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function issueCertificateCredential(
  store: Store,
  instanceId: string,
): Promise<IssuedCertificateCredential> {
  const instance = await store.getInstance(instanceId);
  if (!instance || instance.service_state === "deprovisioned") {
    throw new Error("cannot issue a renewal identity for an inactive office");
  }
  const reservation = await store.sqlGet<{ instance_id: string }>(
    "select instance_id from name_reservations where instance_id = $1",
    [instanceId],
  );
  if (!reservation) {
    throw new Error(
      "cannot issue a renewal identity without a permanent name reservation",
    );
  }
  const token = randomBytes(32).toString("base64url");
  const id = `certcred-${randomBytes(12).toString("hex")}`;
  const now = store.now();
  await store.sqlRun(
    "insert into certificate_credentials (id, instance_id, token_hash, status, created_at, last_used_at, revoked_at, version) " +
      "values ($1, $2, $3, 'active', $4, null, null, 1)",
    [id, instanceId, digest(token), now],
  );
  return { id, token };
}

/**
 * `contact` marks a status report. Only a status report stamps last_used_at,
 * which is what the contact watch reads: a renew call can authenticate and
 * still never deliver its answer to the box.
 */
export async function authenticateCertificateCredential(
  store: Store,
  token: string,
  opts: { contact?: boolean } = {},
): Promise<{ row: CertificateCredentialRow; names: [string, string] } | null> {
  if (token.length < 32 || token.length > 256) return null;
  const wanted = digest(token);
  const row = await store.sqlGet<CertificateCredentialRow>(
    "select * from certificate_credentials where token_hash = $1 and status = 'active'",
    [wanted],
  );
  if (!row) return null;
  const instance = await store.getInstance(row.instance_id);
  if (!instance || instance.service_state === "deprovisioned") return null;
  const reservation = await store.sqlGet<{ instance_id: string }>(
    "select instance_id from name_reservations where instance_id = $1",
    [row.instance_id],
  );
  if (!reservation) return null;
  const contactAt = opts.contact ? store.now() : null;
  const updated = await store.sqlGet<CertificateCredentialRow>(
    "update certificate_credentials set last_used_at = coalesce($1, last_used_at), version = version + 1 " +
      "where id = $2 and version = $3 and status = 'active' returning *",
    [contactAt, row.id, row.version],
  );
  if (!updated) return null;
  return { row: updated, names: [instance.name, `*.${instance.name}`] };
}

export async function revokeCertificateCredentials(
  store: Store,
  instanceId: string,
): Promise<number> {
  const rows = await store.sqlAll<CertificateCredentialRow>(
    "update certificate_credentials set status = 'revoked', revoked_at = $1, version = version + 1 " +
      "where instance_id = $2 and status = 'active' returning *",
    [store.now(), instanceId],
  );
  return rows.length;
}

/**
 * The office is live and its subscription is active or trialing. A
 * subscription that cancels at period end counts, unlike PAYING_SQL in
 * lifecycle.ts: the office runs, and must renew, until it is deprovisioned.
 */
async function liveWithSubscription(
  store: Store,
  instanceId: string,
): Promise<boolean> {
  const row = await store.sqlGet<{ id: string }>(
    "select i.id from instances i where i.id = $1 and i.service_state = 'live' " +
      "and exists (select 1 from subscriptions s where s.instance_id = i.id " +
      "and s.status in ('active', 'trialing'))",
    [instanceId],
  );
  return row !== null;
}

/** Clear the open rows of one reason that this watch raised. */
export async function clearCertificateWatchReason(
  store: Store,
  instanceId: string,
  reason: string,
): Promise<void> {
  for (const row of await store.openReasons(instanceId)) {
    if (row.source_op_id !== "" || row.reason !== reason) continue;
    await clearAttention(
      store,
      instanceId,
      row.id,
      "certificate-renewal-watch",
    );
  }
}

/**
 * Raise durable operator attention after three missed daily renewal checks,
 * and when a live office with an active or trialing subscription has no active
 * credential.
 */
export async function applyCertificateContactAttention(
  store: Store,
  instanceId: string,
): Promise<void> {
  const active = await store.sqlAll<CertificateCredentialRow>(
    "select * from certificate_credentials where instance_id = $1 and status = 'active'",
    [instanceId],
  );
  const openReasons = await store.openReasons(instanceId);
  const open = openReasons.filter(
    (row) =>
      row.source_op_id === "" && row.reason === CERTIFICATE_CONTACT_REASON,
  );
  if (active.length === 0) {
    for (const row of open) {
      await clearAttention(
        store,
        instanceId,
        row.id,
        "certificate-renewal-watch",
      );
    }
    // A revoked credential is refused, so the box makes no contact and the
    // stale-contact row cannot say so: this row does.
    if (!(await liveWithSubscription(store, instanceId))) {
      await clearCertificateWatchReason(
        store,
        instanceId,
        CERTIFICATE_CREDENTIAL_MISSING_REASON,
      );
    } else if (
      !openReasons.some(
        (row) =>
          row.source_op_id === "" &&
          row.reason === CERTIFICATE_CREDENTIAL_MISSING_REASON,
      )
    ) {
      await raiseAttention(store, {
        instanceId,
        sourceOpId: "",
        reasonClass: "operation_condition",
        reason: CERTIFICATE_CREDENTIAL_MISSING_REASON,
        severity: "critical",
        actor: "certificate-renewal-watch",
      });
    }
    return;
  }
  await clearCertificateWatchReason(
    store,
    instanceId,
    CERTIFICATE_CREDENTIAL_MISSING_REASON,
  );
  const newestContact = Math.max(
    ...active.map((row) => row.last_used_at ?? row.created_at),
  );
  if (store.now() - newestContact <= CERTIFICATE_CONTACT_STALE_MS) {
    // Recovery is reconciled by the daily sweep, so a cleared three-day stale
    // condition can remain visible for up to one day. That delay is accepted
    // in exchange for taking this check off the per-minute liveness path.
    for (const row of open) {
      await clearAttention(
        store,
        instanceId,
        row.id,
        "certificate-renewal-watch",
      );
    }
    return;
  }
  if (open.length === 0) {
    await raiseAttention(store, {
      instanceId,
      sourceOpId: "",
      reasonClass: "operation_condition",
      reason: CERTIFICATE_CONTACT_REASON,
      severity: "critical",
      actor: "certificate-renewal-watch",
    });
  }
}

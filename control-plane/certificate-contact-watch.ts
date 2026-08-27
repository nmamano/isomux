// One daily pass over every live office. Each office owns its due time and
// claim, so one failure cannot hide the rest or hold the database on a
// five-second retry loop.

import { applyCertificateContactAttention } from "./certificate-credentials.ts";
import type { Store } from "./store.ts";

export const CERTIFICATE_CONTACT_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const CERTIFICATE_CONTACT_CLAIM_MS = 5 * 60_000;

export interface CertificateContactWatchDeps {
  holder: string;
  report?: (line: string) => void;
  apply?: typeof applyCertificateContactAttention;
}

/**
 * Check every office that is live when this daily pass starts.
 *
 * A newly live office joins the next pass, so a stale contact can raise
 * attention up to one day after the three-day condition becomes true. The
 * each office advances after its check, including a failure; the short claim
 * is only for recovery when the process dies mid-check.
 */
export async function watchCertificateContact(
  store: Store,
  deps: CertificateContactWatchDeps,
): Promise<number> {
  let checked = 0;
  const apply = deps.apply ?? applyCertificateContactAttention;
  for (const instance of await store.listInstances()) {
    if (instance.service_state !== "live") continue;
    let claimed: Awaited<ReturnType<Store["claimCertificateContactCheck"]>> =
      null;
    try {
      const now = store.now();
      claimed = await store.claimCertificateContactCheck(
        instance.id,
        deps.holder,
        now + CERTIFICATE_CONTACT_CLAIM_MS,
        now,
      );
      if (!claimed) continue;
      checked++;
      await apply(store, instance.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.report?.(
        `certificate-contact check failed for ${instance.id}: ${message}`,
      );
    } finally {
      if (claimed) {
        try {
          const completed = await store.completeCertificateContactCheck(
            instance.id,
            claimed.certificate_contact_version!,
            deps.holder,
            store.now() + CERTIFICATE_CONTACT_INTERVAL_MS,
          );
          if (!completed) {
            deps.report?.(
              `certificate-contact check for ${instance.id} was written by another holder; its result was discarded`,
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          deps.report?.(
            `certificate-contact schedule could not advance for ${instance.id}: ${message}`,
          );
        }
      }
    }
  }
  return checked;
}

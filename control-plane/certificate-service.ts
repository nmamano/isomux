import type { Store } from "./store.ts";
import { authenticateCertificateCredential } from "./certificate-credentials.ts";
import { clearAttention, raiseAttention } from "./attention.ts";

export const CERTIFICATE_RENEW_PATH = "/internal/certificates/renew";
export const CERTIFICATE_STATUS_PATH = "/internal/certificates/status";
export const MAX_CSR_BYTES = 32 * 1024;
const FAILURE_REASON = "the hosted office certificate could not be renewed";
const LOCAL_FAILURE_REASON =
  "the hosted office could not install its renewed certificate";

export interface CertificateIssuer {
  issue(input: {
    instanceId: string;
    names: readonly [string, string];
    csrPem: string;
  }): Promise<{ certificatePem: string }>;
}

export class CertificateService {
  private readonly active = new Set<string>();
  constructor(
    private readonly store: Store,
    private readonly issuer: CertificateIssuer,
  ) {}

  async renew(
    token: string,
    csrPem: string,
  ): Promise<
    | { status: "ok"; certificatePem: string }
    | { status: "unauthorized" | "busy" | "bad_request" | "failed" }
  > {
    if (
      !csrPem.includes("BEGIN CERTIFICATE REQUEST") ||
      Buffer.byteLength(csrPem) > MAX_CSR_BYTES
    )
      return { status: "bad_request" };
    const identity = await authenticateCertificateCredential(this.store, token);
    if (!identity) return { status: "unauthorized" };
    // lego owns one central ACME account directory. One process may mutate it
    // at a time, even when two different offices ask together.
    if (this.active.size > 0) return { status: "busy" };
    this.active.add(identity.row.instance_id);
    try {
      const result = await this.issuer.issue({
        instanceId: identity.row.instance_id,
        names: identity.names,
        csrPem,
      });
      const open = await this.store.openReasons(identity.row.instance_id);
      for (const reason of open) {
        if (reason.source_op_id === "" && reason.reason === FAILURE_REASON) {
          await clearAttention(
            this.store,
            identity.row.instance_id,
            reason.id,
            "certificate-renewal",
          );
        }
      }
      return { status: "ok", certificatePem: result.certificatePem };
    } catch {
      await raiseAttention(this.store, {
        instanceId: identity.row.instance_id,
        reasonClass: "operation_condition",
        reason: FAILURE_REASON,
        severity: "critical",
        actor: "certificate-renewal",
      });
      return { status: "failed" };
    } finally {
      this.active.delete(identity.row.instance_id);
    }
  }

  async reportStatus(
    token: string,
    status: "ok" | "failed",
  ): Promise<"ok" | "unauthorized"> {
    const identity = await authenticateCertificateCredential(this.store, token);
    if (!identity) return "unauthorized";
    const open = (
      await this.store.openReasons(identity.row.instance_id)
    ).filter(
      (row) => row.source_op_id === "" && row.reason === LOCAL_FAILURE_REASON,
    );
    if (status === "failed" && open.length === 0) {
      await raiseAttention(this.store, {
        instanceId: identity.row.instance_id,
        sourceOpId: "",
        reasonClass: "operation_condition",
        reason: LOCAL_FAILURE_REASON,
        severity: "critical",
        actor: "certificate-renewal",
      });
    } else if (status === "ok") {
      for (const row of open) {
        await clearAttention(
          this.store,
          identity.row.instance_id,
          row.id,
          "certificate-renewal",
        );
      }
    }
    return "ok";
  }
}

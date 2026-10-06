import type { Store } from "./store.ts";
import { authenticateCertificateCredential } from "./certificate-credentials.ts";
import { clearAttention, raiseAttention } from "./attention.ts";
import { redactCredentialShapes } from "./report.ts";

export const CERTIFICATE_RENEW_PATH = "/internal/certificates/renew";
export const CERTIFICATE_STATUS_PATH = "/internal/certificates/status";
export const MAX_CSR_BYTES = 32 * 1024;
/** Set by the certificate forwarder (deploy/forwarder/forwarder.ts). */
export const CERTIFICATE_FORWARDED_HEADER = "isomux-forwarded";
const FAILURE_REASON = "the hosted office certificate could not be renewed";
const LOCAL_FAILURE_REASON =
  "the hosted office could not install its renewed certificate";
const MAX_CAUSE_CHARS = 2000;

/** Why an issue failed, as one log-safe line. The issuer already sanitizes
 * what it quotes; this pass covers an issuer that does not. */
function failureCause(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = redactCredentialShapes(text)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .trim();
  return line.length > MAX_CAUSE_CHARS
    ? `${line.slice(0, MAX_CAUSE_CHARS)}...`
    : line;
}

/** Where a call came from, for the operator's log. The forwarder that serves
 * the old provisioner hostname marks its calls; the mark is not a credential. */
export type CertificateCallRoute = "direct" | "forwarder";

/**
 * The renewal URL an office is enrolled with: HTTPS, the renew route, nothing
 * else. Provisioning writes it into a new office's enrollment, and a renew
 * answer hands it to an existing office's helper, which moves to it.
 */
export function parseCertificateEndpoint(
  value: string | undefined,
): { url: URL } | { reason: string } {
  if (!value) {
    return { reason: "the hosted certificate endpoint is not configured" };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { reason: "the hosted certificate endpoint is invalid" };
  }
  if (
    url.protocol !== "https:" ||
    url.pathname !== CERTIFICATE_RENEW_PATH ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return {
      reason: "the hosted certificate endpoint is not the HTTPS renewal route",
    };
  }
  return { url };
}

export interface CertificateIssuer {
  issue(input: {
    instanceId: string;
    names: readonly [string, string];
    csrPem: string;
  }): Promise<{ certificatePem: string }>;
}

export class CertificateService {
  private readonly active = new Set<string>();
  /** This provisioner's renewal URL, sent with every certificate. Unset when
   * the configured value is not a valid endpoint. */
  readonly endpoint: string | undefined;
  private readonly report: (line: string) => void;
  constructor(
    private readonly store: Store,
    private readonly issuer: CertificateIssuer,
    opts: { endpoint?: string; report?: (line: string) => void } = {},
  ) {
    this.report = opts.report ?? (() => {});
    const parsed = parseCertificateEndpoint(opts.endpoint);
    this.endpoint = "url" in parsed ? parsed.url.href : undefined;
    if (opts.endpoint && "reason" in parsed)
      this.report(`certificate renewal: ${parsed.reason}; answers carry none`);
  }

  /** One line per call: the outcome, the office once it is known, and the
   * route. The operator reads these to see when no office needs the old
   * hostname (control-plane/README.md, "The certificate forwarder"). */
  private line(
    call: "renewal" | "status",
    outcome: string,
    instanceId: string | null,
    via: CertificateCallRoute,
    cause?: string,
  ) {
    const office = instanceId ? ` office=${instanceId}` : "";
    const why = cause === undefined ? "" : ` cause=${JSON.stringify(cause)}`;
    this.report(`certificate ${call}: ${outcome}${office} via=${via}${why}`);
  }

  async renew(
    token: string,
    csrPem: string,
    via: CertificateCallRoute = "direct",
  ): Promise<
    | { status: "ok"; certificatePem: string }
    | { status: "unauthorized" | "busy" | "bad_request" | "failed" }
  > {
    if (
      !csrPem.includes("BEGIN CERTIFICATE REQUEST") ||
      Buffer.byteLength(csrPem) > MAX_CSR_BYTES
    ) {
      this.line("renewal", "bad_request", null, via);
      return { status: "bad_request" };
    }
    const identity = await authenticateCertificateCredential(this.store, token);
    if (!identity) {
      this.line("renewal", "unauthorized", null, via);
      return { status: "unauthorized" };
    }
    const result = await this.renewFor(identity, csrPem);
    if (result.status === "failed") {
      // The cause stays in the operator's log; the office learns only that
      // the renewal failed.
      this.line("renewal", "failed", identity.row.instance_id, via, result.cause);
      return { status: "failed" };
    }
    this.line("renewal", result.status, identity.row.instance_id, via);
    return result;
  }

  private async renewFor(
    identity: NonNullable<
      Awaited<ReturnType<typeof authenticateCertificateCredential>>
    >,
    csrPem: string,
  ): Promise<
    | { status: "ok"; certificatePem: string }
    | { status: "busy" }
    | { status: "failed"; cause: string }
  > {
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
    } catch (error) {
      await raiseAttention(this.store, {
        instanceId: identity.row.instance_id,
        reasonClass: "operation_condition",
        reason: FAILURE_REASON,
        severity: "critical",
        actor: "certificate-renewal",
      });
      return { status: "failed", cause: failureCause(error) };
    } finally {
      this.active.delete(identity.row.instance_id);
    }
  }

  async reportStatus(
    token: string,
    status: "ok" | "failed",
    via: CertificateCallRoute = "direct",
  ): Promise<"ok" | "unauthorized"> {
    const identity = await authenticateCertificateCredential(
      this.store,
      token,
      { contact: true },
    );
    if (!identity) {
      this.line("status", "unauthorized", null, via);
      return "unauthorized";
    }
    this.line("status", status, identity.row.instance_id, via);
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

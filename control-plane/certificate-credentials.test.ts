import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  authenticateCertificateCredential,
  applyCertificateContactAttention,
  CERTIFICATE_CONTACT_REASON,
  CERTIFICATE_CONTACT_STALE_MS,
  issueCertificateCredential,
  revokeCertificateCredentials,
} from "./certificate-credentials.ts";
import {
  openTestStore,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
} from "./testing/pg.ts";
import type { Store } from "./store.ts";
import {
  CERTIFICATE_FORWARDED_HEADER,
  CERTIFICATE_RENEW_PATH,
  CERTIFICATE_STATUS_PATH,
  CertificateService,
  parseCertificateEndpoint,
  type CertificateIssuer,
} from "./certificate-service.ts";
import { InviteHold } from "./invite-hold.ts";
import { startMintSeam } from "./mint-seam.ts";

let store: Store;

beforeAll(async () => {
  store = await openTestStore();
}, PG_TEST_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await releaseTestStores();
}, PG_TEST_HOOK_TIMEOUT_MS);

async function office(id = "inst-cert", label = "cert") {
  await store.createInstance({
    id,
    run_id: null,
    name: `${label}.test.isomux.app`,
    plan: "V153",
    region: "EU",
    service_state: "live",
    goal: "handed_off",
    access_window_expires_at: null,
  });
  const now = store.now();
  await store.sqlRun(
    "insert into name_reservations (name, id, account_id, instance_id, plan, coupon_id, version, created_at, updated_at) " +
      "values ($6, $1, $2, $3, 'monthly', null, 1, $4, $5)",
    [`res-${id}`, `acct-${id}`, id, now, now, label],
  );
}

describe("one-office certificate credentials", () => {
  test("stores only a hash and binds the two names server-side", async () => {
    await office();
    const issued = await issueCertificateCredential(store, "inst-cert");
    const raw = await store.sqlGet<{ token_hash: string }>(
      "select token_hash from certificate_credentials where id = $1",
      [issued.id],
    );
    expect(raw?.token_hash).not.toContain(issued.token);
    expect(
      await authenticateCertificateCredential(store, issued.token),
    ).toMatchObject({
      names: ["cert.test.isomux.app", "*.cert.test.isomux.app"],
    });
    let issuedNames: readonly string[] = [];
    const service = new CertificateService(store, {
      issue: async (input) => {
        issuedNames = input.names;
        return { certificatePem: "public chain" };
      },
    });
    expect(
      await service.renew(
        issued.token,
        "-----BEGIN CERTIFICATE REQUEST-----\nfake\n-----END CERTIFICATE REQUEST-----\n",
      ),
    ).toEqual({ status: "ok", certificatePem: "public chain" });
    expect(issuedNames).toEqual([
      "cert.test.isomux.app",
      "*.cert.test.isomux.app",
    ]);
  });

  test("uniformly refuses wrong and revoked credentials", async () => {
    const issued = await issueCertificateCredential(store, "inst-cert");
    expect(
      await authenticateCertificateCredential(store, "x".repeat(43)),
    ).toBeNull();
    expect(
      await revokeCertificateCredentials(store, "inst-cert"),
    ).toBeGreaterThan(0);
    expect(
      await authenticateCertificateCredential(store, issued.token),
    ).toBeNull();
  });

  test("raises attention after three missed checks and clears it on contact", async () => {
    const issued = await issueCertificateCredential(store, "inst-cert");
    await store.sqlRun(
      "update certificate_credentials set created_at = $1 where id = $2",
      [store.now() - CERTIFICATE_CONTACT_STALE_MS - 1, issued.id],
    );
    await applyCertificateContactAttention(store, "inst-cert");
    expect(
      (await store.openReasons("inst-cert")).map((row) => row.reason),
    ).toContain(CERTIFICATE_CONTACT_REASON);
    const service = new CertificateService(store, {
      issue: async () => ({ certificatePem: "public chain" }),
    });
    // A renew call that authenticates is not contact: its answer may never
    // reach the box, which then sends no status report.
    expect(
      await service.renew(
        issued.token,
        "-----BEGIN CERTIFICATE REQUEST-----\nfake\n-----END CERTIFICATE REQUEST-----\n",
      ),
    ).toMatchObject({ status: "ok" });
    await applyCertificateContactAttention(store, "inst-cert");
    expect(
      (await store.openReasons("inst-cert")).map((row) => row.reason),
    ).toContain(CERTIFICATE_CONTACT_REASON);
    expect(await service.reportStatus(issued.token, "ok")).toBe("ok");
    await applyCertificateContactAttention(store, "inst-cert");
    expect(
      (await store.openReasons("inst-cert")).map((row) => row.reason),
    ).not.toContain(CERTIFICATE_CONTACT_REASON);
  });

  test("a failed status report is contact too", async () => {
    const issued = await issueCertificateCredential(store, "inst-cert");
    const service = new CertificateService(store, {
      issue: async () => ({ certificatePem: "unused" }),
    });
    const lastContact = async () =>
      (
        await store.sqlGet<{ last_used_at: number | null }>(
          "select last_used_at from certificate_credentials where id = $1",
          [issued.id],
        )
      )?.last_used_at ?? null;
    expect(
      await authenticateCertificateCredential(store, issued.token),
    ).not.toBeNull();
    expect(await lastContact()).toBeNull();
    expect(await service.reportStatus(issued.token, "failed")).toBe("ok");
    expect(await lastContact()).not.toBeNull();
    expect(await service.reportStatus(issued.token, "ok")).toBe("ok");
  });

  test("a box reports a local install failure and its later recovery", async () => {
    const issued = await issueCertificateCredential(store, "inst-cert");
    const service = new CertificateService(store, {
      issue: async () => ({ certificatePem: "unused" }),
    });
    expect(await service.reportStatus(issued.token, "failed")).toBe("ok");
    expect(
      (await store.openReasons("inst-cert")).map((row) => row.reason),
    ).toContain("the hosted office could not install its renewed certificate");
    expect(await service.reportStatus(issued.token, "ok")).toBe("ok");
    expect(
      (await store.openReasons("inst-cert")).map((row) => row.reason),
    ).not.toContain(
      "the hosted office could not install its renewed certificate",
    );
    expect(await service.reportStatus("x".repeat(43), "failed")).toBe(
      "unauthorized",
    );
  });

  test("never reassigns a credential after deprovision", async () => {
    const issued = await issueCertificateCredential(store, "inst-cert");
    const current = await store.getInstance("inst-cert");
    await store.casInstance("inst-cert", current!.version, {
      service_state: "deprovisioned",
    });
    expect(
      await authenticateCertificateCredential(store, issued.token),
    ).toBeNull();
    const error = await issueCertificateCredential(store, "inst-cert").catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("inactive office");
  });
});

// DNS challenge leftovers of a killed lego run are reaped inside the one
// renewal slot (task 0f37f6e6), so a reap can never race a live challenge in
// this process, and a reap problem never fails a renewal.
describe("reaping DNS leftovers in the renewal slot", () => {
  const CSR =
    "-----BEGIN CERTIFICATE REQUEST-----\nfake\n-----END CERTIFICATE REQUEST-----\n";
  const NOTHING = { removed: 0, failed: 0, unreadable: 0 };
  // A renewal that does not answer at once is waiting on the held reap: say
  // so instead of letting the test time out.
  const answerSoon = <T>(p: Promise<T>) =>
    Promise.race([
      p,
      new Promise<"no answer">((resolve) =>
        setTimeout(() => resolve("no answer"), 1000),
      ),
    ]);
  async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 500 && !cond(); i++)
      await new Promise((r) => setTimeout(r, 2));
    if (!cond()) throw new Error("condition never held");
  }

  test("reaps before issuing, and holds the slot while it reaps", async () => {
    await office("inst-reap-a", "reap-a");
    const { token } = await issueCertificateCredential(store, "inst-reap-a");
    const order: string[] = [];
    let releaseReap!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseReap = resolve;
    });
    const service = new CertificateService(
      store,
      {
        issue: async () => {
          order.push("issue");
          return { certificatePem: "chain" };
        },
      },
      {
        reapDnsOrphans: async () => {
          order.push("reap");
          await held;
          return NOTHING;
        },
      },
    );
    let settled = false;
    const first = service.renew(token, CSR).finally(() => {
      settled = true;
    });
    await until(() => order.length > 0 || settled);
    expect(order).toEqual(["reap"]);
    expect(await answerSoon(service.renew(token, CSR))).toEqual({
      status: "busy",
    });
    expect(order).toEqual(["reap"]);
    releaseReap();
    expect(await first).toEqual({ status: "ok", certificatePem: "chain" });
    expect(order).toEqual(["reap", "issue"]);
  });

  test("a failing reap does not fail the renewal", async () => {
    await office("inst-reap-b", "reap-b");
    const { token } = await issueCertificateCredential(store, "inst-reap-b");
    let issued = 0;
    let reaped = false;
    const service = new CertificateService(
      store,
      {
        issue: async () => {
          issued++;
          return { certificatePem: "chain" };
        },
      },
      {
        reapDnsOrphans: async () => {
          reaped = true;
          throw new Error("cloudflare down");
        },
      },
    );
    expect(await service.renew(token, CSR)).toEqual({
      status: "ok",
      certificatePem: "chain",
    });
    expect(reaped).toBe(true);
    expect(issued).toBe(1);
  });

  test("a reap on its own takes the slot, and skips while a renewal holds it", async () => {
    await office("inst-reap-c", "reap-c");
    const { token } = await issueCertificateCredential(store, "inst-reap-c");
    let reaps = 0;
    let issuing = false;
    let releaseIssue!: () => void;
    const issueHeld = new Promise<void>((resolve) => {
      releaseIssue = resolve;
    });
    let releaseReap: (() => void) | null = null;
    const service = new CertificateService(
      store,
      {
        issue: async () => {
          issuing = true;
          await issueHeld;
          return { certificatePem: "chain" };
        },
      },
      {
        reapDnsOrphans: async () => {
          reaps++;
          if (releaseReap === null) return NOTHING;
          await new Promise<void>((resolve) => {
            releaseReap = resolve;
          });
          return NOTHING;
        },
      },
    );
    const renewal = service.renew(token, CSR);
    await until(() => issuing);
    expect(reaps).toBe(1);
    // A renewal holds the slot: the reap returns without reaping.
    await service.reapDnsOrphans();
    expect(reaps).toBe(1);
    releaseIssue();
    expect(await renewal).toMatchObject({ status: "ok" });

    // A reap on its own holds the slot: a renewal meanwhile is busy.
    releaseReap = () => {};
    const reap = service.reapDnsOrphans();
    await until(() => reaps === 2);
    expect(await answerSoon(service.renew(token, CSR))).toEqual({
      status: "busy",
    });
    releaseReap();
    await reap;
  });
});

describe("the office's renewal calls on the seam", () => {
  const ENDPOINT =
    "https://provisioner.example.com/internal/certificates/renew";
  const CSR =
    "-----BEGIN CERTIFICATE REQUEST-----\nfake\n-----END CERTIFICATE REQUEST-----\n";

  async function seamFor(
    endpoint: string | undefined,
    issuer: CertificateIssuer = {
      issue: async () => ({ certificatePem: "public chain" }),
    },
  ) {
    const lines: string[] = [];
    const service = new CertificateService(store, issuer, {
      endpoint,
      report: (line) => lines.push(line),
    });
    const seam = startMintSeam({
      store,
      hold: new InviteHold(),
      token: "s".repeat(40),
      port: 0,
      certificates: service,
    });
    const call = (
      route: string,
      body: unknown,
      headers: Record<string, string>,
    ) =>
      fetch(`http://127.0.0.1:${seam.port}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    return { lines, seam, call };
  }

  test("answers a renewal with this provisioner's endpoint and logs the office and the route", async () => {
    await office("inst-route", "route");
    const issued = await issueCertificateCredential(store, "inst-route");
    const { lines, seam, call } = await seamFor(ENDPOINT);
    try {
      const bearer = { authorization: `Bearer ${issued.token}` };
      const direct = await call(CERTIFICATE_RENEW_PATH, { csr: CSR }, bearer);
      expect(direct.status).toBe(200);
      expect(await direct.json()).toEqual({
        certificate: "public chain",
        endpoint: ENDPOINT,
      });
      const forwarded = await call(
        CERTIFICATE_STATUS_PATH,
        { status: "ok" },
        { ...bearer, [CERTIFICATE_FORWARDED_HEADER]: "1" },
      );
      expect(forwarded.status).toBe(200);
      const refused = await call(
        CERTIFICATE_RENEW_PATH,
        { csr: CSR },
        {
          authorization: `Bearer ${"x".repeat(43)}`,
          [CERTIFICATE_FORWARDED_HEADER]: "1",
        },
      );
      expect(refused.status).toBe(401);
      expect(lines).toEqual([
        "certificate renewal: ok office=inst-route via=direct",
        "certificate status: ok office=inst-route via=forwarder",
        "certificate renewal: unauthorized via=forwarder",
      ]);
      expect(lines.join("\n")).not.toContain(issued.token);
    } finally {
      await seam.stop();
    }
  });

  test("logs why a renewal failed, without a secret, and tells the office only that it failed", async () => {
    await office("inst-cause", "cause");
    const issued = await issueCertificateCredential(store, "inst-cause");
    // Synthetic and secret-SHAPED; the diagnosis is the challenge name.
    const SECRET = "NotARealSecret0123456789abcdefGHIJ";
    const QUOTED = 'not "a real password';
    const DIAGNOSIS = "_acme-challenge.cause.test.isomux.app";
    const { lines, seam, call } = await seamFor(ENDPOINT, {
      issue: async () => {
        throw new Error(
          `lego failed: ${DIAGNOSIS}\nkey=${SECRET} password=${JSON.stringify(QUOTED)}`,
        );
      },
    });
    try {
      const answer = await call(
        CERTIFICATE_RENEW_PATH,
        { csr: CSR },
        {
          authorization: `Bearer ${issued.token}`,
          [CERTIFICATE_FORWARDED_HEADER]: "1",
        },
      );
      expect(answer.status).toBe(503);
      expect(await answer.text()).not.toContain(DIAGNOSIS);
      expect(lines.length).toBe(1);
      const match = lines[0].match(
        /^certificate renewal: failed office=inst-cause via=forwarder cause=(".*")$/,
      );
      expect(match).not.toBeNull();
      const cause = JSON.parse(match![1]) as string;
      expect(cause).toContain(DIAGNOSIS);
      // eslint-disable-next-line no-control-regex
      expect(cause).not.toMatch(/[\x00-\x1f]/);
      expect(lines[0]).not.toContain(SECRET);
      // The tail after the escaped quote is what a too-short match leaves.
      expect(lines[0]).not.toContain("real password");
      expect(lines[0]).not.toContain(issued.token);
      expect((await store.openReasons("inst-cause")).length).toBeGreaterThan(0);
    } finally {
      await seam.stop();
    }
  });

  test("sends no endpoint it would not enroll an office with", async () => {
    await office("inst-noend", "noend");
    const issued = await issueCertificateCredential(store, "inst-noend");
    for (const endpoint of [
      undefined,
      "http://provisioner.example.com/internal/certificates/renew",
      "https://user@provisioner.example.com/internal/certificates/renew",
    ]) {
      const { lines, seam, call } = await seamFor(endpoint);
      try {
        const answer = await call(
          CERTIFICATE_RENEW_PATH,
          { csr: CSR },
          { authorization: `Bearer ${issued.token}` },
        );
        expect(await answer.json()).toEqual({ certificate: "public chain" });
        // A configured but unusable value is said out loud at start.
        expect(lines.length).toBe(endpoint ? 2 : 1);
      } finally {
        await seam.stop();
      }
    }
  });

  test("takes only an HTTPS renew URL as an endpoint", () => {
    expect(parseCertificateEndpoint(ENDPOINT)).toEqual({
      url: new URL(ENDPOINT),
    });
    for (const bad of [
      undefined,
      "",
      "not a url",
      "http://provisioner.example.com/internal/certificates/renew",
      "https://provisioner.example.com/internal/certificates/status",
      "https://provisioner.example.com/internal/certificates/renew?x=1",
      "https://provisioner.example.com/internal/certificates/renew#x",
      "https://user:pass@provisioner.example.com/internal/certificates/renew",
      "https://user@provisioner.example.com/internal/certificates/renew",
    ]) {
      expect(parseCertificateEndpoint(bad)).toHaveProperty("reason");
    }
  });
});

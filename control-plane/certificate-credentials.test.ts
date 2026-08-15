import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  authenticateCertificateCredential,
  applyCertificateContactAttention,
  CERTIFICATE_CONTACT_REASON,
  CERTIFICATE_CONTACT_STALE_MS,
  issueCertificateCredential,
  revokeCertificateCredentials,
} from "./certificate-credentials.ts";
import { openTestStore, releaseTestStores } from "./testing/pg.ts";
import type { Store } from "./store.ts";
import { CertificateService } from "./certificate-service.ts";

let store: Store;

beforeAll(async () => {
  store = await openTestStore();
});

afterAll(async () => {
  await releaseTestStores();
});

async function office(id = "inst-cert") {
  await store.createInstance({
    id,
    run_id: null,
    name: "cert.test.isomux.app",
    plan: "V153",
    region: "EU",
    service_state: "live",
    goal: "handed_off",
    access_window_expires_at: null,
  });
  const now = store.now();
  await store.sqlRun(
    "insert into name_reservations (name, id, account_id, instance_id, plan, coupon_id, version, created_at, updated_at) " +
      "values ('cert', $1, $2, $3, 'monthly', null, 1, $4, $5)",
    [`res-${id}`, `acct-${id}`, id, now, now],
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
    expect(
      await authenticateCertificateCredential(store, issued.token),
    ).not.toBeNull();
    await applyCertificateContactAttention(store, "inst-cert");
    expect(
      (await store.openReasons("inst-cert")).map((row) => row.reason),
    ).not.toContain(CERTIFICATE_CONTACT_REASON);
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

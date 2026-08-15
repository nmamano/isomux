import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { obtainCertificateWithLego, type CommandRunner } from "./lego-acme.ts";

let dir = "";
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

function makeCsr(root: string, commonName: string, sans: string): string {
  const key = join(root, `${commonName}.key`);
  const csr = join(root, `${commonName}.csr`);
  const made = Bun.spawnSync([
    "openssl",
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    `/CN=${commonName}`,
    "-addext",
    `subjectAltName=${sans}`,
    "-keyout",
    key,
    "-out",
    csr,
  ]);
  if (made.exitCode !== 0) throw new Error(made.stderr.toString());
  return readFileSync(csr, "utf8");
}

function realCommand(argv: string[], env: Record<string, string>) {
  const child = Bun.spawnSync(argv, { env: { ...process.env, ...env } });
  return {
    code: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  };
}

describe("the narrow lego adapter", () => {
  test("binds names from the CSR and leaves ARI and validity fallback enabled", async () => {
    dir = mkdtempSync(join(tmpdir(), "isomux-lego-"));
    let legoArgv: string[] = [];
    let legoEnv: Record<string, string> = {};
    const run: CommandRunner = async (argv, env) => {
      if (argv[0] === "openssl") return realCommand(argv, env);
      legoArgv = argv;
      legoEnv = env;
      return { code: 1, stdout: "", stderr: "fake stop" };
    };
    const failed = await obtainCertificateWithLego(
      {
        root: dir,
        target: {
          kind: "test",
          caDirectory: "http://127.0.0.1:14000/directory",
          cloudflareBaseUrl: "http://127.0.0.1:18080",
          zoneId: "fake-zone",
          productionZoneId: "production-zone",
        },
        email: "test@example.invalid",
        dnsHookPath: "/fake/dns-hook",
        run,
        cloudflareToken: "fake",
      },
      {
        instanceId: "office-1",
        names: ["office.example", "*.office.example"],
        csrPem: makeCsr(
          dir,
          "office.example",
          "DNS:office.example,DNS:*.office.example",
        ),
      },
    ).catch((reason: unknown) => reason);
    expect((failed as Error).message).toContain("fake stop");
    expect(legoArgv.slice(0, 2)).toEqual(["/usr/local/bin/lego", "run"]);
    expect(legoArgv).not.toContain("--ari-disable");
    expect(legoArgv).not.toContain("--renew-days");
    expect(legoArgv).toContain("--csr");
    expect(legoEnv.ISOMUX_DNS_ALLOWED_FQDN).toBe(
      "_acme-challenge.office.example",
    );
  });

  test("refuses a CSR that asks for any other name before lego runs", async () => {
    dir = mkdtempSync(join(tmpdir(), "isomux-lego-"));
    let calls = 0;
    const run: CommandRunner = async (argv, env) => {
      calls++;
      return realCommand(argv, env);
    };
    const failed = await obtainCertificateWithLego(
      {
        root: dir,
        target: {
          kind: "test",
          caDirectory: "http://127.0.0.1",
          cloudflareBaseUrl: "http://127.0.0.1",
          zoneId: "fake",
          productionZoneId: "prod",
        },
        email: "test@example.invalid",
        dnsHookPath: "/fake/hook",
        run,
        cloudflareToken: "fake",
      },
      {
        instanceId: "office-1",
        names: ["office.example", "*.office.example"],
        csrPem: makeCsr(dir, "other.example", "DNS:other.example"),
      },
    ).catch((reason: unknown) => reason);
    expect((failed as Error).message).toContain("do not match");
    expect(calls).toBe(1);
  });

  test("a forged print-dump header cannot hide a foreign real SAN", async () => {
    dir = mkdtempSync(join(tmpdir(), "isomux-lego-"));
    const config = join(dir, "evil.cnf");
    const key = join(dir, "evil.key");
    const csr = join(dir, "evil.csr");
    writeFileSync(
      config,
      `[req]\nprompt=no\ndistinguished_name=dn\nreq_extensions=ext\n[dn]\nCN=office.example\n[ext]\n2.16.840.1.113730.1.13=ASN1:IA5STRING:X509v3 Subject Alternative Name:\\nDNS:office.example, DNS:*.office.example\nsubjectAltName=DNS:office.example,DNS:*.office.example,DNS:victim.example\n`,
    );
    const made = Bun.spawnSync([
      "openssl",
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      csr,
      "-config",
      config,
    ]);
    expect(made.exitCode).toBe(0);
    let legoCalls = 0;
    const run: CommandRunner = async (argv, env) => {
      if (argv[0] !== "openssl") {
        legoCalls++;
        return { code: 1, stdout: "", stderr: "must not run" };
      }
      return realCommand(argv, env);
    };
    const failed = await obtainCertificateWithLego(
      {
        root: join(dir, "state"),
        target: {
          kind: "test",
          caDirectory: "http://127.0.0.1",
          cloudflareBaseUrl: "http://127.0.0.1",
          zoneId: "fake",
          productionZoneId: "prod",
        },
        email: "test@example.invalid",
        dnsHookPath: "/fake/hook",
        run,
        cloudflareToken: "fake",
      },
      {
        instanceId: "office-1",
        names: ["office.example", "*.office.example"],
        csrPem: await Bun.file(csr).text(),
      },
    ).catch((reason: unknown) => reason);
    expect((failed as Error).message).toContain("do not match");
    expect(legoCalls).toBe(0);
  });
});

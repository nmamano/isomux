import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

function makeEcCsr(root: string, commonName: string, sans: string): string {
  const key = join(root, `${commonName}.key`);
  const csr = join(root, `${commonName}.csr`);
  const made = Bun.spawnSync([
    "openssl",
    "req",
    "-new",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
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

function signCsr(root: string, commonName: string, output: string): string {
  const made = Bun.spawnSync([
    "openssl",
    "x509",
    "-req",
    "-in",
    join(root, `${commonName}.csr`),
    "-signkey",
    join(root, `${commonName}.key`),
    "-days",
    "90",
    "-copy_extensions",
    "copy",
    "-out",
    output,
  ]);
  if (made.exitCode !== 0) throw new Error(made.stderr.toString());
  return readFileSync(output, "utf8");
}

function replaceLastBytes(
  haystack: Buffer,
  needle: Buffer,
  replacement: Buffer,
) {
  const offset = haystack.lastIndexOf(needle);
  if (offset < 0) throw new Error("DER test seam not found");
  replacement.copy(haystack, offset);
}

function pemFromDer(der: Buffer): string {
  const body =
    der
      .toString("base64")
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return `-----BEGIN CERTIFICATE REQUEST-----\n${body}\n-----END CERTIFICATE REQUEST-----\n`;
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
  test("a matching P-256 key in CSR and certificate encodings does not force", async () => {
    dir = mkdtempSync(join(tmpdir(), "isomux-lego-"));
    const fixture = join(dir, "fixture");
    mkdirSync(fixture);
    const key = join(fixture, "office.example.key");
    const compressedKey = join(fixture, "compressed.key");
    const compressedCsr = join(fixture, "compressed.csr");
    const made = [
      [
        "openssl",
        "genpkey",
        "-algorithm",
        "EC",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-out",
        key,
      ],
      [
        "openssl",
        "ec",
        "-in",
        key,
        "-conv_form",
        "compressed",
        "-out",
        compressedKey,
      ],
      [
        "openssl",
        "req",
        "-new",
        "-key",
        compressedKey,
        "-subj",
        "/CN=office.example",
        "-addext",
        "subjectAltName=DNS:office.example,DNS:*.office.example",
        "-out",
        compressedCsr,
      ],
      [
        "openssl",
        "req",
        "-new",
        "-key",
        key,
        "-subj",
        "/CN=office.example",
        "-addext",
        "subjectAltName=DNS:office.example,DNS:*.office.example",
        "-out",
        join(fixture, "office.example.csr"),
      ],
    ].map((argv) => Bun.spawnSync(argv));
    for (const result of made) {
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    }
    const csrPem = readFileSync(compressedCsr, "utf8");
    const cert = signCsr(fixture, "office.example", join(fixture, "cert.pem"));
    const state = join(dir, "state");
    const calls: string[][] = [];
    const result = await obtainCertificateWithLego(
      {
        root: state,
        target: {
          kind: "test",
          caDirectory: "http://127.0.0.1:14000/directory",
          cloudflareBaseUrl: "http://127.0.0.1:18080",
          zoneId: "fake-zone",
          productionZoneId: "production-zone",
        },
        email: "test@example.invalid",
        dnsHookPath: "/fake/dns-hook",
        run: async (argv, env) => {
          if (argv[0] === "openssl") return realCommand(argv, env);
          calls.push(argv);
          mkdirSync(join(state, "certificates"), { recursive: true });
          writeFileSync(
            join(state, "certificates", "office.example.crt"),
            cert,
          );
          return { code: 0, stdout: "", stderr: "" };
        },
        cloudflareToken: "fake",
      },
      {
        instanceId: "office-1",
        names: ["office.example", "*.office.example"],
        csrPem,
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("--renew-force");
    expect(result).toEqual({ certificatePem: cert });
  });

  test("a seeded stale chain forces exactly one order and returns its replacement", async () => {
    dir = mkdtempSync(join(tmpdir(), "isomux-lego-"));
    const oldDir = join(dir, "old");
    const newDir = join(dir, "new");
    mkdirSync(oldDir);
    mkdirSync(newDir);
    makeEcCsr(
      oldDir,
      "office.example",
      "DNS:office.example,DNS:*.office.example",
    );
    const oldCert = signCsr(oldDir, "office.example", join(oldDir, "cert.pem"));
    const csrPem = makeEcCsr(
      newDir,
      "office.example",
      "DNS:office.example,DNS:*.office.example",
    );
    const newCert = signCsr(newDir, "office.example", join(newDir, "cert.pem"));
    const state = join(dir, "state");
    const calls: string[][] = [];
    const result = await obtainCertificateWithLego(
      {
        root: state,
        target: {
          kind: "test",
          caDirectory: "http://127.0.0.1:14000/directory",
          cloudflareBaseUrl: "http://127.0.0.1:18080",
          zoneId: "fake-zone",
          productionZoneId: "production-zone",
        },
        email: "test@example.invalid",
        dnsHookPath: "/fake/dns-hook",
        run: async (argv, env) => {
          if (argv[0] === "openssl") return realCommand(argv, env);
          calls.push(argv);
          mkdirSync(join(state, "certificates"), { recursive: true });
          writeFileSync(
            join(state, "certificates", "office.example.crt"),
            argv.includes("--renew-force") ? newCert : oldCert,
          );
          return { code: 0, stdout: "", stderr: "" };
        },
        cloudflareToken: "fake",
      },
      {
        instanceId: "office-1",
        names: ["office.example", "*.office.example"],
        csrPem,
      },
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toContain("--renew-force");
    expect(calls[1]).toContain("--renew-force");
    expect(result).toEqual({ certificatePem: newCert });
  });

  test("a forced order that leaves the stale chain fails without another retry", async () => {
    dir = mkdtempSync(join(tmpdir(), "isomux-lego-"));
    const oldDir = join(dir, "old");
    const newDir = join(dir, "new");
    mkdirSync(oldDir);
    mkdirSync(newDir);
    makeEcCsr(
      oldDir,
      "office.example",
      "DNS:office.example,DNS:*.office.example",
    );
    const oldCert = signCsr(oldDir, "office.example", join(oldDir, "cert.pem"));
    const csrPem = makeEcCsr(
      newDir,
      "office.example",
      "DNS:office.example,DNS:*.office.example",
    );
    const state = join(dir, "state");
    let calls = 0;
    const failed = await obtainCertificateWithLego(
      {
        root: state,
        target: {
          kind: "test",
          caDirectory: "http://127.0.0.1:14000/directory",
          cloudflareBaseUrl: "http://127.0.0.1:18080",
          zoneId: "fake-zone",
          productionZoneId: "production-zone",
        },
        email: "test@example.invalid",
        dnsHookPath: "/fake/dns-hook",
        run: async (argv, env) => {
          if (argv[0] === "openssl") return realCommand(argv, env);
          calls++;
          mkdirSync(join(state, "certificates"), { recursive: true });
          writeFileSync(
            join(state, "certificates", "office.example.crt"),
            oldCert,
          );
          return { code: 0, stdout: "", stderr: "" };
        },
        cloudflareToken: "fake",
      },
      {
        instanceId: "office-1",
        names: ["office.example", "*.office.example"],
        csrPem,
      },
    ).catch((reason: unknown) => reason);
    expect(calls).toBe(2);
    expect((failed as Error).message).toContain("different private key");
  });

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
    expect(legoEnv.LEGO_DISABLE_CNAME_SUPPORT).toBe("true");
  });

  test("does not erase a SAN byte's high bit before name binding", async () => {
    dir = mkdtempSync(join(tmpdir(), "isomux-lego-"));
    const pem = makeCsr(
      dir,
      "office.example",
      "DNS:office.example,DNS:*.office.example",
    );
    const der = Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ""), "base64");
    const authorized = Buffer.from("*.office.example", "ascii");
    const forged = Buffer.from(authorized);
    forged[2] |= 0x80;
    replaceLastBytes(der, authorized, forged);

    let legoCalls = 0;
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
        run: async (argv) => {
          if (argv[0] === "openssl") return { code: 0, stdout: "", stderr: "" };
          legoCalls++;
          return { code: 1, stdout: "", stderr: "must not run" };
        },
        cloudflareToken: "fake",
      },
      {
        instanceId: "office-1",
        names: ["office.example", "*.office.example"],
        csrPem: pemFromDer(der),
      },
    ).catch((reason: unknown) => reason);

    expect((failed as Error).message).toContain("do not match");
    expect(legoCalls).toBe(0);
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

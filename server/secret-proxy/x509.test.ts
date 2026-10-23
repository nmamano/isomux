import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCertificateAuthority,
  createLeafIssuer,
  LeafRefusedError,
} from "./x509.ts";

const dir = mkdtempSync(join(tmpdir(), "isomux-x509-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ca = createCertificateAuthority();
const LISTED = new Set(["api.example-stub.test", "github.com"]);
const issuer = createLeafIssuer(ca, (host) => LISTED.has(host));
const leaf = issuer.issue("api.example-stub.test");
writeFileSync(join(dir, "ca.pem"), ca.certPem);
writeFileSync(join(dir, "leaf.pem"), leaf.certPem);

// Only PATH: an agent shell carries proxy and CA variables that would send a
// client to the secret proxy or override the CA under test.
function clientEnv(): Record<string, string | undefined> {
  return { PATH: process.env.PATH };
}

// Async, so the TLS server in this process can answer while it runs.
async function run(
  command: string[],
  env: Record<string, string | undefined> = clientEnv(),
): Promise<{ status: number; stdout: string }> {
  const child = Bun.spawn(command, { env, stdout: "pipe", stderr: "ignore" });
  const stdout = await new Response(child.stdout).text();
  return { status: await child.exited, stdout };
}

function has(command: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${command}`]).status === 0;
}

describe("the office CA", () => {
  test("is a self-signed CA whose key matches the certificate", () => {
    const cert = new X509Certificate(ca.certPem);
    expect(cert.ca).toBe(true);
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(cert.checkPrivateKey(createPrivateKey(ca.keyPem))).toBe(true);
  });
});

describe("a leaf", () => {
  test("is signed by the CA, names only its host, and is not a CA", () => {
    const cert = new X509Certificate(leaf.certPem);
    const caCert = new X509Certificate(ca.certPem);
    expect(cert.verify(caCert.publicKey)).toBe(true);
    expect(cert.checkIssued(caCert)).toBe(true);
    expect(cert.ca).toBe(false);
    expect(cert.checkHost("api.example-stub.test")).toBe(
      "api.example-stub.test",
    );
    expect(cert.checkHost("other.example-stub.test")).toBeUndefined();
    expect(cert.checkPrivateKey(createPrivateKey(leaf.keyPem))).toBe(true);
  });

  test.skipIf(!has("openssl"))(
    "openssl verify -x509_strict accepts it (SKIPPED when openssl is absent)",
    () => {
      const result = spawnSync(
        "openssl",
        [
          "verify",
          "-x509_strict",
          "-purpose",
          "sslserver",
          "-CAfile",
          join(dir, "ca.pem"),
          join(dir, "leaf.pem"),
        ],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(0);
    },
  );
});

describe("the leaf issuer refuses names on its own", () => {
  // The caller's isListed says yes to everything: the issuer still refuses.
  const permissive = createLeafIssuer(ca, () => true);

  test("a never-listed host", () => {
    expect(() => permissive.issue("api.anthropic.com")).toThrow(
      LeafRefusedError,
    );
    expect(() => permissive.issue("registry.npmjs.org")).toThrow(
      LeafRefusedError,
    );
  });

  test("a name that is not a valid secret host", () => {
    for (const name of [
      "localhost",
      "127.0.0.1",
      "*.github.com",
      "github.com.",
    ])
      expect(() => permissive.issue(name)).toThrow(LeafRefusedError);
  });

  test("a name that isListed does not accept", () => {
    expect(() => issuer.issue("api.stripe.com")).toThrow(LeafRefusedError);
    expect(() => issuer.issue("github.com")).not.toThrow();
  });
});

describe("real TLS clients accept a leaf for the name they asked for", () => {
  let server: Server;
  let port = 0;
  const ready = new Promise<void>((resolve) => {
    server = createServer({ cert: leaf.certPem, key: leaf.keyPem }, (socket) =>
      socket.end(
        "HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok",
      ),
    );
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
  afterAll(() => server.close());

  // An agent shell routes clients through the secret proxy. Plant a dead one,
  // with no no_proxy exemption, so every shell (CI too) catches a client
  // child that inherits it.
  const SHELL_PROXY: Record<string, string | undefined> = {
    HTTPS_PROXY: "http://127.0.0.1:9",
    https_proxy: "http://127.0.0.1:9",
    NODE_USE_ENV_PROXY: "1",
    NO_PROXY: undefined,
    no_proxy: undefined,
  };
  const prior = new Map<string, string | undefined>();
  beforeAll(() => {
    for (const [name, value] of Object.entries(SHELL_PROXY)) {
      prior.set(name, process.env[name]);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  afterAll(() => {
    for (const [name, value] of prior) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test.skipIf(!has("curl"))("curl (SKIPPED when curl is absent)", async () => {
    await ready;
    const result = await run([
      "curl",
      "-sS",
      "--max-time",
      "5",
      "--cacert",
      join(dir, "ca.pem"),
      "--resolve",
      `api.example-stub.test:${port}:127.0.0.1`,
      `https://api.example-stub.test:${port}/`,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  test.skipIf(!has("python3"))(
    "Python with VERIFY_X509_STRICT (SKIPPED when python3 is absent)",
    async () => {
      await ready;
      const script = [
        "import ssl, socket, sys",
        "ctx = ssl.create_default_context(cafile=sys.argv[1])",
        "ctx.verify_flags |= ssl.VERIFY_X509_STRICT",
        "s = ctx.wrap_socket(socket.create_connection(('127.0.0.1', int(sys.argv[2]))), server_hostname='api.example-stub.test')",
        "print('verified')",
      ].join("\n");
      const result = await run([
        "python3",
        "-I",
        "-c",
        script,
        join(dir, "ca.pem"),
        String(port),
      ]);
      expect(result.stdout.trim()).toBe("verified");
    },
  );

  test.skipIf(!has("node"))("Node (SKIPPED when node is absent)", async () => {
    await ready;
    const script = `require("https").get({host:"127.0.0.1",port:${port},servername:"api.example-stub.test",headers:{host:"api.example-stub.test"}},r=>{console.log(r.statusCode)}).on("error",e=>{console.log("error")})`;
    const result = await run(["node", "-e", script], {
      ...clientEnv(),
      NODE_EXTRA_CA_CERTS: join(dir, "ca.pem"),
    });
    expect(result.stdout.trim()).toBe("200");
  });
});

// The proxy child under its supervisor: one port across restarts, a taken
// port replaced once, no orphan after the server dies, and no test seam in
// the production entry.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, createServer, type Server } from "node:net";
import { join } from "node:path";

import {
  connectThrough,
  exchange,
  startCompanyProxy,
  startEchoStub,
  proxyBasic,
  startHttpsStub,
  TEST_CLIENT_TOKEN,
  tlsThrough,
} from "../test-support/secret-proxy-stubs.ts";
import { ByteReader } from "./http1.ts";
import type { ProxySnapshot } from "./proxy.ts";
import {
  createProxySupervisor,
  PROXY_CHILD_ENTRY,
  type ProxySupervisorOptions,
} from "./supervisor.ts";
import { createCertificateAuthority } from "./x509.ts";

const TEST_CHILD = join(
  import.meta.dir,
  "..",
  "test-support",
  "secret-proxy-test-child.ts",
);
const officeCa = createCertificateAuthority();
const VALUE = "ghp_FAKEsuperFAKEsuperFAKEsuperFAKEsu01";
const PLACEHOLDER = "ghp_PLACEHOLDERplaceholderPLACEHOLDER01";

let https: Awaited<ReturnType<typeof startHttpsStub>>;
let echo: Awaited<ReturnType<typeof startEchoStub>>;
beforeAll(async () => {
  https = await startHttpsStub(["api.stub.test"]);
  echo = await startEchoStub();
});
afterAll(async () => {
  await https.close();
  await echo.close();
});

function snapshot(extra: Partial<ProxySnapshot> = {}): ProxySnapshot {
  return {
    secrets: [
      {
        scope: "office",
        ownerId: null,
        name: "GH_TOKEN",
        value: VALUE,
        hosts: ["api.stub.test"],
        form: { kind: "authorization" },
        placeholder: PLACEHOLDER,
      },
    ],
    caCertPem: officeCa.certPem,
    caKeyPem: officeCa.keyPem,
    // Production roots that do not trust the stubs.
    rootsPem: createCertificateAuthority().certPem,
    upstreamProxy: null,
    clientToken: TEST_CLIENT_TOKEN,
    ...extra,
  };
}

function supervise(
  extra: Partial<ProxySupervisorOptions> & { seams?: object } = {},
) {
  const ports: [number, number | null][] = [];
  const logs: string[] = [];
  const supervisor = createProxySupervisor({
    entry: TEST_CHILD,
    env: {
      PATH: process.env.PATH ?? "",
      ISOMUX_TEST_PROXY_SEAMS: JSON.stringify(
        extra.seams ?? {
          standIns: { "echo.stub.test:443": echo.port },
          upstreamRoots: https.ca.certPem,
        },
      ),
    },
    snapshot: () => snapshot(),
    savedPort: null,
    onPort: (port, previous) => ports.push([port, previous]),
    onUse: () => {},
    log: (code) => logs.push(code),
    ...extra,
  });
  return { supervisor, ports, logs };
}

async function tunnelWorks(port: number): Promise<boolean> {
  try {
    const tunnel = await connectThrough(port, "echo.stub.test:443");
    if ("refused" in tunnel) return false;
    tunnel.socket.write("ping");
    const back = await tunnel.reader.read(16);
    tunnel.socket.destroy();
    return back?.toString() === "ping";
  } catch {
    return false;
  }
}

async function until(check: () => boolean | Promise<boolean>, ms = 2400) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await Bun.sleep(50);
  }
  return false;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

describe("the supervisor", () => {
  test("a killed child comes back on the same port", async () => {
    const { supervisor, ports } = supervise();
    try {
      const port = await supervisor.start();
      expect(ports).toEqual([[port, null]]);
      expect(await tunnelWorks(port)).toBe(true);
      const first = supervisor.pid!;
      process.kill(first, "SIGKILL");
      expect(
        await until(
          async () =>
            supervisor.pid !== null &&
            supervisor.pid !== first &&
            (await tunnelWorks(port)),
        ),
      ).toBe(true);
      expect(supervisor.port).toBe(port);
      // Same port: no port change for agents.
      expect(ports).toHaveLength(1);
    } finally {
      await supervisor.stop();
    }
  });

  test("a saved port that is taken is replaced once, through onPort", async () => {
    const squatter: Server = createServer(() => {});
    const taken = await new Promise<number>((resolve) =>
      squatter.listen(0, "127.0.0.1", () =>
        resolve((squatter.address() as { port: number }).port),
      ),
    );
    const { supervisor, ports } = supervise({ savedPort: taken });
    try {
      const port = await supervisor.start();
      expect(port).not.toBe(taken);
      expect(ports).toEqual([[port, taken]]);
      expect(await tunnelWorks(port)).toBe(true);
    } finally {
      await supervisor.stop();
      squatter.close();
    }
  });

  test("a saved port that is free is kept, with no port change", async () => {
    const probe: Server = createServer(() => {});
    const free = await new Promise<number>((resolve) =>
      probe.listen(0, "127.0.0.1", () =>
        resolve((probe.address() as { port: number }).port),
      ),
    );
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const { supervisor, ports } = supervise({ savedPort: free });
    try {
      expect(await supervisor.start()).toBe(free);
      expect(ports).toEqual([]);
    } finally {
      await supervisor.stop();
    }
  });

  test("a snapshot push applies to the next request", async () => {
    const ROTATED = "ghp_FAKErotatedFAKErotatedFAKErotated01";
    let current = snapshot();
    const { supervisor } = supervise({
      snapshot: () => current,
      seams: {
        standIns: { "api.stub.test:443": https.port },
        upstreamRoots: https.ca.certPem,
      },
    });
    const sent = async (port: number) => {
      https.seen.length = 0;
      const socket = await tlsThrough(port, "api.stub.test", officeCa);
      await exchange(
        socket,
        new ByteReader(socket),
        `GET /headers HTTP/1.1\r\nHost: api.stub.test\r\nAuthorization: Bearer ${PLACEHOLDER}\r\n\r\n`,
      );
      socket.destroy();
      return https.seen[0]?.headers.find(([n]) => n === "Authorization")?.[1];
    };
    try {
      const port = await supervisor.start();
      expect(await sent(port)).toBe(`Bearer ${VALUE}`);
      current = snapshot({
        secrets: snapshot().secrets.map((s) => ({ ...s, value: ROTATED })),
      });
      supervisor.push();
      expect(
        await until(async () => (await sent(port)) === `Bearer ${ROTATED}`),
      ).toBe(true);
    } finally {
      await supervisor.stop();
    }
  });

  test("when the server dies by SIGKILL, the child exits and frees the port", async () => {
    const parent = Bun.spawn(
      [
        process.execPath,
        join(
          import.meta.dir,
          "..",
          "test-support",
          "secret-proxy-parent-fixture.ts",
        ),
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const line = await new Response(parent.stdout)
      .body!.getReader()
      .read()
      .then(({ value }) => new TextDecoder().decode(value));
    const { childPid, port } = JSON.parse(line) as {
      childPid: number;
      port: number;
    };
    expect(alive(childPid)).toBe(true);
    expect(await portOpen(port)).toBe(true);
    parent.kill("SIGKILL");
    await parent.exited;
    expect(await until(() => !alive(childPid))).toBe(true);
    expect(await portOpen(port)).toBe(false);
  });
});

describe("the production entry", () => {
  test("is the default, and passes no seam: an upstream that only the test roots trust gets 502", async () => {
    const company = await startCompanyProxy({
      "api.stub.test:443": https.port,
    });
    const routed = () =>
      snapshot({
        upstreamProxy: { url: `http://127.0.0.1:${company.port}`, noProxy: "" },
      });
    const production = createProxySupervisor({
      snapshot: routed,
      savedPort: null,
      onPort: () => {},
      onUse: () => {},
      log: () => {},
    });
    const withSeam = supervise({ snapshot: routed });
    try {
      expect(PROXY_CHILD_ENTRY.endsWith(join("secret-proxy", "main.ts"))).toBe(
        true,
      );
      const request = async (port: number) => {
        const socket = await tlsThrough(port, "api.stub.test", officeCa);
        const response = await exchange(
          socket,
          new ByteReader(socket),
          "GET / HTTP/1.1\r\nHost: api.stub.test\r\n\r\n",
        );
        socket.destroy();
        return response?.status;
      };
      // Same company route, same snapshot: only the test child's roots
      // trust the stub.
      expect(await request(await production.start())).toBe(502);
      expect(await request(await withSeam.supervisor.start())).toBe(200);
    } finally {
      await production.stop();
      await withSeam.supervisor.stop();
      await company.close();
    }
  });
});

test("no output or log code of the child holds a value or a placeholder: snapshots, refusals and a crash", async () => {
  const output: string[] = [];
  const { supervisor, logs } = supervise({
    onOutput: (text) => output.push(text),
    seams: {
      standIns: { "api.stub.test:443": https.port },
      upstreamRoots: https.ca.certPem,
    },
  });
  try {
    const port = await supervisor.start();
    supervisor.push();
    supervisor.push();
    // A 405 with the placeholder in it.
    const plain = connect(port, "127.0.0.1");
    plain.write(
      `GET / HTTP/1.1\r\n${proxyBasic(TEST_CLIENT_TOKEN)}\r\nAuthorization: Bearer ${PLACEHOLDER}\r\n\r\n`,
    );
    // A 421 with the placeholder in it.
    const socket = await tlsThrough(port, "api.stub.test", officeCa);
    await exchange(
      socket,
      new ByteReader(socket),
      `GET / HTTP/1.1\r\nHost: other.stub.test\r\nAuthorization: Bearer ${PLACEHOLDER}\r\n\r\n`,
    );
    socket.destroy();
    plain.destroy();
    process.kill(supervisor.pid!, "SIGKILL");
    await until(() => logs.includes("child_exited"));
  } finally {
    await supervisor.stop();
  }
  expect(logs).toContain("request_refused_421");
  const all = `${logs.join("\n")}\n${output.join("")}`;
  expect(all).not.toContain(VALUE);
  expect(all).not.toContain(PLACEHOLDER);
});

test("a change made while the child is down reaches it after its restart", async () => {
  const ROTATED = "ghp_FAKEwhiledownFAKEwhiledownFAKEwhi01";
  let current = snapshot();
  const { supervisor } = supervise({
    snapshot: () => current,
    seams: {
      standIns: { "api.stub.test:443": https.port },
      upstreamRoots: https.ca.certPem,
    },
  });
  try {
    const port = await supervisor.start();
    const first = supervisor.pid!;
    process.kill(first, "SIGKILL");
    expect(await until(() => supervisor.pid === null)).toBe(true);
    current = snapshot({
      secrets: snapshot().secrets.map((s) => ({ ...s, value: ROTATED })),
    });
    // No child: the push goes nowhere.
    supervisor.push();
    expect(
      await until(() => supervisor.pid !== null && supervisor.pid !== first),
    ).toBe(true);
    const sent = async () => {
      https.seen.length = 0;
      const socket = await tlsThrough(port, "api.stub.test", officeCa).catch(
        () => null,
      );
      if (!socket) return undefined;
      await exchange(
        socket,
        new ByteReader(socket),
        `GET /headers HTTP/1.1\r\nHost: api.stub.test\r\nAuthorization: Bearer ${PLACEHOLDER}\r\n\r\n`,
      );
      socket.destroy();
      return https.seen[0]?.headers.find(([n]) => n === "Authorization")?.[1];
    };
    expect(
      await until(async () => (await sent()) === `Bearer ${ROTATED}`),
    ).toBe(true);
  } finally {
    await supervisor.stop();
  }
});

test("a snapshot that cannot be built at a restart is retried until it can", async () => {
  let broken = false;
  const { supervisor, logs } = supervise({
    snapshot: () => {
      if (broken) throw new Error("the store could not be read");
      return snapshot();
    },
  });
  try {
    const port = await supervisor.start();
    const first = supervisor.pid!;
    broken = true;
    process.kill(first, "SIGKILL");
    expect(await until(() => logs.includes("snapshot_failed"))).toBe(true);
    expect(supervisor.pid).toBeNull();
    broken = false;
    expect(
      await until(
        async () => supervisor.pid !== null && (await tunnelWorks(port)),
      ),
    ).toBe(true);
  } finally {
    await supervisor.stop();
  }
});

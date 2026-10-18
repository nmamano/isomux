// Two offices on one host share one browser cookie jar, because browsers scope
// cookies by host, not by port (task c9f250af). Office A is this process's
// harness on plain HTTP; office B is an HTTPS-shaped office in a child process
// (second-office.ts). One jar, keyed by cookie name only, the way a browser
// keeps cookies for 127.0.0.1 on any port, carries every Set-Cookie of both.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { mintMemberLink } from "./member-link.ts";
import { startTestServer, type TestServer } from "./harness.ts";
import {
  SHARED_COOKIE_NAME,
  buildPublicOrigin,
  officeSessionCookieNames,
} from "../auth.ts";

let a: TestServer | null = null;
let stopB: (() => Promise<void>) | null = null;
afterEach(async () => {
  await stopB?.();
  stopB = null;
  await a?.stop();
  a = null;
});

interface Office {
  base: string;
  origin: string;
}

async function startB(): Promise<Office & { token: string }> {
  const home = mkdtempSync(join(tmpdir(), "second-office-"));
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "second-office.ts")],
    {
      env: { ...process.env, ISOMUX_HOME: home },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  stopB = async () => {
    void child.stdin.end();
    await child.exited;
    rmSync(home, { recursive: true, force: true });
  };
  const reader = child.stdout.getReader();
  let out = "";
  while (!out.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`second office exited early: ${out}`);
    out += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const line = out.split("\n").find((l) => l.startsWith("{"));
  if (!line) throw new Error(`second office printed no JSON: ${out}`);
  const info = JSON.parse(line) as {
    port: number;
    origin: string;
    token: string;
  };
  return {
    base: `http://127.0.0.1:${info.port}`,
    origin: info.origin,
    token: info.token,
  };
}

// The browser's cookie jar for the host. Max-Age=0 deletes, anything else
// stores; attributes other than that do not matter for which name is sent.
class Jar {
  readonly cookies = new Map<string, string>();
  take(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";").map((p) => p.trim());
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      if (attrs.includes("Max-Age=0")) this.cookies.delete(name);
      else this.cookies.set(name, pair.slice(eq + 1));
    }
  }
  header(): string {
    return [...this.cookies].map(([n, v]) => `${n}=${v}`).join("; ");
  }
}

async function send(
  jar: Jar,
  office: Office,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Cookie", jar.header());
  headers.set("Origin", office.origin);
  headers.set("Connection", "close");
  const res = await fetch(`${office.base}${path}`, {
    ...init,
    headers,
    redirect: "manual",
  });
  jar.take(res);
  return res;
}

async function whoAmI(jar: Jar, office: Office): Promise<string | null> {
  const res = await send(jar, office, "/api/sessions");
  if (res.status === 401) return null;
  if (res.status !== 200) throw new Error(`/api/sessions -> ${res.status}`);
  const body = (await res.json()) as { sessions: { username: string }[] };
  return body.sessions[0]?.username ?? null;
}

function acceptForm(token: string): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `token=${encodeURIComponent(token)}`,
  };
}

describe("two offices on one host, one browser jar", () => {
  it(
    "a session from before the update survives, and signing out of one office leaves the other signed in",
    async () => {
      const b = await startB();
      a = await startTestServer();
      await a.seedOwner("Boss");
      expect(buildPublicOrigin().isHttps).toBe(false);
      const officeA: Office = {
        base: a.baseUrl,
        origin: buildPublicOrigin().origin,
      };
      const jar = new Jar();

      // Before the update, office A wrote the shared name.
      const yu = await a.seedMember("Yu");
      jar.cookies.set(SHARED_COOKIE_NAME, yu.rawSessionId);
      expect(await whoAmI(jar, officeA)).toBe("Yu");
      // The first request copied it to A's own name; the next one retired the
      // shared copy.
      expect(jar.cookies.get(officeSessionCookieNames().plain)).toBe(
        yu.rawSessionId,
      );
      expect(await whoAmI(jar, officeA)).toBe("Yu");
      expect(jar.cookies.has(SHARED_COOKIE_NAME)).toBe(false);

      // Sign in to B in the same jar. B is HTTPS: it writes its own __Host-
      // name, which A never reads.
      const signedInB = await send(jar, b, "/auth/accept", acceptForm(b.token));
      expect(signedInB.status).toBe(302);
      expect(await whoAmI(jar, b)).toBe("Ann");
      expect(await whoAmI(jar, officeA)).toBe("Yu");
      expect(jar.cookies.size).toBe(2);

      // Sign out of A: B stays signed in.
      const outA = await send(jar, officeA, "/auth/logout", { method: "POST" });
      expect(outA.status).toBe(302);
      expect(await whoAmI(jar, officeA)).toBeNull();
      expect(await whoAmI(jar, b)).toBe("Ann");

      // Sign in to A again, sign out of B: A stays signed in.
      const link = await mintMemberLink("Yu");
      const signedInA = await send(
        jar,
        officeA,
        "/auth/accept",
        acceptForm(link.rawToken),
      );
      expect(signedInA.status).toBe(302);
      expect(await whoAmI(jar, officeA)).toBe("Yu");
      const outB = await send(jar, b, "/auth/logout", { method: "POST" });
      expect(outB.status).toBe(302);
      expect(await whoAmI(jar, b)).toBeNull();
      expect(await whoAmI(jar, officeA)).toBe("Yu");
    },
    30_000,
  );
});

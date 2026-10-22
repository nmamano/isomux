// Short app links (`https://<office>/<app>`) through the real request
// pipeline. The eligibility rule and the reserved-name inventory are owned by
// server/app-short-url.test.ts; the signed-in wrapper a GET serves is owned by
// app-widget.test.ts. This file pins the office-host dispatch: which requests
// redirect, which stay exactly as they were, and that a broken registry never
// takes office pages down with it.
//
// Before/after comparisons use HEAD or a signed-in GET on purpose: a
// signed-out GET meets the auth wall before anything app-specific can show,
// so it would compare equal whatever the short-link code did.
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionCookieName } from "../auth.ts";
import { startTestServer, type TestServer } from "./harness.ts";
import {
  anAgentToken,
  anOfficeWithAnApp,
  expectBounce,
  HTTPS_ORIGIN,
  OFFICE_HOST,
  raw,
  registerApp,
  startFlatOffice,
} from "./app-host-test-kit.ts";
import { appRegistry } from "../app-registry.ts";
import type { AppWire } from "../../shared/types.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function getApp(
  srv: TestServer,
  token: string,
  name: string,
): Promise<AppWire> {
  const response = await srv.http(`/api/apps/${name}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as AppWire;
}

describe("short app links through the office request pipeline", () => {
  it("redirects a signed-out HEAD on the office host for the app's whole life, and nothing else", async () => {
    const srv = await startFlatOffice((current) => {
      server = current;
    });
    const token = await anAgentToken(srv);
    // What these requests get while no app called `board` exists. Registering
    // one may change exactly one of them: HEAD /board on the office host.
    const unchanged = [
      { host: OFFICE_HOST, method: "HEAD", path: "/board/deeper" },
      {
        host: OFFICE_HOST,
        method: "POST",
        path: "/board",
        headers: { "Content-Length": "0" },
      },
      // The link is the office's: any other Host is not redirected.
      { host: "other.example", method: "HEAD", path: "/board" },
    ];
    const before = await Promise.all(
      unchanged.map((request) => raw(srv.port, request)),
    );
    const unregistered = await raw(srv.port, {
      host: OFFICE_HOST,
      method: "HEAD",
      path: "/board",
    });
    expect(unregistered.status).not.toBe(302);

    await registerApp(srv, token, "board");
    const app = await getApp(srv, token, "board");
    expect(app.url).toBe(`https://board.${OFFICE_HOST}`);
    expect(app.shortUrl).toBe(`${HTTPS_ORIGIN}/board`);
    // Derived, never stored.
    expect(
      readFileSync(join(srv.stateRoot, "apps", "apps.json"), "utf8"),
    ).not.toContain('"shortUrl"');
    for (const suffix of [
      "",
      "/",
      "?x=1",
      "/?x=1",
      // Only the query travels, so nothing in it can move the target host.
      "?@evil.example",
      "?//evil.example",
    ]) {
      const response = await raw(srv.port, {
        host: OFFICE_HOST,
        method: "HEAD",
        path: `/board${suffix}`,
      });
      const target = new URL(app.url!);
      target.search = new URL(`${HTTPS_ORIGIN}/board${suffix}`).search;
      expect({
        suffix,
        status: response.status,
        location: response.headers.location,
        cacheControl: response.headers["cache-control"],
        body: response.body,
      }).toEqual({
        suffix,
        status: 302,
        location: target.href,
        cacheControl: "no-store",
        body: "",
      });
    }
    for (const [index, request] of unchanged.entries()) {
      const response = await raw(srv.port, request);
      expect({ request, stable: response.stable }).toEqual({
        request,
        stable: before[index].stable,
      });
    }
    // On the app's own host the path belongs to the app arm, not the link.
    expectBounce(
      await raw(srv.port, { host: `board.${OFFICE_HOST}`, path: "/board" }),
      { label: "board", path: "/board" },
      "/board on the app host",
    );

    // A stopped or archived app keeps its link.
    for (const action of ["stop", "archive"]) {
      const response = await srv.http(`/api/apps/board/${action}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as AppWire).shortUrl).toBe(
        `${HTTPS_ORIGIN}/board`,
      );
    }
    const archived = await raw(srv.port, {
      host: OFFICE_HOST,
      path: "/board",
      method: "HEAD",
    });
    expect(archived.status).toBe(302);
    expect(archived.headers.location).toBe(`https://board.${OFFICE_HOST}/`);

    // A deleted one does not: the path is back to what it was.
    expect(
      (
        await srv.http("/api/apps/board", {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(204);
    const deleted = await raw(srv.port, {
      host: OFFICE_HOST,
      method: "HEAD",
      path: "/board",
    });
    expect(deleted.stable).toBe(unregistered.stable);
  });

  it("keeps a colliding legacy app's own URL without a short field or redirect", async () => {
    // An app registered before `skills` became an office page. Its link would
    // shadow the page, so it has none - for HEAD, and for a signed-in member's
    // GET, which would otherwise be served the app's wrapper.
    const { srv, token, rawSessionId } = await anOfficeWithAnApp((current) => {
      server = current;
    }, "board");
    const requests = [
      { host: OFFICE_HOST, method: "HEAD", path: "/skills" },
      {
        host: OFFICE_HOST,
        method: "GET",
        path: "/skills",
        headers: { Cookie: `${sessionCookieName()}=${rawSessionId}` },
      },
    ];
    const before = await Promise.all(
      requests.map((request) => raw(srv.port, request)),
    );
    // The control that keeps the GET comparison honest: this member's GET of
    // an ordinary app's link does reach the app (it moves into the install
    // scope), so an unchanged /skills is the reserved-name rule at work.
    const ordinary = await raw(srv.port, {
      ...requests[1],
      path: "/board",
    });
    expect({
      status: ordinary.status,
      location: ordinary.headers.location,
    }).toEqual({ status: 302, location: "/board/" });
    const original = appRegistry.get("board")!;
    writeFileSync(
      join(srv.stateRoot, "apps", "apps.json"),
      JSON.stringify([
        {
          ...original,
          name: "skills",
          hostLabel: undefined,
          hostGen: undefined,
        },
      ]),
    );
    const app = await getApp(srv, token, "skills");
    expect(app.url).toBe(`https://skills.${OFFICE_HOST}`);
    expect(app).not.toHaveProperty("shortUrl");
    for (const [index, request] of requests.entries()) {
      const after = await raw(srv.port, request);
      expect({ method: request.method, stable: after.stable }).toEqual({
        method: request.method,
        stable: before[index].stable,
      });
    }
  });

  it("keeps port-only offices without a short field or redirect", async () => {
    const srv = await startTestServer();
    server = srv;
    const token = await anAgentToken(srv);
    const head = { host: "localhost", method: "HEAD", path: "/board" };
    const before = await raw(srv.port, head);
    await registerApp(srv, token, "board");
    const app = await getApp(srv, token, "board");
    expect(app).not.toHaveProperty("url");
    expect(app).not.toHaveProperty("shortUrl");
    const after = await raw(srv.port, head);
    expect(after.stable).toBe(before.stable);
  });
});

it("keeps office routes and unknown pages available when the app registry is corrupt", async () => {
  // A broken optional shortcut must not block the office shell.
  const srv = await startFlatOffice((current) => {
    server = current;
  });
  const token = await anAgentToken(srv);
  await registerApp(srv, token, "board");
  const requests = ["GET", "HEAD"].flatMap((method) =>
    ["/tasks", "/settings", "/nosuchpage"].flatMap((path) =>
      [false, true].map((signedIn) => ({
        host: OFFICE_HOST,
        method,
        path,
        ...(signedIn ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      })),
    ),
  );
  const before = await Promise.all(
    requests.map((request) => raw(srv.port, request)),
  );
  writeFileSync(join(srv.stateRoot, "apps", "apps.json"), "{not json");
  // The corruption is real: the lookup the short link makes now throws.
  expect(() => appRegistry.get("nosuchpage")).toThrow();
  for (const [index, request] of requests.entries()) {
    const after = await raw(srv.port, request);
    expect({ request, stable: after.stable }).toEqual({
      request,
      stable: before[index].stable,
    });
  }
});

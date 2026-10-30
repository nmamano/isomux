// Short app links (`https://<office>/<app>`) through the real request
// pipeline. The reserved-name inventory is owned by
// server/app-short-url.test.ts; the signed-in wrapper a GET serves is owned by
// app-widget.test.ts. This file pins the eligibility rule and the office-host
// dispatch: which requests redirect, which stay exactly as they were, and that
// a broken registry never takes office pages down with it.
//
// The link answers only a member who can see the app: anyone else gets what a
// name that was never registered gets, so a stranger cannot list app names
// (docs/security-audit.md 4.6). The redirect itself is therefore asserted on a
// member's HEAD or GET; a signed-out request is asserted unchanged.
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionCookieName } from "../auth.ts";
import { startTestServer, type TestServer } from "./harness.ts";
import {
  anAgentToken,
  anOfficeWithAnApp,
  expectBounce,
  grantMemberAppRoom,
  HTTPS_ORIGIN,
  NAVIGATION_HEADERS,
  OFFICE_HOST,
  raw,
  registerApp,
  startFlatOffice,
} from "./app-host-test-kit.ts";
import { appRegistry } from "../app-registry.ts";
import type { AppWire } from "../../shared/types.ts";
import { OFFICE_LINK_PATHS } from "../../shared/office-links.ts";

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
  it("redirects HEAD on the office host only for a member who can see the app, for the app's whole life", async () => {
    const srv = await startFlatOffice((current) => {
      server = current;
    });
    const token = await anAgentToken(srv);
    const member = await srv.seedMember("Member");
    grantMemberAppRoom(srv, member.username);
    const outsider = await srv.seedMember("Outsider");
    const asMember = {
      Cookie: `${sessionCookieName()}=${member.rawSessionId}`,
    };
    const asOutsider = {
      Cookie: `${sessionCookieName()}=${outsider.rawSessionId}`,
    };
    // Who must learn nothing from HEAD /board: a stranger (plain and as a
    // browser navigation, which the auth wall may answer differently) and a
    // member who cannot see the app.
    const blind = [
      { who: "signed out", headers: {} },
      { who: "signed-out navigation", headers: NAVIGATION_HEADERS },
      { who: "outsider", headers: asOutsider },
    ];
    // What these requests get while no app called `board` exists. Registering
    // one may change exactly one of them: the member's HEAD /board.
    const unchanged = [
      ...blind.flatMap(({ headers }) =>
        ["", "/", "?x=1"].map((suffix) => ({
          host: OFFICE_HOST,
          method: "HEAD",
          path: `/board${suffix}`,
          headers,
        })),
      ),
      { host: OFFICE_HOST, method: "HEAD", path: "/board/deeper" },
      {
        host: OFFICE_HOST,
        method: "POST",
        path: "/board",
        headers: { "Content-Length": "0" },
      },
      // On any other Host, a member who cannot see the app gets nothing new
      // (the member who can see it is sent to the office host: see below).
      {
        host: "other.example",
        method: "HEAD",
        path: "/board",
        headers: asOutsider,
      },
    ];
    const before = await Promise.all(
      unchanged.map((request) => raw(srv.port, request)),
    );
    const expectUnchanged = async () => {
      for (const [index, request] of unchanged.entries()) {
        const response = await raw(srv.port, request);
        expect({ request, stable: response.stable }).toEqual({
          request,
          stable: before[index].stable,
        });
      }
    };
    const memberHead = {
      host: OFFICE_HOST,
      method: "HEAD",
      path: "/board",
      headers: asMember,
    };
    const unregistered = await raw(srv.port, memberHead);
    expect(unregistered.status).not.toBe(302);

    await registerApp(srv, token, "board");
    const app = await getApp(srv, token, "board");
    expect(app.url).toBe(`https://board.${OFFICE_HOST}`);
    expect(app.shortUrl).toBe(`${HTTPS_ORIGIN}/board`);
    // Derived, never stored.
    expect(
      readFileSync(join(srv.stateRoot, "apps", "apps.json"), "utf8"),
    ).not.toContain('"shortUrl"');
    // The path after the name and the query travel to the app's own host
    // (task 469e8886); nothing in them can move the target host.
    for (const [suffix, page] of [
      ["", "/"],
      ["/", "/"],
      ["?x=1", "/?x=1"],
      ["/?x=1", "/?x=1"],
      ["?@evil.example", "/?@evil.example"],
      ["?//evil.example", "/?//evil.example"],
      ["/deeper", "/deeper"],
      ["/blog/post-1?x=1", "/blog/post-1?x=1"],
    ]) {
      const response = await raw(srv.port, {
        ...memberHead,
        path: `/board${suffix}`,
      });
      expect({
        suffix,
        status: response.status,
        location: response.headers.location,
        cacheControl: response.headers["cache-control"],
        body: response.body,
      }).toEqual({
        suffix,
        status: 302,
        location: `https://board.${OFFICE_HOST}${page}`,
        cacheControl: "no-store",
        body: "",
      });
    }
    for (const suffix of [
      "//evil.example",
      "//evil.example/x",
      "/%2f%2fevil.example",
      "/@evil.example",
    ]) {
      const response = await raw(srv.port, {
        ...memberHead,
        path: `/board${suffix}`,
      });
      expect({ suffix, status: response.status }).toEqual({
        suffix,
        status: 302,
      });
      expect({
        suffix,
        origin: new URL(response.headers.location).origin,
      }).toEqual({ suffix, origin: `https://board.${OFFICE_HOST}` });
    }
    await expectUnchanged();
    // A stranger's HEAD of a live name reads byte for byte like one of a name
    // that was never registered.
    for (const { who, headers } of blind) {
      const [live, unknown] = await Promise.all(
        ["/board", "/zzunknown"].map((path) =>
          raw(srv.port, { host: OFFICE_HOST, method: "HEAD", path, headers }),
        ),
      );
      expect({ who, stable: live.stable }).toEqual({
        who,
        stable: unknown.stable,
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
    const archived = await raw(srv.port, memberHead);
    expect(archived.status).toBe(302);
    expect(archived.headers.location).toBe(`https://board.${OFFICE_HOST}/`);
    await expectUnchanged();

    // A deleted one does not: the path is back to what it was.
    expect(
      (
        await srv.http("/api/apps/board", {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(204);
    const deleted = await raw(srv.port, memberHead);
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
  // A broken registry must not change what an office route or an unknown page
  // answers.
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

// An address that names no app the member can open (task 38f33af3). It used to
// fall through to the office shell, which rewrites any unknown path to "/", so
// the member saw the office and no sign of why. On the office host it is now a
// small page of its own; a hidden app and an unknown name read the same, so the
// page tells nobody which hidden apps exist.
describe("an app address that opens no app", () => {
  async function anOfficeWithAnOutsider() {
    const { srv, rawSessionId, token } = await anOfficeWithAnApp((current) => {
      server = current;
    }, "board");
    const outsider = await srv.seedMember("Outsider");
    return {
      srv,
      token,
      asMember: { Cookie: `${sessionCookieName()}=${rawSessionId}` },
      asOutsider: { Cookie: `${sessionCookieName()}=${outsider.rawSessionId}` },
    };
  }

  // The office shell this office serves a signed-in member at "/".
  async function shellBody(
    srv: TestServer,
    headers: Record<string, string>,
    host = OFFICE_HOST,
  ): Promise<string> {
    const home = await raw(srv.port, { host, path: "/", headers });
    expect(home.status).toBe(200);
    expect(home.body).toContain("<html");
    return home.body;
  }

  it("answers a hidden app and an unknown name on the office host with the same not-found page", async () => {
    const { srv, asMember, asOutsider } = await anOfficeWithAnOutsider();
    const shell = await shellBody(srv, asMember);
    // The enabling condition: the member can open board and the outsider
    // cannot, so board is live for one and hidden for the other.
    const open = await raw(srv.port, {
      host: OFFICE_HOST,
      path: "/board/",
      headers: asMember,
    });
    expect(open.status).toBe(200);
    expect(open.body).toContain("isomux-app-widget");

    for (const suffix of ["", "/", "/blog/post-1?x=1"]) {
      for (const [who, headers, path] of [
        ["outsider, hidden app", asOutsider, `/board${suffix}`],
        ["outsider, unknown name", asOutsider, `/zzunknown${suffix}`],
        ["member, unknown name", asMember, `/zzunknown${suffix}`],
      ] as const) {
        const get = await raw(srv.port, { host: OFFICE_HOST, path, headers });
        expect({
          who,
          path,
          status: get.status,
          contentType: get.headers["content-type"],
          cacheControl: get.headers["cache-control"],
          hasLocation: "location" in get.headers,
          shell: get.body === shell,
          widget: get.body.includes("isomux-app-widget"),
          // The way back to the office.
          officeLink: /href="\/"/.test(get.body),
          // Nothing of the address comes back: the hidden and unknown pages
          // must read alike.
          echoesName: /board|zzunknown/.test(get.body),
        }).toEqual({
          who,
          path,
          status: 404,
          contentType: "text/html; charset=utf-8",
          cacheControl: "no-store",
          hasLocation: false,
          shell: false,
          widget: false,
          officeLink: true,
          echoesName: false,
        });
        const head = await raw(srv.port, {
          host: OFFICE_HOST,
          method: "HEAD",
          path,
          headers,
        });
        expect({
          who,
          path,
          status: head.status,
          cacheControl: head.headers["cache-control"],
          hasLocation: "location" in head.headers,
          body: head.body,
        }).toEqual({
          who,
          path,
          status: 404,
          cacheControl: "no-store",
          hasLocation: false,
          body: "",
        });
      }
      // Byte for byte, for the same visitor: a hidden app is an unknown name.
      for (const method of ["GET", "HEAD"]) {
        const [hidden, unknown] = await Promise.all(
          [`/board${suffix}`, `/zzunknown${suffix}`].map((path) =>
            raw(srv.port, {
              host: OFFICE_HOST,
              method,
              path,
              headers: asOutsider,
            }),
          ),
        );
        expect({ method, suffix, stable: hidden.stable }).toEqual({
          method,
          suffix,
          stable: unknown.stable,
        });
      }
    }
  });

  it("keeps every office page path on the office host for a signed-in member", async () => {
    const { srv, asMember } = await anOfficeWithAnOutsider();
    const shell = await shellBody(srv, asMember);
    const paths = [
      ...OFFICE_LINK_PATHS,
      "/agents/agent-1",
      "/users",
      "/?pager=abc",
    ];
    expect(paths).toContain("/inbox/pages");
    for (const path of paths) {
      const response = await raw(srv.port, {
        host: OFFICE_HOST,
        path,
        headers: asMember,
      });
      expect({
        path,
        status: response.status,
        shell: response.body === shell,
      }).toEqual({ path, status: 200, shell: true });
    }
  });

  it("serves the not-found page when the app registry is corrupt", async () => {
    const { srv, asMember } = await anOfficeWithAnOutsider();
    const request = {
      host: OFFICE_HOST,
      path: "/zzunknown",
      headers: asMember,
    };
    const before = await raw(srv.port, request);
    expect(before.status).toBe(404);
    writeFileSync(join(srv.stateRoot, "apps", "apps.json"), "{not json");
    expect(() => appRegistry.get("zzunknown")).toThrow();
    const after = await raw(srv.port, request);
    expect(after.stable).toBe(before.stable);
    // The office itself stays up.
    const home = await raw(srv.port, {
      host: OFFICE_HOST,
      path: "/",
      headers: asMember,
    });
    expect(home.status).toBe(200);
  });

  it("keeps the office shell for any app-shaped address in an office without an app domain", async () => {
    const srv = await startTestServer();
    server = srv;
    const token = await anAgentToken(srv);
    await registerApp(srv, token, "board");
    const member = await srv.seedMember("Member");
    grantMemberAppRoom(srv, member.username);
    const headers = { Cookie: `${sessionCookieName()}=${member.rawSessionId}` };
    const shell = await shellBody(srv, headers, "localhost");
    for (const path of ["/board", "/board/x", "/zzunknown", "/zzunknown/x"]) {
      const response = await raw(srv.port, {
        host: "localhost",
        path,
        headers,
      });
      expect({
        path,
        status: response.status,
        shell: response.body === shell,
      }).toEqual({ path, status: 200, shell: true });
    }
  });

  it("shows a signed-out visitor the sign-in wall for a live, hidden or unknown name alike", async () => {
    const { srv } = await anOfficeWithAnOutsider();
    const wall = await raw(srv.port, {
      host: OFFICE_HOST,
      path: "/tasks",
      headers: NAVIGATION_HEADERS,
    });
    for (const path of [
      "/board",
      "/board/x?y=1",
      "/zzunknown",
      "/zzunknown/x",
    ]) {
      const response = await raw(srv.port, {
        host: OFFICE_HOST,
        path,
        headers: NAVIGATION_HEADERS,
      });
      expect({ path, stable: response.stable }).toEqual({
        path,
        stable: wall.stable,
      });
    }
  });

  it("sends a member on another host to the office host, only for an app they can open", async () => {
    const { srv, asMember, asOutsider } = await anOfficeWithAnOutsider();
    for (const host of ["other.example", `localhost:${srv.port}`]) {
      for (const method of ["GET", "HEAD"]) {
        for (const page of ["", "/", "/blog/post-1?x=1", "//evil.example/x"]) {
          const response = await raw(srv.port, {
            host,
            method,
            path: `/board${page}`,
            headers: asMember,
          });
          expect({
            host,
            method,
            page,
            status: response.status,
            location: response.headers.location,
            cacheControl: response.headers["cache-control"],
          }).toEqual({
            host,
            method,
            page,
            status: 302,
            location: `${HTTPS_ORIGIN}/board${page}`,
            cacheControl: "no-store",
          });
          expect(new URL(response.headers.location).origin).toBe(HTTPS_ORIGIN);
        }
      }
      // A hidden app and an unknown name: the office, as before, on this host.
      const shell = await shellBody(srv, asOutsider, host);
      for (const [headers, path] of [
        [asOutsider, "/board"],
        [asOutsider, "/board/x"],
        [asOutsider, "/zzunknown"],
        [asMember, "/zzunknown/x"],
      ] as const) {
        const response = await raw(srv.port, { host, path, headers });
        expect({
          host,
          path,
          status: response.status,
          hasLocation: "location" in response.headers,
          shell: response.body === shell,
        }).toEqual({
          host,
          path,
          status: 200,
          hasLocation: false,
          shell: true,
        });
      }
    }
  });
});

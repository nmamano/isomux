// The app chat widget and "Install as app": the widget status route, the
// short-link wrapper page that carries the app's title and manifest, the
// install manifest, and the appContext check on a member's send. The wrapper's
// metadata read (title and icons) is unit-tested in
// server/app-widget-metadata.test.ts; here it is the office wiring around it:
// who gets the wrapper, and who makes the office read the app.

import { afterEach, expect, it } from "bun:test";
import { decodeHTMLAttribute } from "entities";
import {
  HTTPS_ORIGIN,
  NAVIGATION_HEADERS,
  OFFICE_HOST,
  anOfficeWithAnApp,
  raw,
  type RawResponse,
} from "./app-host-test-kit.ts";
import type { TestServer } from "./harness.ts";
import { appRegistry, appRegistrationGeneration } from "../app-registry.ts";
import { getUserByName, updateUserById } from "../users.ts";
import { mintApiToken } from "../api-tokens.ts";
import { sessionCookieName } from "../auth.ts";
import type { AppWidgetStatus } from "../../shared/contract-shapes.ts";

let server: TestServer | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;
afterEach(async () => {
  await upstream?.stop(true);
  upstream = null;
  await server?.stop();
  server = null;
});

const APP_TITLE = "Private app title";

// The app itself, on the port the registry allocated, recording what the
// office's metadata read sent it.
function startApp(
  port: number,
  seen: { cookie: string | null; authorization: string | null }[],
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(req) {
      seen.push({
        cookie: req.headers.get("cookie"),
        authorization: req.headers.get("authorization"),
      });
      return new Response(
        `<title>${APP_TITLE}</title><link rel="icon" href="https://hello.office.example/icon.png">`,
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
}

// A browser navigation on the office host, signed in or not.
function navigate(port: number, path: string, rawSessionId?: string) {
  return raw(port, {
    host: OFFICE_HOST,
    path,
    headers: {
      ...NAVIGATION_HEADERS,
      ...(rawSessionId
        ? { Cookie: `${sessionCookieName()}=${rawSessionId}` }
        : {}),
    },
  });
}

// What a page answer tells its caller, for comparing a hidden app's answer to
// an unknown name's.
function answer(res: RawResponse) {
  return {
    status: res.status,
    location: res.headers.location,
    body: res.body,
  };
}

// Attributes of the elements matching `selector` in served HTML, decoded as a
// browser's getAttribute returns them.
async function elements(
  html: string,
  selector: string,
  attributes: string[],
): Promise<Record<string, string | null>[]> {
  const found: Record<string, string | null>[] = [];
  await new HTMLRewriter()
    .on(selector, {
      element(el) {
        found.push(
          Object.fromEntries(
            attributes.map((name) => {
              const value = el.getAttribute(name);
              return [name, value === null ? null : decodeHTMLAttribute(value)];
            }),
          ),
        );
      },
    })
    .transform(new Response(html))
    .text();
  return found;
}

async function titleOf(html: string): Promise<string> {
  let title = "";
  await new HTMLRewriter()
    .on("title", {
      text(text) {
        title += text.text;
      },
    })
    .transform(new Response(html))
    .text();
  return title;
}

it("answers members and API tokens alike, refuses agent tokens, and hides unknown, stale and inaccessible apps", async () => {
  const { srv, rawSessionId, token } = await anOfficeWithAnApp((s) => {
    server = s;
  });
  const app = appRegistry.get("hello")!;
  const registration = appRegistrationGeneration(app);
  const path = `/api/apps/hello/widget?registration=${registration}`;
  const response = await srv.http(path, { rawSessionId });
  expect(response.status).toBe(200);
  const status = (await response.json()) as AppWidgetStatus;
  expect(status.registration).toBe(registration);
  expect(status.sessionExpiresAt).toBeNull();
  expect(status.chat?.agentId).toBe(app.createdByAgentId);
  expect(status.appUrl).toBe(`https://${app.hostLabel}.office.example`);
  const member = getUserByName("Member")!;
  const api = await mintApiToken({
    userId: member.id,
    name: "widget",
    expiresInDays: null,
  });
  const apiResponse = await srv.http(path, {
    headers: { Authorization: `Bearer ${api.token}` },
  });
  expect(apiResponse.status).toBe(200);
  expect(await apiResponse.json()).toEqual(status);
  // The agent token is real and holds app:read (it registered this app); the
  // route is for members only.
  const agent = await srv.http(path, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(agent.status).toBe(403);
  expect((await agent.json()).error.code).toBe("forbidden");

  const missing = await srv.http("/api/apps/missing/widget?registration=1", {
    rawSessionId,
  });
  expect(missing.status).toBe(404);
  const missingBody = await missing.json();
  expect(missingBody.error.code).toBe("not_found");
  const stale = await srv.http(
    `/api/apps/hello/widget?registration=${registration + 1}`,
    { rawSessionId },
  );
  expect(stale.status).toBe(404);
  expect(await stale.json()).toEqual(missingBody);
  updateUserById(member.id, { allowedRooms: [] });
  const hidden = await srv.http(path, { rawSessionId });
  expect(hidden.status).toBe(404);
  expect(await hidden.json()).toEqual(missingBody);
});

it("omits all target details when the target room is unavailable", async () => {
  const { srv, rawSessionId } = await anOfficeWithAnApp((s) => {
    server = s;
  });
  const app = appRegistry.get("hello")!;
  const room = srv.agentManager.createRoom("Hidden target");
  const target = await srv.agentManager.spawn(
    "Hidden",
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    room,
    undefined,
    undefined,
    undefined,
    undefined,
    "claude",
  );
  expect(target).toBeTruthy();
  expect(getUserByName("Member")!.allowedRooms).not.toContain(room);
  appRegistry.update("hello", { messageTargetAgentId: target!.id });
  const response = await srv.http(
    `/api/apps/hello/widget?registration=${appRegistrationGeneration(app)}`,
    { rawSessionId },
  );
  expect(response.status).toBe(200);
  const status = (await response.json()) as AppWidgetStatus;
  expect(status.chat).toBeNull();
  expect(JSON.stringify(status)).not.toContain(target!.id);
  expect(JSON.stringify(status)).not.toContain(target!.name);
});

// A signed-out visitor, a member who cannot see the app, and a member whose
// access was just revoked all get exactly what an unknown name gets - no
// wrapper, no redirect that says the app exists - and none of them makes the
// office read the app.
it("serves the wrapper only to a member who can see the app, and reads the app only for one", async () => {
  const { srv, rawSessionId } = await anOfficeWithAnApp((s) => {
    server = s;
  });
  const seen: { cookie: string | null; authorization: string | null }[] = [];
  upstream = startApp(appRegistry.get("hello")!.port, seen);
  const expectHidden = async (rawSession?: string) => {
    for (const suffix of ["", "/"]) {
      const hidden = await navigate(srv.port, `/hello${suffix}`, rawSession);
      const unknown = await navigate(srv.port, `/unknown${suffix}`, rawSession);
      expect(answer(hidden)).toEqual(answer(unknown));
      expect(hidden.body).not.toContain("isomux-app-widget");
    }
  };

  await expectHidden();
  const outsider = await srv.seedMember("Outsider");
  await expectHidden(outsider.rawSessionId);
  expect(seen).toEqual([]);

  const wrapper = await navigate(srv.port, "/hello/", rawSessionId);
  expect(wrapper.status).toBe(200);
  expect(
    await elements(wrapper.body, 'meta[name="isomux-app-widget"]', ["name"]),
  ).toHaveLength(1);
  // The read is a fresh request: the member's office cookie stays home.
  expect(seen).toEqual([{ cookie: null, authorization: null }]);

  updateUserById(getUserByName("Member")!.id, { allowedRooms: [] });
  await expectHidden(rawSessionId);
  expect(seen).toHaveLength(1);
});

// Install as app (task 8a07aa4e). Chrome installs a page only through the
// manifest it links, and it fetches that manifest without cookies unless the
// link says crossorigin="use-credentials". The manifest's scope is /<app>/, so
// the short link moves to that path first: a page outside its own scope
// installs with an address bar, and scope "/<app>" would also capture
// /<app>-other.
it("moves a visible app's short link into its install scope and serves the app's wrapper there", async () => {
  const { srv, rawSessionId } = await anOfficeWithAnApp((s) => {
    server = s;
  });
  const app = appRegistry.get("hello")!;
  upstream = startApp(app.port, []);

  for (const suffix of ["", "?view=details", "?//evil.example"]) {
    const moved = await navigate(srv.port, `/hello${suffix}`, rawSessionId);
    expect(moved.status).toBe(302);
    const target = new URL(moved.headers.location, HTTPS_ORIGIN);
    expect(target.origin).toBe(HTTPS_ORIGIN);
    expect(target.pathname).toBe("/hello/");
    expect(target.search).toBe(new URL(`${HTTPS_ORIGIN}/${suffix}`).search);
  }

  const wrapper = await navigate(
    srv.port,
    "/hello/?view=details",
    rawSessionId,
  );
  expect(wrapper.status).toBe(200);
  expect(wrapper.headers["cache-control"]).toBe("no-store");
  expect(wrapper.headers["content-security-policy"]).toContain(
    "frame-ancestors 'none'",
  );
  expect(wrapper.headers["content-security-policy"]).toContain(
    "https://*.office.example",
  );
  // The widget boots from the registration it was served for.
  const [boot] = await elements(
    wrapper.body,
    'meta[name="isomux-app-widget"]',
    ["content"],
  );
  expect(JSON.parse(boot.content!)).toEqual({
    name: "hello",
    registration: appRegistrationGeneration(app),
  });
  // The tab carries the app's own title, read from the running app.
  expect(await titleOf(wrapper.body)).toBe(APP_TITLE);
  expect(
    await elements(wrapper.body, 'link[rel="manifest"]', [
      "href",
      "crossorigin",
    ]),
  ).toEqual([
    { href: "/api/apps/hello/manifest", crossorigin: "use-credentials" },
  ]);
  // The office page keeps the office's own manifest.
  const office = await navigate(srv.port, "/", rawSessionId);
  expect(
    await elements(office.body, 'link[rel="manifest"]', [
      "href",
      "crossorigin",
    ]),
  ).toEqual([{ href: "/manifest.json", crossorigin: null }]);
});

it("checks app context at send time and derives member provenance from the app", async () => {
  const { srv, rawSessionId, token } = await anOfficeWithAnApp((s) => {
    server = s;
  });
  const app = appRegistry.get("hello")!;
  const target = app.createdByAgentId!;
  const context = {
    name: app.name,
    registration: appRegistrationGeneration(app),
  };
  const send = async (appContext: unknown, bearer?: string) => {
    const response = await srv.http(`/api/agents/${target}/messages`, {
      method: "POST",
      rawSessionId: bearer ? undefined : rawSessionId,
      headers: {
        "Content-Type": "application/json",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify({
        text: "Widget message",
        ...(appContext === undefined ? {} : { appContext }),
      }),
    });
    return { status: response.status, body: await response.json() };
  };
  // An agent may not speak as an app widget: the same agent send without an
  // appContext is not refused.
  expect((await send(undefined, token)).status).not.toBe(403);
  expect((await send(context, token)).status).toBe(403);
  const malformed = await send({ name: "hello", registration: "bad" });
  expect(malformed.status).toBe(422);
  expect(malformed.body.error.code).toBe("invalid_app_context");
  const missing = await send({ name: "missing", registration: 1 });
  expect(missing.status).toBe(404);
  expect(missing.body.error.code).toBe("app_unavailable");
  expect(
    (await send({ ...context, registration: context.registration + 1 })).body,
  ).toEqual(missing.body);
  const hiddenRoom = srv.agentManager.createRoom("Private");
  const hiddenAgent = await srv.agentManager.spawn(
    "Private agent",
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    hiddenRoom,
  );
  const privateApp = appRegistry.register({
    name: "private",
    command: "bun app.ts",
    cwd: srv.stateRoot,
    userId: getUserByName("Morgan")!.id,
    username: "Morgan",
    createdBy: "Private agent",
    createdByAgentId: hiddenAgent!.id,
  });
  const hidden = await send({
    name: privateApp.name,
    registration: appRegistrationGeneration(privateApp),
  });
  expect(hidden.status).toBe(404);
  expect(hidden.body).toEqual(missing.body);
  appRegistry.update("hello", { messageTargetAgentId: hiddenAgent!.id });
  const changed = await send(context);
  expect(changed.status).toBe(409);
  expect(changed.body.error.code).toBe("app_target_changed");
  appRegistry.update("hello", { messageTargetAgentId: target });
  expect((await send(context)).status).toBe(200);
  const widgetMessages = () =>
    srv.agentManager
      .getAgentLogs(target)
      .filter(
        (item) =>
          item.kind === "user_message" &&
          item.content === "Widget message" &&
          item.metadata?.username === "Member",
      );
  // The member sent it, from the app: the app is named on the entry and in
  // what the agent reads.
  expect(widgetMessages()).toHaveLength(1);
  expect(widgetMessages()[0].metadata?.device).toContain(app.name);
  const delivered = srv.fakeBackend.sessions
    .flatMap((session) => session.sent)
    .filter((message) => message.text.includes("Widget message"))
    .map((message) => message.text);
  expect(
    delivered.filter(
      (text) => text.includes("Member") && text.includes(app.name),
    ),
  ).toHaveLength(1);
  const api = await mintApiToken({
    userId: getUserByName("Member")!.id,
    name: "Widget API",
    expiresInDays: null,
  });
  expect((await send(context, api.token)).status).toBe(200);
  const apiEntry = widgetMessages().at(-1);
  expect(widgetMessages()).toHaveLength(2);
  expect(apiEntry?.metadata?.device).toContain(app.name);
  expect(apiEntry?.metadata?.device).toContain(api.apiToken.id);
});

const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36";
const DESKTOP_CHROME =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";

it("serves the app's manifest to a member's credentialed manifest fetch only", async () => {
  const { srv, rawSessionId, token } = await anOfficeWithAnApp((s) => {
    server = s;
  });
  // What Chrome sends for <link rel="manifest" crossorigin="use-credentials">.
  const manifestFetch = (name: string, cookie?: string, userAgent = ANDROID) =>
    raw(srv.port, {
      host: OFFICE_HOST,
      path: `/api/apps/${name}/manifest`,
      headers: {
        "User-Agent": userAgent,
        "Sec-Fetch-Dest": "manifest",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        Origin: HTTPS_ORIGIN,
        ...(cookie ? { Cookie: `${sessionCookieName()}=${cookie}` } : {}),
      },
    });
  const response = await manifestFetch("hello", rawSessionId);
  expect(response.status).toBe(200);
  expect(response.headers["content-type"]).toStartWith(
    "application/manifest+json",
  );
  expect(response.headers["cache-control"]).toBe("no-store");
  const manifest = JSON.parse(response.body);
  // The app is not running in this office, so its title is its name.
  expect(manifest).toMatchObject({
    id: "/hello/",
    start_url: "/hello/",
    scope: "/hello/",
    name: "hello",
    short_name: "hello",
    display: "standalone",
  });
  const icons = manifest.icons as {
    src: string;
    type: string;
    sizes: string;
  }[];
  expect(
    icons.some(
      (icon) =>
        icon.src.startsWith("data:image/svg+xml,") && icon.sizes === "any",
    ),
  ).toBe(true);
  // Android installs only with a raster icon of at least 144px, fetched with
  // no cookie: each one must load signed out.
  const rasters = icons.filter((icon) => icon.type === "image/png");
  expect(rasters.some((icon) => Number(icon.sizes.split("x")[0]) >= 144)).toBe(
    true,
  );
  for (const icon of rasters) {
    const png = await raw(srv.port, { host: OFFICE_HOST, path: icon.src });
    expect(png.status).toBe(200);
    expect(png.headers["content-type"]).toStartWith("image/png");
  }
  // Off Android the app's SVG is the only icon: an iPhone would take the
  // office PNG over its own letter icon, and desktop Chrome installs from
  // the SVG.
  for (const userAgent of [IPHONE, DESKTOP_CHROME]) {
    const other = await manifestFetch("hello", rawSessionId, userAgent);
    expect(other.status).toBe(200);
    const types = (JSON.parse(other.body).icons as { type: string }[]).map(
      (icon) => icon.type,
    );
    expect(types.length).toBeGreaterThan(0);
    expect(types.every((type) => type === "image/svg+xml")).toBe(true);
  }

  const signedOut = await manifestFetch("hello");
  expect(signedOut.status).toBe(401);
  const missing = await manifestFetch("missing", rawSessionId);
  expect(missing.status).toBe(404);
  const outsider = await srv.seedMember("Outsider");
  const hidden = await manifestFetch("hello", outsider.rawSessionId);
  expect(hidden.status).toBe(404);
  expect(hidden.body).toBe(missing.body);
  const agent = await srv.http("/api/apps/hello/manifest", {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(agent.status).toBe(403);
  expect((await agent.json()).error.code).toBe("forbidden");
});

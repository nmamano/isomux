import { afterEach, expect, it } from "bun:test";
import { anOfficeWithAnApp } from "./app-host-test-kit.ts";
import type { TestServer } from "./harness.ts";
import { appRegistry, appRegistrationGeneration } from "../app-registry.ts";
import { getUserByName, updateUserById } from "../users.ts";
import { mintApiToken } from "../api-tokens.ts";
import type { AppWidgetStatus } from "../../shared/contract-shapes.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

it("checks member and remote API access, hides targets, and refuses agent identities", async () => {
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
  expect(
    (await srv.http(path, { headers: { Authorization: `Bearer ${token}` } }))
      .status,
  ).toBe(403);

  appRegistry.update("hello", { messageTargetAgentId: app.createdByAgentId });
  const hiddenBefore = await srv.http(
    "/api/apps/missing/widget?registration=1",
    { rawSessionId },
  );
  const missingBody = await hiddenBefore.json();
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

it("serves a private wrapper only after office sign-in and app access", async () => {
  const { srv, rawSessionId } = await anOfficeWithAnApp((s) => {
    server = s;
  });
  const { raw, OFFICE_HOST, NAVIGATION_HEADERS } =
    await import("./app-host-test-kit.ts");
  const { sessionCookieName } = await import("../auth.ts");
  const fetchPage = (path: string, cookie?: string) =>
    raw(srv.port, {
      host: OFFICE_HOST,
      path,
      headers: {
        ...NAVIGATION_HEADERS,
        ...(cookie ? { Cookie: `${sessionCookieName()}=${cookie}` } : {}),
      },
    });
  const signedOut = await fetchPage("/hello");
  const unknownSignedOut = await fetchPage("/unknown");
  expect(signedOut.status).toBe(unknownSignedOut.status);
  expect(signedOut.body).toBe(unknownSignedOut.body);
  expect(signedOut.body).not.toContain("isomux-app-widget");
  const wrapper = await fetchPage("/hello/?view=details", rawSessionId);
  expect(wrapper.status).toBe(200);
  expect(wrapper.body).toContain('name="isomux-app-widget"');
  expect(wrapper.headers["cache-control"]).toBe("no-store");
  expect(wrapper.headers["content-security-policy"]).toContain(
    "frame-ancestors 'none'",
  );
  expect(wrapper.headers["content-security-policy"]).toContain(
    "https://*.office.example",
  );
  const outsider = await srv.seedMember("Outsider");
  const hidden = await fetchPage("/hello", outsider.rawSessionId);
  const missing = await fetchPage("/unknown", outsider.rawSessionId);
  const office = await fetchPage("/", outsider.rawSessionId);
  expect(hidden.status).toBe(office.status);
  expect(hidden.body).toBe(office.body);
  expect(hidden.body).toBe(missing.body);
  expect(hidden.body).not.toContain("isomux-app-widget");
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
      body: JSON.stringify({ text: "Widget message", appContext }),
    });
    return { status: response.status, body: await response.json() };
  };
  expect((await send(context, token)).status).toBe(403);
  expect((await send({ name: "hello", registration: "bad" })).status).toBe(422);
  const missing = await send({ name: "missing", registration: 1 });
  expect(missing.status).toBe(404);
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
    userId: getUserByName("Boss")!.id,
    username: "Boss",
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
  const entry = srv.agentManager
    .getAgentLogs(target)
    .find(
      (item) =>
        item.kind === "user_message" && item.content === "Widget message",
    );
  expect(entry?.metadata?.username).toBe("Member");
  expect(entry?.metadata?.device).toBe("App hello");
  expect(
    srv.fakeBackend.sessions
      .flatMap((session) => session.sent)
      .some((message) => message.text.startsWith("[Member (App hello)]")),
  ).toBe(true);
  const api = await mintApiToken({
    userId: getUserByName("Member")!.id,
    name: "Widget API",
    expiresInDays: null,
  });
  expect((await send(context, api.token)).status).toBe(200);
  const apiEntry = srv.agentManager
    .getAgentLogs(target)
    .filter(
      (item) =>
        item.kind === "user_message" && item.content === "Widget message",
    )
    .at(-1);
  expect(apiEntry?.metadata?.device).toContain("; App hello");
  expect(apiEntry?.metadata?.device).toContain(api.apiToken.id);
});

it("refuses an image send when the app target changes after upload", async () => {
  const { srv, rawSessionId } = await anOfficeWithAnApp((s) => {
    server = s;
  });
  const app = appRegistry.get("hello")!;
  const original = srv.agentManager.getAgent(app.createdByAgentId!)!;
  const replacement = await srv.agentManager.spawn(
    "New image target",
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    original.roomId,
  );
  const form = new FormData();
  form.append(
    "file",
    new File(["image bytes"], "shot.png", { type: "image/png" }),
  );
  const uploaded = await srv.http(`/api/upload/${original.id}`, {
    method: "POST",
    rawSessionId,
    body: form,
  });
  expect(uploaded.status).toBe(200);
  const { attachments } = await uploaded.json();
  expect(attachments).toHaveLength(1);
  appRegistry.update(app.name, { messageTargetAgentId: replacement!.id });
  const sent = await srv.http(`/api/agents/${original.id}/messages`, {
    method: "POST",
    rawSessionId,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: "Old target image",
      attachments,
      appContext: {
        name: app.name,
        registration: appRegistrationGeneration(app),
      },
    }),
  });
  expect(sent.status).toBe(409);
  expect((await sent.json()).error.code).toBe("app_target_changed");
  expect(
    srv.agentManager
      .getAgentLogs(replacement!.id)
      .filter((entry) => entry.kind === "user_message"),
  ).toHaveLength(0);
  expect(
    srv.agentManager
      .getAgentLogs(original.id)
      .filter((entry) => entry.kind === "user_message"),
  ).toHaveLength(0);
});

// The links of one rel in served HTML, as a browser parses them.
async function linksWithRel(html: string, rel: string) {
  const found: Record<string, string | null>[] = [];
  await new HTMLRewriter()
    .on("link", {
      element(el) {
        if (
          (el.getAttribute("rel") ?? "")
            .toLowerCase()
            .split(/\s+/)
            .includes(rel)
        )
          found.push({
            href: el.getAttribute("href"),
            crossorigin: el.getAttribute("crossorigin"),
          });
      },
    })
    .transform(new Response(html))
    .text();
  return found;
}

// Install as app (task 8a07aa4e). Chrome installs a page only through the
// manifest it links, and it fetches that manifest without cookies unless the
// link says crossorigin="use-credentials". The manifest's scope is /<app>/, so
// the short link moves to that path first: a page outside its own scope
// installs with an address bar, and scope "/<app>" would also capture
// /<app>-other.
it("moves a visible app's short link into its install scope and links the app's manifest there", async () => {
  const { srv, rawSessionId } = await anOfficeWithAnApp((s) => {
    server = s;
  });
  const { raw, OFFICE_HOST, HTTPS_ORIGIN, NAVIGATION_HEADERS } =
    await import("./app-host-test-kit.ts");
  const { sessionCookieName } = await import("../auth.ts");
  const fetchPage = (path: string, cookie?: string) =>
    raw(srv.port, {
      host: OFFICE_HOST,
      path,
      headers: {
        ...NAVIGATION_HEADERS,
        ...(cookie ? { Cookie: `${sessionCookieName()}=${cookie}` } : {}),
      },
    });

  for (const suffix of ["", "?view=details", "?//evil.example"]) {
    const moved = await fetchPage(`/hello${suffix}`, rawSessionId);
    expect(moved.status).toBe(302);
    const target = new URL(moved.headers.location, HTTPS_ORIGIN);
    expect(target.origin).toBe(HTTPS_ORIGIN);
    expect(target.pathname).toBe("/hello/");
    expect(target.search).toBe(new URL(`${HTTPS_ORIGIN}/${suffix}`).search);
  }

  const wrapper = await fetchPage("/hello/", rawSessionId);
  expect(wrapper.status).toBe(200);
  expect(wrapper.body).toContain('name="isomux-app-widget"');
  expect(await linksWithRel(wrapper.body, "manifest")).toEqual([
    { href: "/api/apps/hello/manifest", crossorigin: "use-credentials" },
  ]);
  // The office page keeps the office's own manifest.
  const office = await fetchPage("/", rawSessionId);
  expect(await linksWithRel(office.body, "manifest")).toEqual([
    { href: "/manifest.json", crossorigin: null },
  ]);

  // A member who cannot see the app, and a signed-out visitor, get what an
  // unknown name gets: no redirect tells them the app exists.
  const outsider = await srv.seedMember("Outsider");
  const hidden = await fetchPage("/hello", outsider.rawSessionId);
  const unknown = await fetchPage("/unknown", outsider.rawSessionId);
  expect(hidden.status).toBe(unknown.status);
  expect(hidden.headers.location).toBeUndefined();
  expect(hidden.body).toBe(unknown.body);
  const signedOut = await fetchPage("/hello");
  const unknownSignedOut = await fetchPage("/unknown");
  expect(signedOut.status).toBe(unknownSignedOut.status);
  expect(signedOut.headers.location).toBe(unknownSignedOut.headers.location);
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
  const { raw, OFFICE_HOST, HTTPS_ORIGIN } =
    await import("./app-host-test-kit.ts");
  const { sessionCookieName } = await import("../auth.ts");
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
  expect(
    (
      await srv.http("/api/apps/hello/manifest", {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status,
  ).toBe(403);
});

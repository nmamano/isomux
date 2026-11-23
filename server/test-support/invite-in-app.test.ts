// The invite page in another app's browser (task 5765f58e, part 3). A sign-in
// link opened in a mail or social app's view would sign in only that view and
// use up the one-time link. There the page stops before Accept: a notice,
// Copy link (the link to open in the member's own browser) and a small "Sign
// in here anyway" that submits the old Accept form. Every other browser gets
// the page as before. Which user agent is an in-app view:
// shared/in-app-view.test.ts.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import {
  _testMintLegacyInvite,
  peekInvite,
  sessionCookieName,
  validateSession,
} from "../auth.ts";
import { mintMemberLink } from "./member-link.ts";
import { en } from "../../shared/i18n/en.ts";
import { IOS_UA } from "../../ui/test-support/ios-browsers.ts";

const ANDROID_FACEBOOK =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A.240305.019; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0.6261.119 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/456.0.0.38.109;]";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";

// The catalog's text for a key this task adds.
function label(key: string): string {
  const text = (en as Record<string, string | undefined>)[key];
  expect(typeof text).toBe("string");
  return text!;
}

// One server for the file, with no owner: a first-time-setup link stays
// valid until an owner exists. Each test mints its own link.
let srv: TestServer;
beforeAll(async () => {
  srv = await startTestServer();
});
afterAll(async () => {
  await srv.stop();
});

function getPage(token: string, userAgent: string) {
  return srv.http(`/i/${token}`, {
    headers: { "User-Agent": userAgent, "Accept-Language": "en" },
  });
}

function postAccept(
  fields: Record<string, string>,
  userAgent: string,
): Promise<Response> {
  return srv.http("/auth/accept", {
    method: "POST",
    redirect: "manual",
    headers: {
      "User-Agent": userAgent,
      "Accept-Language": "en",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields),
  });
}

function varies(res: Response): boolean {
  return /\buser-agent\b/i.test(res.headers.get("Vary") ?? "");
}

// The accept form, from its opening tag to its end.
function acceptForm(html: string): string {
  const form =
    /<form method="POST" action="\/auth\/accept">[\s\S]*?<\/form>/.exec(html);
  expect(form).not.toBeNull();
  return form![0];
}

// The in-app form of the page, for the link `token`: the notice, then Copy
// link with the page's own /i/ path (never the address it was served from),
// then the accept form, whose submit is "Sign in here anyway". No Accept and
// continue.
function expectInAppPage(html: string, token: string, menu: "ios" | "android") {
  expect(html).toContain("data-in-app-notice");
  const links = [...html.matchAll(/data-link="([^"]*)"/g)].map((m) => m[1]);
  expect(links).toEqual([`/i/${token}`]);
  expect([...html.matchAll(/data-menu="([^"]*)"/g)].map((m) => m[1])).toEqual([
    menu,
  ]);
  expect(html).not.toContain(en["preAuth.invite.accept"]);
  expect(html).not.toContain(en["preAuth.invite.clickHint"]);
  const form = acceptForm(html);
  expect(html.indexOf("data-link=")).toBeLessThan(html.indexOf(form));
  expect(form).toContain(`name="token" value="${token}"`);
  const submit = /<button[^>]*type="submit"[^>]*>([^<]*)<\/button>/.exec(form);
  expect(submit?.[1]).toBe(label("preAuth.inApp.anyway"));
}

function expectBrowserPage(html: string) {
  expect(html).toContain(en["preAuth.invite.accept"]);
  expect(html).not.toContain("data-in-app-notice");
  expect(html).not.toContain("data-link=");
  expect(html).not.toContain(label("preAuth.inApp.anyway"));
}

describe("the invite page in another app's browser", () => {
  it("stops before Accept in an iPhone Instagram view, keeps the link, and signs in there only on Sign in here anyway", async () => {
    const { rawToken } = await mintMemberLink("Ines");
    const page = await getPage(rawToken, IOS_UA.instagram);
    expect(page.status).toBe(200);
    expect(varies(page)).toBe(true);
    expectInAppPage(await page.text(), rawToken, "ios");
    // The GET uses nothing: the link still opens in the member's browser.
    expect(peekInvite(rawToken)).not.toHaveProperty("error");

    const accepted = await postAccept({ token: rawToken }, IOS_UA.instagram);
    expect(accepted.status).toBe(302);
    const session = accepted.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${sessionCookieName()}=`));
    const raw = session?.split(";")[0].slice(sessionCookieName().length + 1);
    expect(validateSession(raw ?? null)?.username).toBe("Ines");
  });

  it("draws Android's menu icon in an Android Facebook view", async () => {
    const { rawToken } = await mintMemberLink("Ana");
    const page = await getPage(rawToken, ANDROID_FACEBOOK);
    expect(varies(page)).toBe(true);
    expectInAppPage(await page.text(), rawToken, "android");
  });

  for (const [browser, ua] of [
    ["iPhone Safari", IOS_UA.safari],
    ["iPhone Chrome", IOS_UA.chrome],
    ["Android Chrome", ANDROID_CHROME],
    ["an empty user agent", ""],
  ] as const) {
    it(`shows Accept and continue as before in ${browser}`, async () => {
      const { rawToken } = await mintMemberLink(`Bea ${browser}`);
      const page = await getPage(rawToken, ua);
      expect(page.status).toBe(200);
      // A cache must not give one browser's page to another.
      expect(varies(page)).toBe(true);
      expectBrowserPage(await page.text());
    });
  }

  // The member chose to sign in here: the error page keeps the in-app form,
  // and its Copy link still gives the /i/ link, not /auth/accept.
  it("keeps the in-app form, with the invite link, when Sign in here anyway comes back with an error", async () => {
    const { rawToken } = await _testMintLegacyInvite({
      username: null,
      role: "member",
    });
    const page = await getPage(rawToken, IOS_UA.linkedin);
    const html = await page.text();
    expectInAppPage(html, rawToken, "ios");
    // The condition: the form asks for a name, so an empty one is refused.
    expect(acceptForm(html)).toContain('name="name"');

    const refused = await postAccept(
      { token: rawToken, name: "" },
      IOS_UA.linkedin,
    );
    expect(refused.status).toBe(400);
    expect(varies(refused)).toBe(true);
    const again = await refused.text();
    expect(again).toContain(en["preAuth.invite.errorName"]);
    expectInAppPage(again, rawToken, "ios");
    expect(peekInvite(rawToken)).not.toHaveProperty("error");
  });

  it("stops before Continue on a first-time-setup link in an in-app view", async () => {
    const { rawToken } = await _testMintLegacyInvite({
      username: null,
      role: "owner",
      bootstrap: true,
    });
    const page = await getPage(rawToken, IOS_UA.facebook);
    expect(page.status).toBe(200);
    expect(varies(page)).toBe(true);
    const html = await page.text();
    expect(peekInvite(rawToken)).toMatchObject({ bootstrap: true });
    expectInAppPage(html, rawToken, "ios");
    expect(acceptForm(html)).toContain('name="name"');
  });
});

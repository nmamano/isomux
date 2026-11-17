// Settings > You > New device (task 5049bb26): the one click that adds a
// device. Selecting the row mints a self sign-in link (POST /api/invites/self)
// once and shows it as a QR code and a URL box; the Sign-in links pane keeps
// only the lists and no longer mints.
//
// The QR is checked by what it encodes: the test reads the module grid out of
// the SVG and compares it with uqr's matrix for the minted URL at each error
// correction level, so the render options (border, module size) are free.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { encode } = await import("uqr");
const { UserSettingsView } = await import("./components/UserSettingsView.tsx");
const { NewDevicePane } = await import("./components/MyDevicesPane.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { setApiShim, ApiError } = await import("./api.ts");
const { translatorFor } = await import("../shared/i18n/translate.ts");

const { t } = translatorFor("en");

type View = ReturnType<typeof render>;

const URL_A = "https://office.example.com/i/new-device-token-a";
const URL_B = "https://office.example.com/i/new-device-token-b";

const INVITE = {
  tokenPrefix: "ab12cd34",
  username: "Tester",
  role: "owner" as const,
  createdBy: "u1",
  createdAt: 0,
  expiresAt: 3_600_000,
};

// Each POST /api/invites/self takes the next answer from `answers`: a URL, an
// error to throw, or a promise to wait on. Every mint is counted.
type Answer = string | Error | Promise<string>;
let answers: Answer[] = [];
let mints = 0;
setApiShim(async (method, path) => {
  if (method === "POST" && path === "/api/invites/self") {
    mints++;
    const next = answers.shift();
    if (next === undefined) throw new Error("unexpected extra mint");
    if (next instanceof Error) throw next;
    return { url: await next, invite: INVITE };
  }
  if (path === "/api/removed-members") return { members: [] };
  if (path.startsWith("/api/memory"))
    return { text: "", version: "0", size: 0, cap: 4000 };
  if (path === "/api/office/settings")
    return { name: "", prompt: "", version: "1" };
  if (path.endsWith("/instructions")) return { instructions: "", version: "1" };
  throw new Error(`no shim for ${method} ${path}`);
});
afterAll(() => setApiShim(null));

beforeEach(() => {
  window.localStorage.clear();
  answers = [];
  mints = 0;
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const LISTS = { invitesLoaded: true, activeSessionsLoaded: true };

const settings = (over: Record<string, unknown> = {}) =>
  onLanguage(
    null,
    createElement(UserSettingsView, {
      onSwitchUser: () => {},
      onClose: () => {},
    }),
    { hasReceivedInitialState: true, ...LISTS, ...over },
  );

/** The sidebar button whose text is exactly `label`, or null. */
function row(view: View, label: string): HTMLButtonElement | null {
  return (
    view
      .queryAllByText(label)
      .map((el) => el.closest("button"))
      .find((el): el is HTMLButtonElement => el !== null) ?? null
  );
}

/** The New device row: the You group's button right after Sign-in links. */
function newDeviceRow(view: View): HTMLButtonElement | null {
  const signIn = row(view, t("settings.sidebar.signInLinks"));
  if (!signIn) throw new Error("no Sign-in links row");
  const next = signIn.nextElementSibling;
  return next instanceof HTMLButtonElement ? next : null;
}

function requireNewDeviceRow(view: View): HTMLButtonElement {
  const found = newDeviceRow(view);
  expect(found, "a button row after Sign-in links").not.toBeNull();
  return found!;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el);
  });
  await settle();
}

const qrImages = (view: View) =>
  view.container.querySelectorAll<HTMLImageElement>("img[data-device-qr]");

/** The dark modules of the QR's SVG, as a square grid without its border. */
function qrGrid(img: HTMLImageElement): boolean[][] {
  const src = img.getAttribute("src") ?? "";
  const prefix = "data:image/svg+xml;utf8,";
  expect(src.startsWith(prefix), "the QR is an inline SVG").toBe(true);
  const svg = decodeURIComponent(src.slice(prefix.length));
  // uqr draws each dark module as "M<x>,<y>h<s>v<s>h-<s>z".
  const cells = [...svg.matchAll(/M(\d+),(\d+)h(\d+)v/g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
    s: Number(m[3]),
  }));
  expect(cells.length, "dark modules in the QR").toBeGreaterThan(0);
  const s = cells[0]!.s;
  // The top-left finder pattern is dark at the grid's corner, so the smallest
  // coordinate is the border.
  const x0 = Math.min(...cells.map((c) => c.x));
  const y0 = Math.min(...cells.map((c) => c.y));
  const size = Math.max(...cells.map((c) => (c.x - x0) / s)) + 1;
  const grid = Array.from({ length: size }, () =>
    Array<boolean>(size).fill(false),
  );
  for (const c of cells) grid[(c.y - y0) / s]![(c.x - x0) / s] = true;
  return grid;
}

/** Whether the QR image encodes `text`, at any error correction level. */
function encodes(img: HTMLImageElement, text: string): boolean {
  const grid = JSON.stringify(qrGrid(img));
  // border 0: encode() pads its matrix with the border, qrGrid strips it.
  return (["L", "M", "Q", "H"] as const).some((ecc) =>
    [false, true].some(
      (boostEcc) =>
        JSON.stringify(encode(text, { ecc, boostEcc, border: 0 }).data) ===
        grid,
    ),
  );
}

describe("Settings > You > New device", () => {
  it("is a row after Sign-in links that mints one link on select and shows it as a QR code and a URL", async () => {
    answers = [URL_A];
    const view = render(settings());
    await settle();
    const newDevice = requireNewDeviceRow(view);
    expect(mints, "no mint before the row is selected").toBe(0);
    expect(qrImages(view).length, "no QR before the row is selected").toBe(0);

    await click(newDevice);
    expect(newDevice.getAttribute("aria-current"), "row selected").toBe("true");
    expect(mints, "one mint on select").toBe(1);
    const imgs = qrImages(view);
    expect(imgs.length, "one QR code").toBe(1);
    expect(encodes(imgs[0]!, URL_A), "the QR encodes the minted URL").toBe(
      true,
    );
    expect(view.queryAllByText(URL_A).length, "the URL box").toBe(1);
    expect(
      view.queryAllByText(t("settings.access.signInUrl")).length,
      "self sign-in wording",
    ).toBe(1);

    // The mint broadcasts invites_list; the store change must not mint again.
    view.rerender(settings({ invitesList: [INVITE] }));
    await settle();
    expect(mints, "no mint on the invites list update").toBe(1);
    expect(qrImages(view).length, "QR still shown").toBe(1);

    // Selecting the row it is already on changes nothing.
    await click(requireNewDeviceRow(view));
    expect(mints, "no mint on a re-click of the selected row").toBe(1);
    view.unmount();
  });

  it("mints a new link each time the row is selected again from elsewhere", async () => {
    answers = [URL_A, URL_B];
    const view = render(settings());
    await settle();
    await click(requireNewDeviceRow(view));
    expect(mints).toBe(1);
    await click(row(view, t("settings.sidebar.signInLinks"))!);
    expect(qrImages(view).length, "no QR on Sign-in links").toBe(0);
    await click(requireNewDeviceRow(view));
    expect(mints, "a second mint on coming back").toBe(2);
    const imgs = qrImages(view);
    expect(imgs.length).toBe(1);
    expect(encodes(imgs[0]!, URL_B), "the QR shows the new link").toBe(true);
    expect(encodes(imgs[0]!, URL_A), "not the replaced one").toBe(false);
    view.unmount();
  });
});

describe("the New device pane", () => {
  it("shows a pending line, then the error with a retry that mints again", async () => {
    let fail!: (err: Error) => void;
    answers = [
      new Promise<string>((_, reject) => {
        fail = reject;
      }),
      URL_A,
    ];
    const view = render(onLanguage(null, createElement(NewDevicePane), LISTS));
    await settle();
    expect(mints, "mints on mount").toBe(1);
    expect(
      view.queryAllByText(t("settings.devices.generating")).length,
      "pending line",
    ).toBe(1);
    expect(qrImages(view).length, "no QR while pending").toBe(0);

    const message = "Device link refused by the office";
    await act(async () => {
      fail(new ApiError(403, "forbidden", message));
    });
    await settle();
    expect(view.queryAllByText(message).length, "the error text").toBe(1);
    expect(qrImages(view).length, "no QR on error").toBe(0);
    expect(mints, "no automatic retry").toBe(1);
    const buttons = view.container.querySelectorAll("button");
    expect(buttons.length, "one button: retry").toBe(1);

    await click(buttons[0]!);
    expect(mints, "retry mints again").toBe(2);
    expect(view.queryAllByText(message).length, "error cleared").toBe(0);
    const imgs = qrImages(view);
    expect(imgs.length).toBe(1);
    expect(encodes(imgs[0]!, URL_A)).toBe(true);
    view.unmount();
  });
});

describe("Settings > You > Sign-in links", () => {
  it("lists links and sessions but offers no way to mint", async () => {
    const view = render(settings());
    await settle();
    await click(row(view, t("settings.sidebar.signInLinks"))!);
    expect(
      view.queryAllByText(t("settings.devices.outstandingLinks")).length,
      "outstanding links list",
    ).toBe(1);
    expect(
      view.queryAllByText(t("settings.devices.activeSessions")).length,
      "sessions list",
    ).toBe(1);
    // Every button in the pane (the lists are empty, so none of them is a
    // revoke): none mints.
    const pane = view
      .getByText(t("settings.devices.outstandingLinks"))
      .closest("div");
    if (!pane) throw new Error("no Sign-in links pane");
    for (const button of pane.querySelectorAll("button"))
      await click(button as HTMLElement);
    expect(mints, "nothing on Sign-in links mints").toBe(0);
    expect(qrImages(view).length).toBe(0);
    view.unmount();
  });
});

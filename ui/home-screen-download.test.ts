// homeScreenDownload (ui/home-screen-download.ts, task f8d05b49). On an iPhone
// Home Screen office a download link opened the iOS file preview with no way
// back. There the click now fetches the file and opens the share sheet; every
// other browser keeps the link's own download.
//
// Pins: only the iOS Home Screen office takes over the link, and it prevents
// the navigation before anything else; the shared file keeps the member-facing
// name and the response type; a lost gesture (NotAllowedError) leaves the file
// cached, so the next tap shares at once, with no await before share(); a tap
// during the fetch starts nothing new; the cache serves only its own link; a
// failed fetch does not stick; and no failure escapes as a throw or an
// unhandled rejection (bun fails the test on one).

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  homeScreenDownload,
  resetHomeScreenDownloadCache,
  type HomeScreenDownloadDeps,
} from "./home-screen-download.ts";
import type { SafariEnv } from "./safari-link.ts";

const HOME_SCREEN: SafariEnv = { ios: true, standalone: true, iosMajor: 17 };
const URL_A = "/api/files/agent-1/shot_1.png";
const URL_B = "/api/files/agent-1/report_v2.pdf";
const NAME = "Screen shot 截图 #1.png";
const BYTES = "PNG bytes";

type ShareStep = "ok" | "AbortError" | "NotAllowedError" | "InvalidStateError";
type FetchStep = "ok" | "404" | "network";

// One office tab: a fetch and a share sheet that play the scripted steps in
// order ("ok" when the script runs out), and record each call.
function rig(
  script: {
    fetch?: FetchStep[];
    share?: ShareStep[];
    canShare?: "yes" | "no" | "throws";
    env?: SafariEnv;
  } = {},
) {
  const fetches: string[] = [];
  const shares: ShareData[] = [];
  const fetchSteps = [...(script.fetch ?? [])];
  const shareSteps = [...(script.share ?? [])];
  const deps: HomeScreenDownloadDeps = {
    env: script.env ?? HOME_SCREEN,
    fetch: async (url) => {
      fetches.push(url);
      const step = fetchSteps.shift() ?? "ok";
      if (step === "network") throw new TypeError("Load failed");
      if (step === "404") return new Response("missing", { status: 404 });
      return new Response(BYTES, { headers: { "Content-Type": "image/png" } });
    },
    share: async (data) => {
      shares.push(data);
      const step = shareSteps.shift() ?? "ok";
      if (step !== "ok") throw new DOMException("share failed", step);
    },
    canShare: () => {
      if (script.canShare === "throws") throw new TypeError("bad shape");
      return script.canShare !== "no";
    },
  };
  return { deps, fetches, shares };
}

function tap(
  url: string,
  deps: HomeScreenDownloadDeps,
  name = NAME,
): { prevented: boolean } {
  const result = { prevented: false };
  homeScreenDownload(
    {
      preventDefault() {
        result.prevented = true;
      },
    },
    url,
    name,
    deps,
  );
  return result;
}

// Lets the fetch, the blob read and the share settle.
async function settle() {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
}

function sharedFile(data: ShareData | undefined): File {
  expect(data?.files).toHaveLength(1);
  return data!.files![0];
}

let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  resetHomeScreenDownloadCache();
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe("homeScreenDownload", () => {
  for (const [label, env, takesOver] of [
    ["the iPhone Home Screen office", HOME_SCREEN, true],
    ["iPhone Safari", { ...HOME_SCREEN, standalone: false }, false],
    [
      "a desktop or Android browser",
      { ios: false, standalone: false, iosMajor: null },
      false,
    ],
    // A desktop PWA is standalone but not iOS: its downloads work.
    [
      "a standalone app off iOS",
      { ios: false, standalone: true, iosMajor: null },
      false,
    ],
  ] as const) {
    it(`${label}: ${takesOver ? "the click is prevented and the share sheet opens" : "the link downloads as usual"}`, async () => {
      const { deps, fetches, shares } = rig({ env });
      const click = tap(URL_A, deps);
      // Synchronous: the browser acts on the click when the handler returns.
      expect(click.prevented).toBe(takesOver);
      await settle();
      expect(fetches).toEqual(takesOver ? [URL_A] : []);
      expect(shares).toHaveLength(takesOver ? 1 : 0);
    });
  }

  it("shares one file under the member-facing name, with the response's type and bytes", async () => {
    // Bun's File takes a lone Blob part's type when it is given none; WebKit,
    // as the File API says, leaves it empty. Use the WebKit rule here.
    const BunFile = globalThis.File;
    globalThis.File = class extends BunFile {
      constructor(parts: BlobPart[], name: string, options?: FilePropertyBag) {
        super(parts, name, { ...options, type: options?.type ?? "" });
      }
    };
    const { deps, shares } = rig();
    try {
      tap(URL_A, deps);
      await settle();
    } finally {
      globalThis.File = BunFile;
    }
    expect(shares).toHaveLength(1);
    const file = sharedFile(shares[0]);
    expect(file.name).toBe(NAME);
    // The type makes iOS offer Save Image for an image.
    expect(file.type).toBe("image/png");
    expect(await file.text()).toBe(BYTES);
  });

  it("a lost gesture: the next tap shares the cached file at once, with no second fetch", async () => {
    const { deps, fetches, shares } = rig({ share: ["NotAllowedError"] });
    tap(URL_A, deps);
    await settle();
    expect(shares).toHaveLength(1);
    expect(warn).toHaveBeenCalled();

    const second = tap(URL_A, deps);
    expect(second.prevented).toBe(true);
    // No await between the tap and share(): iOS needs the gesture for it.
    expect(shares).toHaveLength(2);
    expect(sharedFile(shares[1])).toBe(sharedFile(shares[0]));
    await settle();
    expect(fetches).toEqual([URL_A]);
  });

  it("a tap while the file is still loading starts no second fetch and no second sheet", async () => {
    const { deps, fetches, shares } = rig();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchOnce = deps.fetch!;
    const slow: HomeScreenDownloadDeps = {
      ...deps,
      fetch: async (url) => {
        const res = await fetchOnce(url);
        await gate;
        return res;
      },
    };
    const first = tap(URL_A, slow);
    await settle();
    const second = tap(URL_A, slow);
    // Both clicks stay in the office.
    expect([first.prevented, second.prevented]).toEqual([true, true]);
    release();
    await settle();
    expect(fetches).toEqual([URL_A]);
    expect(shares).toHaveLength(1);
  });

  it("the cached file serves only its own link: another link fetches and shares its own file", async () => {
    const { deps, fetches, shares } = rig();
    tap(URL_A, deps);
    await settle();
    tap(URL_B, deps, "Report v2 (final).pdf");
    await settle();
    expect(fetches).toEqual([URL_A, URL_B]);
    expect(shares.map((s) => sharedFile(s).name)).toEqual([
      NAME,
      "Report v2 (final).pdf",
    ]);
  });

  for (const failure of ["404", "network"] as const) {
    it(`a failed fetch (${failure}) does not stick: the next tap fetches again and shares`, async () => {
      const { deps, fetches, shares } = rig({ fetch: [failure] });
      tap(URL_A, deps);
      await settle();
      expect(shares).toHaveLength(0);
      tap(URL_A, deps);
      await settle();
      expect(fetches).toEqual([URL_A, URL_A]);
      expect(shares).toHaveLength(1);
      expect(sharedFile(shares[0]).name).toBe(NAME);
    });
  }

  // Each failure ends at a known step, with a warning except when the member
  // closed the sheet. The call never throws, and nothing rejects unhandled.
  for (const c of [
    {
      label: "the member closes the sheet",
      script: { share: ["AbortError"] },
      fetched: 1,
      shareCalls: 1,
      warns: false,
    },
    {
      label: "the gesture is gone",
      script: { share: ["NotAllowedError"] },
      fetched: 1,
      shareCalls: 1,
      warns: true,
    },
    {
      label: "a sheet is already open",
      script: { share: ["InvalidStateError"] },
      fetched: 1,
      shareCalls: 1,
      warns: true,
    },
    {
      label: "the fetch answers 404",
      script: { fetch: ["404"] },
      fetched: 1,
      shareCalls: 0,
      warns: true,
    },
    {
      label: "the network fails",
      script: { fetch: ["network"] },
      fetched: 1,
      shareCalls: 0,
      warns: true,
    },
    {
      label: "canShare refuses the file",
      script: { canShare: "no" },
      fetched: 1,
      shareCalls: 0,
      warns: true,
    },
    {
      label: "canShare throws",
      script: { canShare: "throws" },
      fetched: 1,
      shareCalls: 0,
      warns: true,
    },
  ] as const) {
    it(`${c.label}: the member stays in the office and nothing escapes`, async () => {
      const { deps, fetches, shares } = rig(
        c.script as Parameters<typeof rig>[0],
      );
      // A throw here fails the test.
      const click = tap(URL_A, deps);
      expect(click.prevented).toBe(true);
      await settle();
      expect(fetches).toHaveLength(c.fetched);
      expect(shares).toHaveLength(c.shareCalls);
      if (c.warns) expect(warn).toHaveBeenCalled();
      else expect(warn).not.toHaveBeenCalled();
    });
  }

  it("no share API: the click is still prevented, nothing is fetched, a warning is logged", async () => {
    const { deps, fetches } = rig();
    const click = tap(URL_A, { ...deps, share: null, canShare: null });
    expect(click.prevented).toBe(true);
    await settle();
    expect(fetches).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

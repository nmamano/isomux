import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const layout = readFileSync(
  new URL("./web/app/layout.tsx", import.meta.url),
  "utf8",
);
const bootstrap = layout.match(/const analyticsBootstrap = `([\s\S]*?)`;/)?.[1];

type GtagCall = IArguments;

function run(pathname: string, hostname = "cloud.isomux.com") {
  if (bootstrap === undefined) throw new Error("analytics bootstrap not found");

  const dataLayer: GtagCall[] = [];
  const tags: Array<{ async?: boolean; src?: string }> = [];
  const window = { dataLayer };
  const document = {
    createElement: () => ({}),
    head: {
      appendChild: (tag: { async?: boolean; src?: string }) => tags.push(tag),
    },
  };

  runInNewContext(bootstrap, {
    location: {
      hostname,
      pathname,
      search: "?name=private&error=private",
    },
    window,
    document,
  });

  return { calls: dataLayer.map((args) => Array.from(args)), tags };
}

describe("hosted analytics", () => {
  test("reports one sanitized signup page view", () => {
    const { calls, tags } = run("/signup");

    expect(calls).toHaveLength(3);
    expect(calls[1]).toEqual([
      "config",
      "G-6QKGF1LV4X",
      {
        anonymize_ip: true,
        allow_google_signals: false,
        allow_ad_personalization_signals: false,
        send_page_view: false,
      },
    ]);
    expect(calls[2]).toEqual([
      "event",
      "page_view",
      {
        page_location: "https://cloud.isomux.com/signup",
        page_referrer: "",
      },
    ]);
    expect(tags).toEqual([
      {
        async: true,
        src: "https://www.googletagmanager.com/gtag/js?id=G-6QKGF1LV4X",
      },
    ]);
  });

  test.each(["/", "/signin", "/office/acme", "/ops/instance-1"])(
    "does not initialize analytics on %s",
    (pathname) => {
      expect(run(pathname)).toEqual({ calls: [], tags: [] });
    },
  );

  test("does not initialize analytics outside the production host", () => {
    expect(run("/signup", "preview.example.com")).toEqual({
      calls: [],
      tags: [],
    });
  });
});

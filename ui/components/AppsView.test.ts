// The Apps tab's pure decisions: which section an app sits in, what its
// thumbnail does, what its menu offers, and the response-landing rule for the
// log dialog (click `log` on A, then on B before A answers, and A's journal
// must not appear under B). The rendered wiring is pinned by the
// AppsView.*.dom tests.
//
// Pure T0: no DOM, no server, no LLM.

import { describe, it, expect } from "bun:test";
import { DEMO_FEATURES, PRODUCTION_FEATURES } from "../../shared/features.ts";
import {
  appLinkHref,
  appHref,
  appMenuActions,
  appSection,
  appThumbnailSrc,
  filterApps,
  nextPollDelay,
  resolveCreatorAgentId,
  shouldCommit,
  thumbnailVerb,
} from "./AppsView.tsx";
import type { AppState } from "../../shared/types.ts";

const STATES: AppState[] = [
  "running",
  "starting",
  "stopped",
  "failed",
  "unknown",
];

describe("appSection", () => {
  it("puts a running or starting app in Running, archived or not", () => {
    for (const state of ["running", "starting"] as const) {
      expect(appSection({ state })).toBe("running");
      expect(appSection({ state, archived: true })).toBe("running");
    }
  });

  it("puts every other state in Stopped, or Archived when a member archived it", () => {
    for (const state of ["stopped", "failed", "unknown"] as const) {
      expect(appSection({ state })).toBe("stopped");
      expect(appSection({ state, archived: true })).toBe("archived");
    }
  });
});

describe("appThumbnailSrc", () => {
  it("names the upload version in the URL, so a new upload is a new URL", () => {
    expect(
      appThumbnailSrc({ name: "standup board", thumbnailUpdatedAt: 42 }),
    ).toBe("/api/apps/standup%20board/thumbnail?v=42");
  });

  it("has no URL for an app with no thumbnail", () => {
    expect(appThumbnailSrc({ name: "alpha" })).toBeNull();
  });
});

describe("thumbnailVerb", () => {
  it("starts a stopped app and restarts a failed or unknown one", () => {
    expect(thumbnailVerb({ state: "stopped", canManage: true })).toBe("start");
    expect(thumbnailVerb({ state: "failed", canManage: true })).toBe("restart");
    expect(thumbnailVerb({ state: "unknown", canManage: true })).toBe(
      "restart",
    );
  });

  it("gives a running app no verb, since its thumbnail opens it", () => {
    for (const state of ["running", "starting"] as const) {
      expect(thumbnailVerb({ state, canManage: true })).toBeNull();
    }
  });

  it("gives a member who cannot manage the app no verb at all", () => {
    for (const state of STATES) {
      expect(thumbnailVerb({ state, canManage: false })).toBeNull();
    }
  });
});

describe("appMenuActions", () => {
  it("offers Archive only in Stopped and Unarchive only in Archived", () => {
    for (const state of STATES) {
      for (const archived of [false, true]) {
        const actions = appMenuActions({ state, archived });
        const section = appSection({ state, archived });
        expect(actions.includes("archive")).toBe(section === "stopped");
        expect(actions.includes("unarchive")).toBe(section === "archived");
        expect(actions).toContain("log");
        expect(actions.at(-1)).toBe("delete");
      }
    }
  });

  it("leaves out a verb that cannot change the app's state", () => {
    expect(appMenuActions({ state: "running" })).not.toContain("start");
    expect(appMenuActions({ state: "stopped" })).toEqual([
      "start",
      "log",
      "archive",
      "delete",
    ]);
    expect(appMenuActions({ state: "failed" })).not.toContain("stop");
  });
});

describe("filterApps", () => {
  const apps = [{ userId: "u1" }, { userId: "u2" }, { userId: null }];

  it("keeps only the member's own apps when Only mine is on", () => {
    expect(filterApps(apps, true, "u1")).toEqual([{ userId: "u1" }]);
    expect(filterApps(apps, false, "u1")).toEqual(apps);
  });

  it("lets everything through without a session", () => {
    expect(filterApps(apps, true, null)).toEqual(apps);
  });
});

describe("shouldCommit", () => {
  it("lets a response land under the row that asked for it", () => {
    expect(shouldCommit(1, 1, "alpha", "alpha")).toBe(true);
  });

  it("refuses A's response once B has been opened", () => {
    // A issued at gen 1; opening B bumped the generation AND moved the target.
    expect(shouldCommit(1, 2, "alpha", "beta")).toBe(false);
  });

  it("refuses a response whose row is no longer the open one", () => {
    // Belt and braces: even if a generation were somehow reused, the target
    // check alone still keeps A's journal out of B's pane.
    expect(shouldCommit(1, 1, "alpha", "beta")).toBe(false);
  });

  it("refuses a response that comes back after the pane was closed", () => {
    // Closing bumps the generation and clears the target, so a late answer
    // cannot populate the pane a LATER row opens.
    expect(shouldCommit(1, 2, "alpha", null)).toBe(false);
  });

  it("refuses a response for a row that was reopened as a new request", () => {
    // Same row, clicked twice: only the newest request may write.
    expect(shouldCommit(1, 3, "alpha", "alpha")).toBe(false);
    expect(shouldCommit(3, 3, "alpha", "alpha")).toBe(true);
  });

  it("refuses everything once nothing is open (unmount, delete)", () => {
    expect(shouldCommit(4, 4, "alpha", null)).toBe(false);
  });
});

describe("nextPollDelay", () => {
  it("waits a full interval after a snapshot that landed", () => {
    expect(nextPollDelay(false, true)).toBe(5000);
  });

  it("comes straight back when a delta overtook the snapshot", () => {
    // The reducer refused it, so the list is short until something replaces it.
    expect(nextPollDelay(false, false)).toBe(0);
  });

  it("STOPS once its loop is cancelled, whatever the outcome was", () => {
    // The blocker this exists for: a rehydrate replaces the polling effect, and
    // an outgoing loop that rescheduled itself here would poll forever
    // alongside the new one - one extra loop per reconnect.
    expect(nextPollDelay(true, true)).toBeNull();
    expect(nextPollDelay(true, false)).toBeNull();
  });
});

describe("resolveCreatorAgentId", () => {
  const agents = [
    { id: "agent-1", name: "Isomuxer2" },
    { id: "agent-2", name: "AppBot" },
  ];

  it("opens the agent the record names by id", () => {
    expect(
      resolveCreatorAgentId(
        { createdBy: "Isomuxer2", createdByAgentId: "agent-1" },
        agents,
      ),
    ).toBe("agent-1");
  });

  it("falls back to the name when the record carries no id", () => {
    // Every app registered before the id was stored, and every human one.
    expect(resolveCreatorAgentId({ createdBy: "AppBot" }, agents)).toBe(
      "agent-2",
    );
  });

  it("matches a name whatever its case", () => {
    expect(resolveCreatorAgentId({ createdBy: "appbot" }, agents)).toBe(
      "agent-2",
    );
  });

  it("gives nothing to open when the recorded agent is gone", () => {
    // A killed agent whose nameplate a successor now holds. Opening the
    // successor would present it as the agent that registered the app, which
    // it is not - the same reason the app-to-agent message route answers a
    // gone target with `target_gone` rather than picking another agent.
    expect(
      resolveCreatorAgentId(
        { createdBy: "AppBot", createdByAgentId: "agent-dead" },
        agents,
      ),
    ).toBeNull();
  });

  it("gives nothing to open for an actor that is not an agent", () => {
    // A human registration, or the admin CLI: `created by` stays plain text.
    expect(resolveCreatorAgentId({ createdBy: "Nil" }, agents)).toBeNull();
    expect(
      resolveCreatorAgentId({ createdBy: "(admin-cli)" }, agents),
    ).toBeNull();
  });

  it("gives nothing to open when the office has no agents at all", () => {
    expect(resolveCreatorAgentId({ createdBy: "AppBot" }, [])).toBeNull();
  });
});

describe("appHref", () => {
  it("uses the app's own URL verbatim when it has one", () => {
    // The office computes the URL from its public origin and the app's issued
    // label; the UI must not rebuild any part of it. The hostname passed in is
    // deliberately unrelated, so a href that borrows from it fails here.
    expect(
      appHref(
        { url: "https://standup-board.office.example", port: 21000 },
        "auntie",
      ),
    ).toBe("https://standup-board.office.example");
  });

  it("keeps the port link when the office has no app hostnames", () => {
    expect(appHref({ port: 21000 }, "auntie")).toBe("http://auntie:21000/");
  });

  it("keeps the port link for an empty URL rather than linking to nowhere", () => {
    // The wire omits `url` instead of sending "", so this is the fail-safe: an
    // empty href resolves to the office page the row is already on.
    expect(appHref({ url: "", port: 21000 }, "auntie")).toBe(
      "http://auntie:21000/",
    );
  });

  it("shortens a tailnet office to the node name", () => {
    // The bug this exists for: the browser upgrades http://<long tailnet
    // name>:<port> to https and the plain-http app port is unreachable. The
    // node's short name has no https history and MagicDNS resolves it.
    expect(appHref({ port: 21001 }, "auntie.parrot-fish.ts.net")).toBe(
      "http://auntie:21001/",
    );
  });

  it("shortens a tailnet name whatever its case", () => {
    expect(appHref({ port: 21001 }, "Auntie.Parrot-Fish.TS.NET")).toBe(
      "http://auntie:21001/",
    );
  });

  it("shortens a tailnet name written with the trailing root dot", () => {
    expect(appHref({ port: 21001 }, "auntie.parrot-fish.ts.net.")).toBe(
      "http://auntie:21001/",
    );
  });

  it("leaves a tailnet office's own URL alone", () => {
    // The office answers with the URL; the tailnet branch belongs to the port
    // link only and must not touch a hostname the office issued.
    expect(
      appHref(
        { url: "https://standup-board.office.example", port: 21001 },
        "auntie.parrot-fish.ts.net",
      ),
    ).toBe("https://standup-board.office.example");
  });

  it("passes an ordinary domain through unchanged", () => {
    expect(appHref({ port: 21000 }, "office.example.com")).toBe(
      "http://office.example.com:21000/",
    );
  });

  it("matches the tailnet suffix on the label boundary", () => {
    // `ts.net` inside a name is not the MagicDNS namespace, and shortening
    // either of these would link the row at a host that resolves nowhere.
    expect(appHref({ port: 21000 }, "myts.net")).toBe("http://myts.net:21000/");
    expect(appHref({ port: 21000 }, "ts.net.example.com")).toBe(
      "http://ts.net.example.com:21000/",
    );
  });

  it("leaves the bare tailnet apex unchanged", () => {
    // No node label to shorten to. Unlike server/app-domain.ts, which counts
    // the apex as tailnet to refuse deriving app hostnames under it.
    expect(appHref({ port: 21000 }, "ts.net")).toBe("http://ts.net:21000/");
  });

  it("leaves a hostname that is nothing but the suffix unchanged", () => {
    // Guards the empty-first-label fallback: without it the href would be
    // `http://:21000/`.
    expect(appHref({ port: 21000 }, ".ts.net")).toBe("http://.ts.net:21000/");
  });
});

describe("appLinkHref", () => {
  const app = {
    name: "standup board",
    url: "https://standup-board.office.example",
    port: 21000,
  };

  it("opens a standalone fixture page for synthetic demo previews", () => {
    expect(appLinkHref(app, "isomux.com", DEMO_FEATURES.liveAppPreviews)).toBe(
      "/demo/app?name=standup%20board",
    );
  });

  it("never produces a demo URL with production features", () => {
    expect(
      appLinkHref(app, "office.example", PRODUCTION_FEATURES.liveAppPreviews),
    ).toBe(appHref(app, "office.example"));
    expect(
      appLinkHref(app, "office.example", PRODUCTION_FEATURES.liveAppPreviews),
    ).not.toStartWith("/demo/");
  });
});

describe("app short links", () => {
  it("prefers the short address for app links and keeps the demo route", () => {
    const app = { name: "board", port: 21000, url: "https://board.office.example", shortUrl: "https://office.example/board" };
    expect(appHref(app, "ignored.example")).toBe(app.shortUrl);
    expect(appLinkHref(app, "ignored.example", true)).toBe(app.shortUrl);
    expect(appLinkHref(app, "ignored.example", false)).toBe("/demo/app?name=board");
    expect(appHref({ ...app, shortUrl: undefined }, "ignored.example")).toBe(app.url);
    expect(appHref({ ...app, shortUrl: "" }, "ignored.example")).toBe(app.url);
  });
});

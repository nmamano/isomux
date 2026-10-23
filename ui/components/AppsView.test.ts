// The Apps tab's pure decisions: which section an app sits in, what its
// thumbnail does, what its menu offers, and the response-landing rule for the
// log dialog (click `log` on A, then on B before A answers, and A's journal
// must not appear under B). The rendered wiring is pinned by the
// AppsView.*.dom tests.
//
// Pure T0: no DOM, no server, no LLM.

import { describe, it, expect } from "bun:test";
import { DEMO_FEATURES } from "../../shared/features.ts";
import {
  appLinkHref,
  appHref,
  appMenuActions,
  appSection,
  nextPollDelay,
  resolveCreatorAgentId,
  shouldCommit,
  thumbnailVerb,
} from "./AppsView.tsx";
import type { AppState } from "../../shared/types.ts";

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

describe("thumbnailVerb", () => {
  it("starts a stopped app and restarts a failed or unknown one", () => {
    expect(thumbnailVerb({ state: "stopped", canManage: true })).toBe("start");
    expect(thumbnailVerb({ state: "failed", canManage: true })).toBe("restart");
    expect(thumbnailVerb({ state: "unknown", canManage: true })).toBe(
      "restart",
    );
  });
});

describe("appMenuActions", () => {
  it("leaves out a verb that cannot change the state, and offers Archive only at rest and Unarchive only in Archived", () => {
    // A running app is never archived or unarchived; "unknown" keeps every verb
    // but Archive (the server archives only an app systemd reported at rest, so
    // it would only earn a 409), and a failed app keeps restart as its recovery
    // verb.
    type Actions = ReturnType<typeof appMenuActions>;
    const table: [AppState, Actions, Actions][] = [
      [
        "running",
        ["stop", "restart", "log", "delete"],
        ["stop", "restart", "log", "delete"],
      ],
      [
        "starting",
        ["stop", "restart", "log", "delete"],
        ["stop", "restart", "log", "delete"],
      ],
      [
        "stopped",
        ["start", "log", "archive", "delete"],
        ["start", "log", "unarchive", "delete"],
      ],
      [
        "failed",
        ["start", "restart", "log", "archive", "delete"],
        ["start", "restart", "log", "unarchive", "delete"],
      ],
      [
        "unknown",
        ["start", "stop", "restart", "log", "delete"],
        ["start", "stop", "restart", "log", "unarchive", "delete"],
      ],
    ];
    for (const [state, kept, archived] of table) {
      expect(appMenuActions({ state })).toEqual(kept);
      expect(appMenuActions({ state, archived: true })).toEqual(archived);
    }
  });
});

describe("shouldCommit", () => {
  it("lets a response land under the row that asked for it", () => {
    expect(shouldCommit(1, 1, "alpha", "alpha")).toBe(true);
  });

  it("refuses a response whose row is no longer the open one", () => {
    // Belt and braces: even if a generation were somehow reused, the target
    // check alone still keeps A's journal out of B's pane.
    expect(shouldCommit(1, 1, "alpha", "beta")).toBe(false);
  });

  it("refuses a response for a row that was reopened as a new request", () => {
    // Same row, clicked twice: only the newest request may write.
    expect(shouldCommit(1, 3, "alpha", "alpha")).toBe(false);
    expect(shouldCommit(3, 3, "alpha", "alpha")).toBe(true);
  });
});

describe("nextPollDelay", () => {
  it("waits a full interval after a snapshot that landed", () => {
    // The interval itself is tuning; the contract is a real wait, not 0.
    expect(nextPollDelay(false, true)).toBeGreaterThan(0);
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
});

describe("appHref", () => {
  it("keeps the port link for an empty URL rather than linking to nowhere", () => {
    // The wire omits `url` instead of sending "", so this is the fail-safe: an
    // empty href resolves to the office page the row is already on. An empty
    // short address falls through the same way, to the URL.
    expect(appHref({ url: "", port: 21000 }, "auntie")).toBe(
      "http://auntie:21000/",
    );
    expect(
      appHref(
        {
          shortUrl: "",
          url: "https://board.office.example",
          port: 21000,
        },
        "auntie",
      ),
    ).toBe("https://board.office.example");
  });

  it("shortens a tailnet office to the node name", () => {
    // The bug this exists for: the browser upgrades http://<long tailnet
    // name>:<port> to https and the plain-http app port is unreachable. The
    // node's short name has no https history and MagicDNS resolves it.
    expect(appHref({ port: 21001 }, "auntie.parrot-fish.ts.net")).toBe(
      "http://auntie:21001/",
    );
    // Whatever its case, and written with the trailing root dot.
    expect(appHref({ port: 21001 }, "Auntie.Parrot-Fish.TS.NET")).toBe(
      "http://auntie:21001/",
    );
    expect(appHref({ port: 21001 }, "auntie.parrot-fish.ts.net.")).toBe(
      "http://auntie:21001/",
    );
  });

  it("matches the tailnet suffix on the label boundary", () => {
    // `ts.net` inside a name is not the MagicDNS namespace, and shortening
    // either of these would link the row at a host that resolves nowhere.
    expect(appHref({ port: 21000 }, "myts.net")).toBe("http://myts.net:21000/");
    expect(appHref({ port: 21000 }, "ts.net.example.com")).toBe(
      "http://ts.net.example.com:21000/",
    );
    // The bare apex has no node label to shorten to. Unlike
    // server/app-domain.ts, which counts the apex as tailnet to refuse deriving
    // app hostnames under it.
    expect(appHref({ port: 21000 }, "ts.net")).toBe("http://ts.net:21000/");
  });

  it("leaves a hostname that is nothing but the suffix unchanged", () => {
    // Guards the empty-first-label fallback: without it the href would be
    // `http://:21000/`.
    expect(appHref({ port: 21000 }, ".ts.net")).toBe("http://.ts.net:21000/");
  });
});

describe("appLinkHref", () => {
  // The production destinations (short link, URL, port) are pinned by
  // AppsView.links.dom.test.tsx.
  const app = {
    name: "standup board",
    url: "https://standup-board.office.example",
    shortUrl: "https://office.example/standup-board",
    port: 21000,
  };

  it("opens a standalone fixture page for synthetic demo previews, even over a short link", () => {
    expect(appLinkHref(app, "isomux.com", DEMO_FEATURES.liveAppPreviews)).toBe(
      "/demo/app?name=standup%20board",
    );
  });
});

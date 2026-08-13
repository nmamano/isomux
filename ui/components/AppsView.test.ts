// The Apps tab's response-landing rule. Two shared panes - the log pane and its
// error - are written by requests that can outlive what asked for them, and the
// UI has no React render harness (see EditAgentDialog.test.ts), so the decision
// is extracted and covered here.
//
// The bug it exists to prevent: click `log` on A, click `log` on B before A
// answers, and A's journal appears under B's row.
//
// Pure T0: no DOM, no server, no LLM.

import { describe, it, expect } from "bun:test";
import {
  appHref,
  appLinkLabel,
  nextPollDelay,
  resolveCreatorAgentId,
  shouldCommit,
} from "./AppsView.tsx";

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

describe("appLinkLabel", () => {
  it("a public app gets a plain action instead of making its name a URL claim", () => {
    expect(appLinkLabel({ url: "https://hello.office.example" })).toBe(
      "Open app",
    );
  });

  it("a port fallback says it is limited to the current network", () => {
    expect(appLinkLabel({})).toBe("Open on this network");
    expect(appLinkLabel({ url: "" })).toBe("Open on this network");
  });
});

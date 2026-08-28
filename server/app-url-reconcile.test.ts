// Boot URL reconciliation: does every app's unit declare the address the
// office would give it today, and does getting there disturb as little as
// possible?
//
// The pass has two dangerous directions and this file pushes on both:
//   - too eager - restarting apps that were at rest, or rewriting units that
//     were already right, which would bounce every app on every boot;
//   - too quiet - deciding an app is fine when it is not, which is permanent,
//     because nothing is persisted and the unit itself is the only evidence
//     the next boot has.
//
// A fake world stands in for systemd: unit text per app, a state per app, and
// a call log. No subprocesses, no files.

import { describe, it, expect } from "bun:test";
import {
  reconcileAppUrls,
  type AppUrlReconcileDeps,
} from "./app-url-reconcile.ts";
import {
  appHostEnvDirective,
  appHostForUrl,
  appUrlEnvDirective,
} from "./app-supervisor.ts";
import { appPublicUrl, deriveAppHostDomain } from "./app-domain.ts";
import type { AppRecord, AppState } from "../shared/types.ts";

const DOMAIN = "office.example";
// This office's own tailnet name, the one the regression happened on.
const TAILNET_HOST = "auntie.parrot-fish.ts.net";
const TAILNET_ORIGIN = `https://${TAILNET_HOST}`;

const record = (over: Partial<AppRecord> = {}): AppRecord => ({
  name: "hello",
  hostLabel: "hello",
  hostGen: 1,
  port: 21000,
  command: "bun run serve.ts",
  cwd: "/srv/hello",
  dataDir: "/state/apps/data/hello",
  userId: "u1",
  username: "Alice",
  createdBy: "AppBot",
  createdAt: 1,
  ...over,
});

// A unit as the supervisor would have written it under `domain` - the only
// part of one this pass looks at, built through the production directive
// builder so the fixture cannot drift from what the renderer emits.
const unitFor = (app: AppRecord, domain: string | null): string => {
  const url = appPublicUrl(app.hostLabel, domain);
  const host = appHostForUrl(url);
  const lines = ["[Service]", `Environment="PORT=${app.port}"`];
  if (url !== null && host !== null)
    lines.push(appUrlEnvDirective(url), appHostEnvDirective(host));
  return `${lines.join("\n")}\n`;
};

interface World {
  apps: AppRecord[];
  // The office's domain NOW. The units start out written under whatever the
  // test says they were written under, which is how drift is constructed.
  domain: string | null;
  units: Map<string, string>;
  states: Map<string, AppState>;
  calls: string[];
  failRegenerate: Set<string>;
  failRestart: Set<string>;
  failRestore: Set<string>;
  failStates: boolean;
  deps: AppUrlReconcileDeps;
}

function world(over: Partial<Omit<World, "deps">> = {}): World {
  const w: World = {
    apps: [record()],
    domain: DOMAIN,
    units: new Map(),
    states: new Map(),
    calls: [],
    failRegenerate: new Set(),
    failRestart: new Set(),
    failRestore: new Set(),
    failStates: false,
    deps: null as unknown as AppUrlReconcileDeps,
    ...over,
  };
  w.deps = {
    list: () => w.apps,
    expectedUrl: (app) => appPublicUrl(app.hostLabel, w.domain),
    // Reads are not logged: the pass reads every app's unit on every boot, and
    // a test asserting "nothing happened" means no WRITES and no restarts.
    readUnitFile: (name) => w.units.get(name) ?? null,
    restoreUnitFile: (name, contents) => {
      w.calls.push(`restore:${name}`);
      if (w.failRestore.has(name)) throw new Error("read-only filesystem");
      w.units.set(name, contents);
    },
    regenerate: (app) => {
      w.calls.push(`regenerate:${app.name}`);
      if (w.failRegenerate.has(app.name)) throw new Error("cannot write unit");
      w.units.set(app.name, unitFor(app, w.domain));
    },
    states: (names) => {
      if (w.failStates) throw new Error("systemctl is not answering");
      return new Map(
        names.map((n) => [
          n,
          { state: w.states.get(n) ?? "unknown", restartCount: 0 },
        ]),
      );
    },
    restart: (name) => {
      w.calls.push(`restart:${name}`);
      if (w.failRestart.has(name)) throw new Error("unit failed to start");
    },
  };
  return w;
}

// The common setup: one running app whose unit was written under `wrote` while
// the office now says `domain`.
const oneApp = (opts: {
  wrote: string | null;
  domain: string | null;
  state?: AppState;
  app?: AppRecord;
}): World => {
  const app = opts.app ?? record();
  const w = world({ apps: [app], domain: opts.domain });
  w.units.set(app.name, unitFor(app, opts.wrote));
  w.states.set(app.name, opts.state ?? "running");
  return w;
};

describe("app-urls: convergence", () => {
  it("gives a running app its new address and restarts it once", () => {
    // The transition the slice exists for: an operator points a domain at the
    // office, and the apps that were already serving learn where they live.
    const w = oneApp({ wrote: null, domain: DOMAIN });
    const report = reconcileAppUrls(w.deps);

    expect(w.calls).toEqual(["regenerate:hello", "restart:hello"]);
    expect(w.units.get("hello")).toContain(
      'Environment="ISOMUX_APP_URL=https://hello.office.example"',
    );
    expect(report.converged).toEqual(["hello"]);
    expect(report.restarted).toEqual(["hello"]);
    expect(report.failed).toEqual([]);
  });

  it("takes the address away again when the office stops being reachable", () => {
    // The reverse: an office that went back to plain HTTP. The variable must
    // be GONE, not emptied, or every app keeps advertising a dead address.
    const w = oneApp({ wrote: DOMAIN, domain: null });
    reconcileAppUrls(w.deps);

    expect(w.calls).toEqual(["regenerate:hello", "restart:hello"]);
    expect(w.units.get("hello")).not.toContain("ISOMUX_APP_URL");
  });

  it("follows the domain when it changes", () => {
    const w = oneApp({ wrote: "old.example", domain: "new.example" });
    reconcileAppUrls(w.deps);
    expect(w.units.get("hello")).toContain(
      'Environment="ISOMUX_APP_URL=https://hello.new.example"',
    );
  });

  it("uses the app's LABEL, not its reusable name", () => {
    const app = record({ hostLabel: "hello-g2", hostGen: 2 });
    const w = oneApp({ wrote: null, domain: DOMAIN, app });
    reconcileAppUrls(w.deps);
    expect(w.units.get("hello")).toContain(
      'Environment="ISOMUX_APP_URL=https://hello-g2.office.example"',
    );
  });

  it("does NOTHING when every unit already says the right thing", () => {
    // Idempotence, which is the property that keeps a boot cheap: no rewrite,
    // no daemon-reload, no restart, on every boot after the first.
    const w = oneApp({ wrote: DOMAIN, domain: DOMAIN });
    const report = reconcileAppUrls(w.deps);
    expect(w.calls).toEqual([]);
    expect(report.converged).toEqual([]);
    expect(report.restarted).toEqual([]);
  });

  it("does not disturb an existing app in an office without app hostnames", () => {
    const app = record();
    const w = oneApp({ wrote: null, domain: null });
    w.units.set(app.name, `[Service]\nEnvironment="PORT=${app.port}"\n`);

    const report = reconcileAppUrls(w.deps);

    expect(w.calls).toEqual([]);
    expect(report.converged).toEqual([]);
    expect(report.restarted).toEqual([]);
  });

  it("adds the loopback bind to an existing hostname app", () => {
    const app = record();
    const w = oneApp({ wrote: DOMAIN, domain: DOMAIN });
    w.units.set(
      app.name,
      `[Service]\nEnvironment="PORT=${app.port}"\n${appUrlEnvDirective(
        appPublicUrl(app.hostLabel, DOMAIN)!,
      )}\n`,
    );

    const report = reconcileAppUrls(w.deps);

    expect(w.calls).toEqual(["regenerate:hello"]);
    expect(w.units.get("hello")).toContain(
      'Environment="ISOMUX_APP_HOST=127.0.0.1"',
    );
    expect(report.converged).toEqual(["hello"]);
    expect(report.restarted).toEqual([]);
  });

  it("restarts a running app when its existing bind host changes", () => {
    const app = record();
    const w = oneApp({ wrote: DOMAIN, domain: DOMAIN });
    w.units.set(
      app.name,
      `${unitFor(app, DOMAIN).replace(
        appHostEnvDirective("127.0.0.1"),
        appHostEnvDirective("192.0.2.1"),
      )}`,
    );

    const report = reconcileAppUrls(w.deps);

    expect(w.calls).toEqual(["regenerate:hello", "restart:hello"]);
    expect(report.converged).toEqual(["hello"]);
    expect(report.restarted).toEqual(["hello"]);
  });

  it("restarts a running app when its URL and bind host both drift", () => {
    const app = record();
    const w = oneApp({ wrote: "old.example", domain: DOMAIN });
    w.units.set(
      app.name,
      `[Service]\nEnvironment="PORT=${app.port}"\n${appUrlEnvDirective(
        appPublicUrl(app.hostLabel, "old.example")!,
      )}\n`,
    );

    const report = reconcileAppUrls(w.deps);

    expect(w.calls).toEqual(["regenerate:hello", "restart:hello"]);
    expect(report.converged).toEqual(["hello"]);
    expect(report.restarted).toEqual(["hello"]);
  });

  it("does nothing on the SECOND pass after a real convergence", () => {
    // The same claim end to end: the first pass leaves the world in a state
    // the second pass recognises as finished.
    const w = oneApp({ wrote: null, domain: DOMAIN });
    reconcileAppUrls(w.deps);
    w.calls.length = 0;
    const second = reconcileAppUrls(w.deps);
    expect(w.calls).toEqual([]);
    expect(second.converged).toEqual([]);
  });

  it("treats an EMPTY assignment as drift, in both directions", () => {
    // `ISOMUX_APP_URL=` is not the same as no variable at all: an app testing
    // for it sees an empty string and believes it has no address... or worse,
    // builds a URL out of one. Both arms must rewrite.
    const emptyUnit = '[Service]\nEnvironment="ISOMUX_APP_URL="\n';

    const off = oneApp({ wrote: null, domain: null });
    off.units.set("hello", emptyUnit);
    reconcileAppUrls(off.deps);
    expect(off.calls).toContain("regenerate:hello");
    expect(off.units.get("hello")).not.toContain("ISOMUX_APP_URL");

    const on = oneApp({ wrote: null, domain: DOMAIN });
    on.units.set("hello", emptyUnit);
    reconcileAppUrls(on.deps);
    expect(on.units.get("hello")).toContain(
      'Environment="ISOMUX_APP_URL=https://hello.office.example"',
    );
  });

  it("takes back an address a tailnet office should never have given out", () => {
    // The live regression, end to end (2026-08-08). This office IS on HTTPS -
    // Tailscale Serve terminates TLS - so it derived a domain and wrote
    // `https://hello.auntie.parrot-fish.ts.net` into every app's unit. That
    // name resolves nowhere: MagicDNS has no wildcards. The domain comes from
    // the PRODUCTION derivation here rather than a literal null, so this test
    // is wired to the fix and not to a restatement of it: with the tailnet
    // guard gone the derivation answers with the host, the seeded unit already
    // agrees with it, and the pass below has nothing to do.
    const lying = deriveAppHostDomain(TAILNET_ORIGIN, true);
    expect(lying).toBeNull();

    const app = record();
    const w = world({ apps: [app], domain: lying });
    w.units.set(app.name, unitFor(app, TAILNET_HOST));
    w.states.set(app.name, "running");
    expect(w.units.get("hello")).toContain(
      'Environment="ISOMUX_APP_URL=https://hello.auntie.parrot-fish.ts.net"',
    );

    const report = reconcileAppUrls(w.deps);

    // The variable is GONE - not emptied - and the app that was serving is
    // restarted into the environment without it, exactly once.
    expect(w.units.get("hello")).not.toContain("ISOMUX_APP_URL");
    expect(w.calls).toEqual(["regenerate:hello", "restart:hello"]);
    expect(report.restarted).toEqual(["hello"]);
    expect(report.failed).toEqual([]);

    // And the next boot is free: the cleanup is a one-time transition, not a
    // bounce every app pays on every start.
    w.calls.length = 0;
    const second = reconcileAppUrls(w.deps);
    expect(w.calls).toEqual([]);
    expect(second.converged).toEqual([]);
  });

  it("judges by the LAST assignment when a unit has been hand-edited", () => {
    const app = record();
    const w = oneApp({ wrote: DOMAIN, domain: DOMAIN });
    // A correct line followed by an emptying one: systemd gives the app the
    // empty value, so this unit is drift even though it contains the right
    // string.
    w.units.set(
      app.name,
      `${unitFor(app, DOMAIN)}Environment="ISOMUX_APP_URL="\n`,
    );
    reconcileAppUrls(w.deps);
    expect(w.calls).toContain("regenerate:hello");
    expect(w.units.get("hello")).toBe(unitFor(app, DOMAIN));
  });
});

describe("app-urls: what it refuses to disturb", () => {
  it("leaves a stopped app stopped, with the new file waiting", () => {
    const w = oneApp({ wrote: null, domain: DOMAIN, state: "stopped" });
    const report = reconcileAppUrls(w.deps);
    expect(w.calls).toEqual(["regenerate:hello"]);
    expect(w.units.get("hello")).toContain("ISOMUX_APP_URL");
    expect(report.converged).toEqual(["hello"]);
    expect(report.restarted).toEqual([]);
  });

  it("leaves a failed app failed", () => {
    // An app that has come to rest in `failed` is where somebody has to look
    // at it. Starting it at boot would hide that and burn the start limit.
    const w = oneApp({ wrote: null, domain: DOMAIN, state: "failed" });
    reconcileAppUrls(w.deps);
    expect(w.calls).toEqual(["regenerate:hello"]);
  });

  it("restarts an app that was still starting up", () => {
    // `starting` is an activation somebody asked for: leaving it alone would
    // let it finish coming up on the address it is being moved off.
    const w = oneApp({ wrote: null, domain: DOMAIN, state: "starting" });
    reconcileAppUrls(w.deps);
    expect(w.calls).toEqual(["regenerate:hello", "restart:hello"]);
  });

  it("does not restart an app whose state it could not read", () => {
    // "systemd did not answer" is not "the app is running". The file still
    // converges; the app picks the address up whenever it next starts.
    const w = oneApp({ wrote: null, domain: DOMAIN });
    w.states.delete("hello"); // -> unknown
    reconcileAppUrls(w.deps);
    expect(w.calls).toEqual(["regenerate:hello"]);
  });

  it("converges without restarting anything when the state read itself fails", () => {
    const w = oneApp({ wrote: null, domain: DOMAIN });
    w.failStates = true;
    const report = reconcileAppUrls(w.deps);
    expect(w.calls).toEqual(["regenerate:hello"]);
    expect(report.restarted).toEqual([]);
  });

  it("skips an app with no unit file at all - and never creates or starts one", () => {
    // Registration installs units; the token pass ahead of this one repairs a
    // missing one. An app with no unit is one nobody asked this pass to bring
    // up, and starting it at boot would be a surprise.
    const w = oneApp({ wrote: null, domain: DOMAIN });
    w.units.delete("hello");
    const report = reconcileAppUrls(w.deps);
    expect(w.calls).toEqual([]);
    expect(report.noUnit).toEqual(["hello"]);
    expect(report.converged).toEqual([]);
  });
});

describe("app-urls: failure", () => {
  it("keeps going for the other apps when one cannot be rewritten", () => {
    const a = record({ name: "a", hostLabel: "a" });
    const b = record({ name: "b", hostLabel: "b" });
    const w = world({ apps: [a, b], domain: DOMAIN });
    w.units.set("a", unitFor(a, null));
    w.units.set("b", unitFor(b, null));
    w.states.set("a", "running");
    w.states.set("b", "running");
    w.failRegenerate.add("a");

    const report = reconcileAppUrls(w.deps);
    expect(report.failed).toEqual(["a"]);
    expect(report.converged).toEqual(["b"]);
    expect(w.calls).toEqual(["regenerate:a", "regenerate:b", "restart:b"]);
  });

  it("puts the previous unit back when the restart fails, so the drift stays visible", () => {
    // The one that cannot be papered over: nothing about this pass is
    // persisted, so an app whose unit was updated and whose restart failed
    // would look finished forever while its process holds the old
    // environment. Rolling the unit back is what keeps the next boot honest.
    const w = oneApp({ wrote: null, domain: DOMAIN });
    const before = w.units.get("hello")!;
    w.failRestart.add("hello");

    const report = reconcileAppUrls(w.deps);
    expect(w.calls).toEqual([
      "regenerate:hello",
      "restart:hello",
      "restore:hello",
    ]);
    expect(w.units.get("hello")).toBe(before);
    expect(report.failed).toEqual(["hello"]);
    expect(report.converged).toEqual([]);
    expect(report.stuck).toEqual([]);
  });

  it("retries on the next boot after a failed restart", () => {
    // The point of the rollback, stated as the behaviour it buys.
    const w = oneApp({ wrote: null, domain: DOMAIN });
    w.failRestart.add("hello");
    reconcileAppUrls(w.deps);

    w.calls.length = 0;
    w.failRestart.clear();
    const second = reconcileAppUrls(w.deps);
    expect(w.calls).toEqual(["regenerate:hello", "restart:hello"]);
    expect(second.converged).toEqual(["hello"]);
    expect(w.units.get("hello")).toContain("ISOMUX_APP_URL");
  });

  it("reports the app as stuck when the rollback fails too", () => {
    // Unit says one thing, running process another, and no later boot will
    // notice. It cannot be fixed here - only named, so it is not silent.
    const w = oneApp({ wrote: null, domain: DOMAIN });
    w.failRestart.add("hello");
    w.failRestore.add("hello");

    const report = reconcileAppUrls(w.deps);
    expect(report.stuck).toEqual(["hello"]);
    expect(report.failed).toEqual(["hello"]);
  });

  it("counts every app it looked at, including the ones it left alone", () => {
    const a = record({ name: "a", hostLabel: "a" });
    const b = record({ name: "b", hostLabel: "b" });
    const w = world({ apps: [a, b], domain: DOMAIN });
    w.units.set("a", unitFor(a, DOMAIN));
    const report = reconcileAppUrls(w.deps);
    expect(report.checked).toBe(2);
    expect(report.noUnit).toEqual(["b"]);
  });
});

// Where an app's public address comes from (phase 3): the hostname grammar,
// the office host apps hang off, and the URL an app is reachable at. Moved
// here with the module in slice 8; the Host-header side stayed in
// app-hosts.test.ts.
//
// Everything here is pure except the boot-frozen domain, whose only rule is a
// lifecycle one: it answers after the freeze and throws before it, because a
// lazy resolve would cache the pre-boot default and silently disable app
// hostnames on a deployment that has them.

import { describe, it, expect, afterAll } from "bun:test";
import {
  _testResetAppHostDomain,
  appHostDomain,
  appPublicUrl,
  deriveAppHostDomain,
  freezeAppHostDomain,
  isHostname,
} from "../app-domain.ts";

describe("isHostname", () => {
  it("counts labels for the minimum", () => {
    expect(isHostname("example")).toBe(true);
    expect(isHostname("example", 2)).toBe(false);
    expect(isHostname("a.example", 2)).toBe(true);
  });
});

describe("deriveAppHostDomain", () => {
  it("is the office host itself on an https deployment", () => {
    expect(deriveAppHostDomain("https://office.example", true)).toBe(
      "office.example",
    );
  });

  it("is null on plain HTTP - every dev box, byte-identical to before", () => {
    expect(deriveAppHostDomain("http://office.example", false)).toBeNull();
    // The flag decides, not the string: buildPublicOrigin is the one that
    // knows whether this deployment is really behind TLS.
    expect(deriveAppHostDomain("https://office.example", false)).toBeNull();
  });

  it("is null for loopback names", () => {
    for (const origin of [
      "https://localhost",
      "https://localhost:4000",
      "https://dev.localhost",
    ]) {
      expect(deriveAppHostDomain(origin, true)).toBeNull();
    }
  });

  it("is null for address literals", () => {
    for (const origin of [
      "https://127.0.0.1",
      "https://93.184.216.34",
      "https://[::1]",
    ]) {
      expect(deriveAppHostDomain(origin, true)).toBeNull();
    }
  });

  it("is null for a single-label office host", () => {
    // An intranet name cannot carry the public wildcard record apps need.
    expect(deriveAppHostDomain("https://office", true)).toBeNull();
  });

  it("is null for an unparseable origin", () => {
    expect(deriveAppHostDomain("not a url", true)).toBeNull();
    expect(deriveAppHostDomain("", true)).toBeNull();
  });

  it("canonicalizes case and a trailing dot", () => {
    // This value is compared against a normalized request Host on every
    // request, so a stray trailing dot here would divert the office itself.
    expect(deriveAppHostDomain("https://OFFICE.EXAMPLE./", true)).toBe(
      "office.example",
    );
  });

  it("keeps a port out of the domain", () => {
    expect(deriveAppHostDomain("https://office.example:8443", true)).toBe(
      "office.example",
    );
  });

  // A tailnet office is the one HTTPS deployment at a real, resolvable name
  // that still has no app hostnames: MagicDNS has no wildcard records and a
  // Tailscale certificate covers the node's own name only, so a derived
  // address would resolve nowhere - and it would be written into every app's
  // environment as if it did. Nil ruled these offices keep port links
  // (2026-08-08), which is what `null` here buys.
  it("is null for a tailnet office host", () => {
    for (const origin of [
      "https://auntie.parrot-fish.ts.net",
      "https://auntie.tail1234.ts.net",
      // The apex itself. No office lives here, but without it `hello.ts.net`
      // would be an app host.
      "https://ts.net",
      // The port does not participate: the rule is about the NAME.
      "https://auntie.parrot-fish.ts.net:8443",
      // Case and a trailing dot, normalized by the same two steps that
      // canonicalize every other office host.
      "https://AUNTIE.PARROT-FISH.TS.NET./",
      // The fullwidth spelling. `URL`'s IDNA mapping folds it to `ts.net`
      // before the check runs, which is why the check runs after the parse.
      "https://auntie.parrot-fish.ｔｓ.ｎｅｔ",
    ]) {
      expect({ origin, domain: deriveAppHostDomain(origin, true) }).toEqual({
        origin,
        domain: null,
      });
    }
  });

  it("matches the tailnet suffix on the label boundary, not the string", () => {
    // Ordinary domains that merely end in those characters. A substring check
    // would take app hostnames away from all three.
    for (const origin of [
      "https://myts.net",
      "https://notts.net",
      "https://ts.net.example.com",
    ]) {
      const expected = new URL(origin).hostname;
      expect({ origin, domain: deriveAppHostDomain(origin, true) }).toEqual({
        origin,
        domain: expected,
      });
    }
  });
});

describe("appPublicUrl", () => {
  it("is the label under the office host, over https", () => {
    expect(appPublicUrl("hello", "office.example")).toBe(
      "https://hello.office.example",
    );
  });

  it("is null when the office has no app-host domain", () => {
    // Every dev box and every plain-HTTP install. An app must be able to tell
    // "no URL" from "some URL", so this is null rather than an empty string.
    expect(appPublicUrl("hello", null)).toBeNull();
  });

  it("uses the LABEL, so a reused name never inherits the old origin", () => {
    // The whole point of the ledger: this app's NAME is `hello` and its label
    // is `hello-g2`, and the previous `hello`'s origin must stay dead.
    expect(appPublicUrl("hello-g2", "office.example")).toBe(
      "https://hello-g2.office.example",
    );
  });
});

// The lifecycle, pinned directly. There is exactly one legal order - boot
// state frozen, then the domain frozen, then requests - and reading the domain
// outside it is a boot-order bug, not something to paper over: before
// freezeBootState runs, buildPublicOrigin answers with its strict pre-boot
// default, so a lazy resolve would cache `null` for the life of the process
// and silently disable app hostnames on a deployment that has them.
describe("appHostDomain lifecycle", () => {
  // Leave the module in the state every other test file expects: the harness
  // resets and re-freezes on each boot, but nothing here should depend on the
  // order test files happen to run in.
  afterAll(() => freezeAppHostDomain());

  it("throws when read before the boot freeze", () => {
    _testResetAppHostDomain();
    expect(() => appHostDomain()).toThrow(/before freezeAppHostDomain/);
  });

  it("answers once frozen", () => {
    _testResetAppHostDomain();
    freezeAppHostDomain();
    // The VALUE depends on this process's boot state, which a pure test has no
    // business asserting - deriveAppHostDomain's matrix above covers that.
    // What matters here is that it answers at all instead of throwing.
    const domain = appHostDomain();
    expect(domain === null || typeof domain === "string").toBe(true);
  });

  it("throws again after a reset, so the harness cannot leak a stale domain", () => {
    freezeAppHostDomain();
    _testResetAppHostDomain();
    expect(() => appHostDomain()).toThrow();
  });
});

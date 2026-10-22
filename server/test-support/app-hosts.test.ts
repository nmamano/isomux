// Pure matrices for app-host dispatch (phase 3, slice 3): the Host header's
// normalization and the Host -> label match. The office's own domain is in
// app-domain.test.ts.
//
// The URL shape is FLAT: an app called `hello` on an office at
// `office.example` answers at `hello.office.example`. So the office host and
// its app hostnames are parent and children in ONE namespace, and the single
// rule that keeps the office reachable - the exact canonical office host is
// never diverted - is what these tests lean on hardest.
//
// The grammar is shared by four consumers: app-host dispatch, the certificate
// gate (tls-ask.ts), screenshot grants and the short-link host check. The
// wiring - that the office actually diverts these hosts and nothing else, and
// that a reserved label is diverted like any other - is pinned in
// app-host-dispatch.test.ts against the real server.
//
// The bias throughout: a normalizer that returns null means "not an app host",
// which means the office answers exactly as it does today. The dangerous
// direction is a host that normalizes into a MATCH it should not have.

import { describe, it, expect } from "bun:test";
import { matchAppHost, normalizeRequestHost } from "../app-hosts.ts";

describe("normalizeRequestHost", () => {
  it("canonicalizes case, a port and exactly one trailing dot", () => {
    expect(normalizeRequestHost("HELLO.Office.Example")).toBe(
      "hello.office.example",
    );
    expect(normalizeRequestHost("hello.office.example:443")).toBe(
      "hello.office.example",
    );
    expect(normalizeRequestHost("a.b.")).toBe("a.b");
    // The trailing dot comes before the port, as a real Host carries it.
    expect(normalizeRequestHost("a.b.:8080")).toBe("a.b");
    // An A-label is plain ASCII and matches literally.
    expect(normalizeRequestHost("xn--r8jz45g.example")).toBe(
      "xn--r8jz45g.example",
    );
  });

  it("accepts any all-digit port and rejects every other port syntax", () => {
    // Syntax only - we route on the name, so the port's value is irrelevant.
    expect(normalizeRequestHost("a.b:0")).toBe("a.b");
    expect(normalizeRequestHost("a.b:0080")).toBe("a.b");
    expect(normalizeRequestHost("a.b:99999")).toBe("a.b");
    expect(normalizeRequestHost("a.b:")).toBeNull();
    expect(normalizeRequestHost("a.b:http")).toBeNull();
    expect(normalizeRequestHost("a.b:80:80")).toBeNull();
  });

  it("rejects an absent header, IPv6 literals and malformed labels", () => {
    for (const host of [
      null,
      undefined,
      "",
      "[::1]",
      "[::1]:4000",
      "[2001:db8::1]:443",
      "a.b..",
      "-lead.example",
      "trail-.example",
      "under_score.example",
      "has space.example",
      " leading.example",
      "a..b",
      ".a.b",
    ]) {
      expect({ host, normalized: normalizeRequestHost(host) }).toEqual({
        host,
        normalized: null,
      });
    }
  });

  it("rejects everything outside printable ASCII", () => {
    expect(normalizeRequestHost("host.example\x00")).toBeNull();
    expect(normalizeRequestHost("host.example\n")).toBeNull();
    expect(normalizeRequestHost("host.example\x7f")).toBeNull(); // DEL
    expect(normalizeRequestHost("héllo.example")).toBeNull();
    expect(normalizeRequestHost("例え.example")).toBeNull();
  });

  it("rejects non-ASCII that would CASE-FOLD into a valid label", () => {
    // The one that makes the ASCII gate load-bearing rather than tidy: U+212A
    // KELVIN SIGN lowercases to a plain ASCII "k", so without the gate
    // "hell<U+212A>o.office.example" would normalize to "hellko.office.example"
    // and match a real app. Every other non-ASCII form is caught later by the
    // label pattern anyway; this one is not.
    // Written as an escape so no editor or copy can silently turn it into a
    // plain "K"; the first line proves the premise still holds.
    const kelvin = "\u212A";
    expect(kelvin.toLowerCase()).toBe("k");
    expect(normalizeRequestHost(`hell${kelvin}o.example`)).toBeNull();
    expect(normalizeRequestHost(`${kelvin}.example`)).toBeNull();
  });

  it("holds the RFC 1035 ceilings: a label at 63, a name at 253 after the trailing dot goes", () => {
    const label = (n: number) => "a".repeat(n);
    expect(normalizeRequestHost(`${label(63)}.example`)).toBe(
      `${label(63)}.example`,
    );
    expect(normalizeRequestHost(`${label(64)}.example`)).toBeNull();
    const n253 = `${label(63)}.${label(63)}.${label(63)}.${label(61)}`;
    const n254 = `${label(63)}.${label(63)}.${label(63)}.${label(62)}`;
    expect(n253.length).toBe(253);
    expect(n254.length).toBe(254);
    expect(normalizeRequestHost(n253)).toBe(n253);
    expect(normalizeRequestHost(n254)).toBeNull();
    // 253 + a trailing dot is 254 characters on the wire and still legal.
    expect(normalizeRequestHost(`${n253}.`)).toBe(n253);
  });
});

describe("matchAppHost", () => {
  const domain = "office.example";

  it("never diverts the office's own host", () => {
    expect(matchAppHost("office.example", domain)).toBeNull();
  });

  it("matches one label below the office host", () => {
    expect(matchAppHost("hello.office.example", domain)).toEqual({
      kind: "label",
      label: "hello",
    });
  });

  it("treats two or more labels as under the domain, not a label", () => {
    expect(matchAppHost("a.b.office.example", domain)).toEqual({
      kind: "under",
    });
    expect(matchAppHost("a.b.c.office.example", domain)).toEqual({
      kind: "under",
    });
  });

  it("does not match hosts outside the domain, including a suffix lookalike", () => {
    for (const host of [
      "example",
      "localhost",
      "office.example.evil.test",
      // The dot in the suffix check is what stops these being read as inside.
      "notoffice.example",
      "eviloffice.example",
    ]) {
      expect({ host, match: matchAppHost(host, domain) }).toEqual({
        host,
        match: null,
      });
    }
  });
});

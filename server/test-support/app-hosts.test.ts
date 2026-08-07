// Pure matrices for app-host dispatch (phase 3, slice 3): the Host header's
// normalization and the Host -> label match. The hostname grammar and the
// office's own domain moved to app-domain.test.ts with their module.
//
// The URL shape is FLAT: an app called `hello` on an office at
// `office.example` answers at `hello.office.example`. So the office host and
// its app hostnames are parent and children in ONE namespace, and the single
// rule that keeps the office reachable - the exact canonical office host is
// never diverted - is what these tests lean on hardest.
//
// Everything here is a pure function. The wiring - that the office actually
// diverts these hosts and nothing else - is pinned in app-host-dispatch.test.ts
// against the real server.
//
// The bias throughout: a normalizer that returns null means "not an app host",
// which means the office answers exactly as it does today. So a rejection is
// never a refusal, and the only genuinely dangerous direction is a host that
// normalizes into a MATCH it should not have.

import { describe, it, expect } from "bun:test";
import { matchAppHost, normalizeRequestHost } from "../app-hosts.ts";

describe("normalizeRequestHost", () => {
  it("lowercases the host", () => {
    expect(normalizeRequestHost("HELLO.Office.Example")).toBe(
      "hello.office.example",
    );
  });

  it("strips a port", () => {
    expect(normalizeRequestHost("hello.office.example:443")).toBe(
      "hello.office.example",
    );
  });

  it("accepts syntactically odd but numeric ports - the value is irrelevant", () => {
    expect(normalizeRequestHost("a.b:0")).toBe("a.b");
    expect(normalizeRequestHost("a.b:0080")).toBe("a.b");
    expect(normalizeRequestHost("a.b:99999")).toBe("a.b");
  });

  it("rejects an empty, non-numeric or doubled port", () => {
    expect(normalizeRequestHost("a.b:")).toBeNull();
    expect(normalizeRequestHost("a.b:http")).toBeNull();
    expect(normalizeRequestHost("a.b:80:80")).toBeNull();
  });

  it("strips exactly one trailing dot", () => {
    expect(normalizeRequestHost("a.b.")).toBe("a.b");
    expect(normalizeRequestHost("a.b..")).toBeNull();
  });

  it("applies the trailing dot after the port, as a real Host carries it", () => {
    expect(normalizeRequestHost("a.b.:8080")).toBe("a.b");
  });

  it("rejects bracketed IPv6 literals", () => {
    expect(normalizeRequestHost("[::1]")).toBeNull();
    expect(normalizeRequestHost("[::1]:4000")).toBeNull();
    expect(normalizeRequestHost("[2001:db8::1]:443")).toBeNull();
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
    expect("K".toLowerCase()).toBe("k");
    expect(normalizeRequestHost("hellKo.example")).toBeNull();
    expect(normalizeRequestHost("K.example")).toBeNull();
  });

  it("accepts an A-label as the plain ASCII it is", () => {
    expect(normalizeRequestHost("xn--r8jz45g.example")).toBe(
      "xn--r8jz45g.example",
    );
  });

  it("rejects malformed labels", () => {
    expect(normalizeRequestHost("-lead.example")).toBeNull();
    expect(normalizeRequestHost("trail-.example")).toBeNull();
    expect(normalizeRequestHost("under_score.example")).toBeNull();
    expect(normalizeRequestHost("has space.example")).toBeNull();
    expect(normalizeRequestHost(" leading.example")).toBeNull();
    expect(normalizeRequestHost("a..b")).toBeNull();
    expect(normalizeRequestHost(".a.b")).toBeNull();
  });

  it("rejects an absent or empty header", () => {
    expect(normalizeRequestHost(null)).toBeNull();
    expect(normalizeRequestHost(undefined)).toBeNull();
    expect(normalizeRequestHost("")).toBeNull();
  });

  it("accepts a bare single-label host (it simply cannot match)", () => {
    expect(normalizeRequestHost("localhost")).toBe("localhost");
  });

  it("holds a label at 63 and rejects 64", () => {
    const l63 = "a".repeat(63);
    const l64 = "a".repeat(64);
    expect(normalizeRequestHost(`${l63}.example`)).toBe(`${l63}.example`);
    expect(normalizeRequestHost(`${l64}.example`)).toBeNull();
  });

  it("holds a name at 253 and rejects 254, measured after the trailing dot goes", () => {
    const label = (n: number) => "a".repeat(n);
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

  it("matches a generation label", () => {
    expect(matchAppHost("hello-g2.office.example", domain)).toEqual({
      kind: "label",
      label: "hello-g2",
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

  it("does not match hosts outside the domain", () => {
    expect(matchAppHost("example", domain)).toBeNull();
    expect(matchAppHost("localhost", domain)).toBeNull();
    expect(matchAppHost("office.example.evil.test", domain)).toBeNull();
  });

  it("does not match a suffix lookalike", () => {
    // The dot in the suffix check is what stops these being read as inside.
    expect(matchAppHost("notoffice.example", domain)).toBeNull();
    expect(matchAppHost("eviloffice.example", domain)).toBeNull();
  });

  it("diverts a RESERVED name like any other label", () => {
    // Settled 2026-08-06 (Nil, via the manager; Reviewer1's absolute rule):
    // reserved names do NOT fall through to the office. An office on HTTPS
    // owns the namespace below its host, and the cost - an operator's
    // pre-existing `www.` alias now 404s - is accepted rather than patched
    // with an exception list that would only cover the names we guessed.
    // Reserved names stay unregistrable as apps; that is a registry
    // invariant and says nothing about routing.
    expect(matchAppHost("www.office.example", domain)).toEqual({
      kind: "label",
      label: "www",
    });
    expect(matchAppHost("api.office.example", domain)).toEqual({
      kind: "label",
      label: "api",
    });
  });
});

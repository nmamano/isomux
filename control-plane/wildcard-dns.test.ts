import { describe, expect, test } from "bun:test";
import {
  WILDCARD_DNS_RUNG,
  wildcardDnsReasonFor,
  wildcardDnsVerdict,
  wildcardProbeHost,
  sameWildcardAnswers,
} from "./wildcard-dns.ts";

const answers = (a: string[], aaaa: string[] = []) => ({
  a,
  aaaa,
  absent: a.length === 0 && aaaa.length === 0,
});

describe("hosted app wildcard DNS", () => {
  test("the synthetic child is stable, opaque, and scoped to the office", () => {
    const first = wildcardProbeHost("inst-123", "acme.test.isomux.app");
    expect(first).toBe(wildcardProbeHost("inst-123", "acme.test.isomux.app"));
    expect(first).not.toContain("inst-123");
    expect(first).toMatch(
      /^isomux-app-check-[0-9a-f]{24}\.acme\.test\.isomux\.app$/,
    );
    expect(wildcardProbeHost("inst-124", "acme.test.isomux.app")).not.toBe(
      first,
    );
  });

  test("only the exact instance A answer with no IPv6 is ready", () => {
    expect(wildcardDnsVerdict(answers(["203.0.113.7"]), "203.0.113.7")).toEqual(
      { ready: true },
    );
    expect(wildcardDnsVerdict(answers([]), "203.0.113.7")).toEqual({
      ready: false,
      detail: "missing",
    });
    expect(wildcardDnsVerdict(answers(["203.0.113.8"]), "203.0.113.7")).toEqual(
      { ready: false, detail: "wrong-a" },
    );
    expect(
      wildcardDnsVerdict(
        answers(["203.0.113.7", "203.0.113.8"]),
        "203.0.113.7",
      ),
    ).toEqual({ ready: false, detail: "wrong-a" });
    expect(
      wildcardDnsVerdict(
        answers(["203.0.113.7"], ["2001:db8::7"]),
        "203.0.113.7",
      ),
    ).toEqual({ ready: false, detail: "aaaa" });
  });

  test("its rungs cannot collide with office liveness rungs", () => {
    const liveness = new Set([
      "dns",
      "wrong-box",
      "tcp",
      "tls",
      "readyz",
      "ok",
    ]);
    expect(liveness.has(WILDCARD_DNS_RUNG)).toBe(false);
  });

  test("only an identical A and AAAA observation is unchanged", () => {
    const evidence = { a: ["203.0.113.8"], aaaa: [] };
    expect(sameWildcardAnswers(evidence, answers(["203.0.113.8"]))).toBe(true);
    expect(
      sameWildcardAnswers(
        { a: ["203.0.113.9", "203.0.113.8"], aaaa: [] },
        answers(["203.0.113.8", "203.0.113.9"]),
      ),
    ).toBe(true);
    expect(sameWildcardAnswers(evidence, answers(["203.0.113.9"]))).toBe(false);
    expect(
      sameWildcardAnswers(evidence, answers(["203.0.113.8"], ["2001:db8::8"])),
    ).toBe(false);
  });

  test("the operator reason names the wildcard and exact target", () => {
    expect(wildcardDnsReasonFor("acme.test.isomux.app", "203.0.113.7")).toBe(
      "the wildcard DNS record *.acme.test.isomux.app must point only at 203.0.113.7 before app links can open; automatic DNS setup did not converge the office and wildcard A records",
    );
  });
});

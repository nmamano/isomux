// server/tls-ask.ts - the certificate gate for app hostnames (phase 3, slice
// 7). The policy layer only: which names reach the registry's admission
// attempt, which are refused before it, and how the four registry answers
// become the three the terminator can read.
//
// The asymmetry to keep in mind: an approval here becomes a certificate for a
// public name and, because the gate is consulted on every cold load, also
// becomes permission to KEEP serving it. A refusal costs one caller a failed
// handshake. So the dangerous direction is a name that is not ours coming back
// "allow", and the fussy normalization cases below all guard that direction.
//
// The admission accounting itself is pinned in app-registry.test.ts, where the
// state is. The wiring - that the office answers this path and an app host
// cannot - is pinned against the real server in app-host-dispatch.test.ts.

import { describe, it, expect } from "bun:test";
import {
  decideTlsAsk,
  handleTlsAsk,
  TLS_ASK_PATH,
  tlsAskResponse,
  type TlsAskDeps,
} from "../tls-ask.ts";
import type { CertAdmission } from "../app-registry.ts";

const DOMAIN = "office.example";

// Live labels, and a record of every label the policy actually handed to the
// registry. The recording is the point of several cases below: a name that is
// refused earlier must never reach the admission attempt at all, because that
// is the call that can write to disk and spend the office's budget.
function registry(
  live: string[],
  answer: (label: string) => CertAdmission = () => "admitted",
) {
  const asked: string[] = [];
  const deps: TlsAskDeps = {
    domain: DOMAIN,
    admit: (label) => {
      asked.push(label);
      return live.includes(label) ? answer(label) : "not_live";
    },
  };
  return { deps, asked };
}

function decide(name: string | null, live = ["hello", "board-g2", "kappa"]) {
  return decideTlsAsk(name, registry(live).deps);
}

describe("decideTlsAsk: what may be certified", () => {
  it("allows a live app's label", () => {
    expect(decide(`hello.${DOMAIN}`)).toBe("allow");
  });

  it("allows a live app's LABEL, which is not always its name", () => {
    // The second app ever called `board` lives at `board-g2`, and `board` is
    // the label of a retired predecessor. Certifying by name would hand the
    // successor its predecessor's origin - the thing the ledger exists to stop.
    expect(decide(`board-g2.${DOMAIN}`)).toBe("allow");
    expect(decide(`board.${DOMAIN}`)).toBe("deny");
  });

  it("allows the office's own host without consulting the registry", () => {
    // Measured on the test box: the terminator never asks about the office host
    // at all, because its certificate comes from the ordinary managed site
    // block. This arm exists for an office served through the wildcard, and it
    // must not spend an app's admission budget on the office itself.
    const { deps, asked } = registry([]);
    expect(decideTlsAsk(DOMAIN, deps)).toBe("allow");
    expect(asked).toEqual([]);
  });

  it("denies an unknown label and a retired one identically", () => {
    expect(decide(`nope.${DOMAIN}`)).toBe("deny");
    expect(decide(`board.${DOMAIN}`)).toBe("deny");
  });

  it("refuses the hosted readiness probe without spending an admission", () => {
    const asked: string[] = [];
    const admissionVerdicts: CertAdmission[] = [];
    const deps: TlsAskDeps = {
      domain: DOMAIN,
      admit: (label) => {
        asked.push(label);
        admissionVerdicts.push("not_live");
        return "not_live";
      },
    };
    const probe = `isomux-app-check-${"a".repeat(24)}.${DOMAIN}`;
    expect(decideTlsAsk(probe, deps)).toBe("deny");
    expect(asked).toEqual([`isomux-app-check-${"a".repeat(24)}`]);
    expect(admissionVerdicts).toEqual(["not_live"]);
  });

  it("passes a capped admission through as its own answer", () => {
    const { deps } = registry(["hello"], () => "capped");
    expect(decideTlsAsk(`hello.${DOMAIN}`, deps)).toBe("capped");
  });

  it("treats an already-admitted label exactly like a fresh admission", () => {
    // This is the case a terminator restart produces at every live app at once,
    // and the one that must never be refused.
    const { deps } = registry(["hello"], () => "already");
    expect(decideTlsAsk(`hello.${DOMAIN}`, deps)).toBe("allow");
  });

  it("denies anything more than one label below the office", () => {
    expect(decide(`a.hello.${DOMAIN}`)).toBe("deny");
    expect(decide(`.${DOMAIN}`)).toBe("deny");
  });

  it("denies a name outside the domain, including a suffix lookalike", () => {
    expect(decide("hello.example.com")).toBe("deny");
    expect(decide(`hello.evil-${DOMAIN}`)).toBe("deny");
    expect(decide(`${DOMAIN}.evil.com`)).toBe("deny");
  });

  it("denies every name on an office with no app hostnames", () => {
    const { deps, asked } = registry(["hello"]);
    const dark: TlsAskDeps = { ...deps, domain: null };
    expect(decideTlsAsk(`hello.${DOMAIN}`, dark)).toBe("deny");
    expect(decideTlsAsk(DOMAIN, dark)).toBe("deny");
    expect(asked).toEqual([]);
  });

  it("denies a missing name", () => {
    expect(decide(null)).toBe("deny");
  });

  it("normalizes the name the way a request Host is normalized", () => {
    expect(decide(`HELLO.${DOMAIN.toUpperCase()}`)).toBe("allow");
    expect(decide(`hello.${DOMAIN}.`)).toBe("allow");
  });

  it("denies names the host grammar refuses", () => {
    expect(decide("")).toBe("deny");
    expect(decide(`hel lo.${DOMAIN}`)).toBe("deny");
    expect(decide(`hello.${DOMAIN}..`)).toBe("deny");
    expect(decide(`-hello.${DOMAIN}`)).toBe("deny");
    expect(decide(`[::1]`)).toBe("deny");
    expect(decide(`[2001:db8::1]:443`)).toBe("deny");
    // The Kelvin sign folds to `k` under Unicode case folding, so a non-ASCII
    // name could otherwise arrive at a live label. The grammar refuses
    // non-ASCII outright rather than folding it (slice 3's trap).
    expect(decide(`Kappa.${DOMAIN}`)).toBe("deny");
    expect(decide(`kappa.${DOMAIN}`)).toBe("allow");
  });

  it("never reaches the admission attempt for a name it can refuse itself", () => {
    // The load-bearing one. Everything in this list is refused by shape, and
    // the admission attempt is the only call that writes to disk or spends
    // capacity - so a stranger pointing a thousand names at the box must not be
    // able to reach it.
    const { deps, asked } = registry(["hello"]);
    for (const name of [
      "",
      "hello.example.com",
      `a.b.${DOMAIN}`,
      `.${DOMAIN}`,
      `hel lo.${DOMAIN}`,
      `Kappa.${DOMAIN}`,
      `hello.${DOMAIN}..`,
      "[::1]",
      DOMAIN,
    ]) {
      decideTlsAsk(name, deps);
    }
    expect(asked).toEqual([]);
  });
});

describe("the response the terminator reads", () => {
  it("proceeds only on a 2xx, and says which refusal it is", () => {
    expect(tlsAskResponse("allow").status).toBe(200);
    expect(tlsAskResponse("deny").status).toBe(403);
    expect(tlsAskResponse("capped").status).toBe(429);
  });

  it("is never cached", () => {
    // A cached "ok" would outlive the app it vouched for.
    for (const d of ["allow", "deny", "capped"] as const) {
      expect(tlsAskResponse(d).headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("carries the bodies verbatim", async () => {
    expect(await tlsAskResponse("allow").text()).toBe("ok\n");
    expect(await tlsAskResponse("deny").text()).toBe("denied\n");
    expect(await tlsAskResponse("capped").text()).toBe("rate limited\n");
  });
});

describe("handleTlsAsk: the query contract", () => {
  function url(query: string): URL {
    return new URL(`http://127.0.0.1:4000${TLS_ASK_PATH}${query}`);
  }

  it("answers from a single domain parameter", () => {
    const { deps } = registry(["hello"]);
    expect(handleTlsAsk(url(`?domain=hello.${DOMAIN}`), deps).status).toBe(200);
  });

  it("ignores parameters that are not the subject", () => {
    const { deps } = registry(["hello"]);
    expect(
      handleTlsAsk(url(`?trace=1&domain=hello.${DOMAIN}&x=y`), deps).status,
    ).toBe(200);
  });

  it("refuses a missing, empty or repeated subject without asking anyone", () => {
    // Answering the first of two names is how a gate ends up vouching for the
    // other one.
    const { deps, asked } = registry(["hello"]);
    for (const query of [
      "",
      "?domain=",
      `?domain=hello.${DOMAIN}&domain=evil.${DOMAIN}`,
      `?domain=evil.${DOMAIN}&domain=hello.${DOMAIN}`,
      `?domain=hello.${DOMAIN}&domain=`,
    ]) {
      expect(handleTlsAsk(url(query), deps).status).toBe(403);
    }
    expect(asked).toEqual([]);
  });

  it("refuses when the registry cannot answer at all", () => {
    // A registry that cannot be read, or an admission that could not be
    // written. A wholly unreadable apps.json therefore refuses established
    // labels too: their proof of admission is in that file.
    const deps: TlsAskDeps = {
      domain: DOMAIN,
      admit: () => {
        throw new Error("apps.json is unreadable");
      },
    };
    const res = handleTlsAsk(url(`?domain=hello.${DOMAIN}`), deps);
    expect(res.status).toBe(403);
  });
});

// server/tls-ask.ts - the certificate gate for app hostnames (phase 3, slice
// 7). The policy layer only: which names reach the registry's live-label
// check, which are refused before it, and the status the terminator reads.
//
// The asymmetry to keep in mind: an approval here becomes a certificate for a
// public name and, because the gate is consulted on every cold load, also
// becomes permission to KEEP serving it. A refusal costs one caller a failed
// handshake. So the dangerous direction is a name that is not ours coming back
// "allow", and the fussy normalization cases below all guard that direction.
//
// The live-label check itself is pinned in app-registry.test.ts, where the
// state is. The wiring - that the office answers this path and an app host
// cannot - is pinned against the real server in app-host-dispatch.test.ts.

import { describe, it, expect } from "bun:test";
import { handleTlsAsk, TLS_ASK_PATH, type TlsAskDeps } from "../tls-ask.ts";

const DOMAIN = "office.example";

// Live labels, and a record of every label the policy actually handed to the
// registry. The recording is the point of several cases below: a name that is
// refused by shape must never reach the registry at all, so what a stranger
// sends cannot depend on, or learn from, what the registry holds.
function registry(
  live: string[],
  answer: (label: string) => boolean = () => true,
) {
  const asked: string[] = [];
  const deps: TlsAskDeps = {
    domain: DOMAIN,
    isLive: (label) => {
      asked.push(label);
      return live.includes(label) && answer(label);
    },
  };
  return { deps, asked };
}

function url(query: string): URL {
  return new URL(`http://127.0.0.1:4000${TLS_ASK_PATH}${query}`);
}

// The gate's answer for one name: the terminator proceeds on 200 only.
function ask(name: string, deps: TlsAskDeps) {
  const { status } = handleTlsAsk(
    url(`?domain=${encodeURIComponent(name)}`),
    true,
    deps,
  );
  return status === 200 ? "allow" : status === 403 ? "deny" : status;
}

function decide(name: string, live = ["hello", "board-g2", "kappa"]) {
  return ask(name, registry(live).deps);
}

describe("the tls-ask policy: what may be certified", () => {
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
    // block. This arm exists for an office served through the wildcard, and the
    // office is not an app.
    const { deps, asked } = registry([]);
    expect(ask(DOMAIN, deps)).toBe("allow");
    expect(asked).toHaveLength(0);
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
    expect(ask(`hello.${DOMAIN}`, dark)).toBe("deny");
    expect(ask(DOMAIN, dark)).toBe("deny");
    expect(asked).toHaveLength(0);
  });

  it("normalizes the name the way a request Host is normalized", () => {
    expect(decide(`HELLO.${DOMAIN.toUpperCase()}`)).toBe("allow");
    expect(decide(`hello.${DOMAIN}.`)).toBe("allow");
  });

  it("denies names the host grammar refuses", () => {
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

  it("never reaches the registry for a name it can refuse itself", () => {
    // The load-bearing one. Everything in this list is refused by shape, so a
    // stranger pointing a thousand names at the box never reaches the registry.
    const { deps, asked } = registry(["hello"]);
    for (const name of [
      "hello.example.com",
      `a.b.${DOMAIN}`,
      `.${DOMAIN}`,
      `hel lo.${DOMAIN}`,
      `Kappa.${DOMAIN}`,
      `hello.${DOMAIN}..`,
      "[::1]",
      DOMAIN,
    ]) {
      ask(name, deps);
    }
    expect(asked).toHaveLength(0);
  });
});

describe("the response the terminator reads", () => {
  it("proceeds only on a 2xx", () => {
    const { deps } = registry(["hello"]);
    expect(
      handleTlsAsk(url(`?domain=hello.${DOMAIN}`), true, deps).status,
    ).toBe(200);
    expect(handleTlsAsk(url(`?domain=nope.${DOMAIN}`), true, deps).status).toBe(
      403,
    );
  });

  it("is never cached", () => {
    // A cached "ok" would outlive the app it vouched for.
    const { deps } = registry(["hello"]);
    for (const name of ["hello", "nope"]) {
      const res = handleTlsAsk(url(`?domain=${name}.${DOMAIN}`), true, deps);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });
});

describe("handleTlsAsk: the query contract", () => {
  it("answers from a single domain parameter", () => {
    const { deps } = registry(["hello"]);
    expect(
      handleTlsAsk(url(`?domain=hello.${DOMAIN}`), true, deps).status,
    ).toBe(200);
  });

  it("ignores parameters that are not the subject", () => {
    const { deps } = registry(["hello"]);
    expect(
      handleTlsAsk(url(`?trace=1&domain=hello.${DOMAIN}&x=y`), true, deps)
        .status,
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
      expect(handleTlsAsk(url(query), true, deps).status).toBe(403);
    }
    expect(asked).toHaveLength(0);
  });

  it("refuses when the registry cannot answer at all", () => {
    // A registry that cannot be read. A wholly unreadable apps.json therefore
    // refuses established labels too: their proof of issuance is in that file.
    const deps: TlsAskDeps = {
      domain: DOMAIN,
      isLive: () => {
        throw new Error("apps.json is unreadable");
      },
    };
    const res = handleTlsAsk(url(`?domain=hello.${DOMAIN}`), true, deps);
    expect(res.status).toBe(403);
  });
});

// A caller that came through the public proxy (task 1fa3c1de). The terminator
// asks directly, so a proxied ask is a stranger asking which apps exist: it
// gets one fixed answer, decided before the subject or the registry is read.
describe("handleTlsAsk: a proxied caller", () => {
  async function answer(res: Response) {
    return {
      status: res.status,
      headers: [...res.headers.entries()],
      body: await res.text(),
    };
  }

  it("answers a live label, an unknown label and the office host identically, without reading the registry", async () => {
    const reads: string[] = [];
    const deps: TlsAskDeps = {
      get domain() {
        reads.push("domain");
        return DOMAIN;
      },
      isLive: (label) => {
        reads.push(`isLive:${label}`);
        return label === "hello";
      },
    };
    // The enabling condition: unproxied, the same registry tells them apart.
    expect(
      handleTlsAsk(url(`?domain=hello.${DOMAIN}`), true, deps).status,
    ).toBe(200);
    expect(handleTlsAsk(url(`?domain=nope.${DOMAIN}`), true, deps).status).toBe(
      403,
    );
    reads.length = 0;

    const live = await answer(
      handleTlsAsk(url(`?domain=hello.${DOMAIN}`), false, deps),
    );
    expect(live.status).toBe(403);
    for (const query of [`?domain=nope.${DOMAIN}`, `?domain=${DOMAIN}`, ""]) {
      expect({
        query,
        ...(await answer(handleTlsAsk(url(query), false, deps))),
      }).toEqual({ query, ...live });
    }
    expect(reads).toEqual([]);
  });
});

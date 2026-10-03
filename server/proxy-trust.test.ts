// server/proxy-trust.ts - the per-request on-box and client classification
// (internal-docs/proxy-trust-design.md). Pure T0: no server.

import { describe, expect, it } from "bun:test";
import { classifyRequest, type TrustedProxy } from "./proxy-trust.ts";

const MODES: TrustedProxy[] = ["none", "same-host", "load-balancer"];

function req(headers: [string, string][] = []): Request {
  const h = new Headers();
  for (const [name, value] of headers) h.append(name, value);
  return new Request("http://localhost/", { headers: h });
}

describe("classifyRequest: on-box", () => {
  it("is on-box for a loopback peer with no forwarding header, in every mode", () => {
    for (const mode of MODES) {
      for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.0.5"]) {
        expect(classifyRequest(req(), peer, mode).onBox).toBe(true);
      }
    }
  });

  it("is off-box when a loopback request carries any forwarding header, in every mode", () => {
    for (const mode of MODES) {
      for (const name of ["X-Forwarded-For", "Forwarded", "X-Real-IP"]) {
        expect(
          classifyRequest(req([[name, "203.0.113.9"]]), "127.0.0.1", mode)
            .onBox,
        ).toBe(false);
        // Presence is what counts, not the value.
        expect(
          classifyRequest(req([[name, ""]]), "127.0.0.1", mode).onBox,
        ).toBe(false);
      }
    }
  });

  it("is off-box for a non-loopback or unknown peer, with or without headers", () => {
    for (const mode of MODES) {
      expect(classifyRequest(req(), "10.0.0.8", mode).onBox).toBe(false);
      expect(classifyRequest(req(), null, mode).onBox).toBe(false);
    }
  });
});

describe("classifyRequest: client", () => {
  const xff = (value: string) => req([["X-Forwarded-For", value]]);

  it("none: the client is always the peer", () => {
    expect(classifyRequest(xff("203.0.113.9"), "127.0.0.1", "none").client).toBe(
      "127.0.0.1",
    );
    expect(classifyRequest(xff("203.0.113.9"), "10.0.0.8", "none").client).toBe(
      "10.0.0.8",
    );
  });

  it("same-host: the rightmost X-Forwarded-For entry of a loopback request", () => {
    expect(
      classifyRequest(xff("198.51.100.1, 203.0.113.9"), "127.0.0.1", "same-host")
        .client,
    ).toBe("203.0.113.9");
    // A non-loopback peer did not come through the same-host proxy.
    expect(
      classifyRequest(xff("203.0.113.9"), "10.0.0.8", "same-host").client,
    ).toBe("10.0.0.8");
  });

  it("load-balancer: the rightmost X-Forwarded-For entry of a non-loopback request", () => {
    expect(
      classifyRequest(xff("198.51.100.1,203.0.113.9"), "10.0.0.8", "load-balancer")
        .client,
    ).toBe("203.0.113.9");
    // A loopback peer did not come through the load balancer.
    expect(
      classifyRequest(xff("203.0.113.9"), "127.0.0.1", "load-balancer").client,
    ).toBe("127.0.0.1");
  });

  it("reads the last entry of the last header line when the header repeats", () => {
    const repeated = req([
      ["X-Forwarded-For", "198.51.100.1"],
      ["X-Forwarded-For", "198.51.100.2, 203.0.113.9"],
    ]);
    expect(classifyRequest(repeated, "127.0.0.1", "same-host").client).toBe(
      "203.0.113.9",
    );
  });

  it("falls back to the peer when the forwarded entry is empty", () => {
    expect(classifyRequest(xff(""), "127.0.0.1", "same-host").client).toBe(
      "127.0.0.1",
    );
    expect(classifyRequest(xff("1.2.3.4, "), "127.0.0.1", "same-host").client).toBe(
      "127.0.0.1",
    );
  });

  it("never reads X-Real-IP or Forwarded as an address", () => {
    const other = req([
      ["X-Real-IP", "203.0.113.9"],
      ["Forwarded", "for=203.0.113.9"],
    ]);
    for (const mode of MODES) {
      expect(classifyRequest(other, "127.0.0.1", mode).client).toBe("127.0.0.1");
      expect(classifyRequest(other, "10.0.0.8", mode).client).toBe("10.0.0.8");
    }
  });

  it("names an unknown peer", () => {
    expect(classifyRequest(req(), null, "none").client).toBe("unknown");
  });
});

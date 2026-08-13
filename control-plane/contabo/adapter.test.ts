import { describe, expect, test } from "bun:test";
import {
  ContaboAdapter,
  IndeterminateFindError,
  intentStamp,
} from "./adapter.ts";
import { IndeterminateProviderError } from "../provider.ts";
import { ContaboHttp } from "./http.ts";
import { TokenProvider, type FetchLike } from "./auth.ts";

interface Reply {
  status: number;
  body?: unknown;
  throws?: string;
}

/** A queued transport. Records the URLs it was asked for, so a test can prove
 * how many times a money-spending endpoint was reached. */
function transport(replies: Reply[]): { fetchImpl: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const queue = [...replies];
  const fetchImpl: FetchLike = (url) => {
    urls.push(url);
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    if (next.throws) return Promise.reject(new Error(next.throws));
    return Promise.resolve({
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: () => Promise.resolve(next.body ?? null),
    });
  };
  return { fetchImpl, urls };
}

function adapterOver(replies: Reply[]) {
  // The first reply is always the token grant.
  const t = transport([
    { status: 200, body: { access_token: "t", expires_in: 3600 } },
    ...replies,
  ]);
  const http = new ContaboHttp({
    fetchImpl: t.fetchImpl,
    tokens: new TokenProvider(
      { clientId: "c", clientSecret: "s", apiUser: "u", apiPassword: "p" },
      t.fetchImpl,
    ),
    requestId: () => "fixed-request-id",
  });
  return {
    adapter: new ContaboAdapter({
      http,
      imageId: "image-uuid",
      loginUser: "root",
    }),
    urls: t.urls,
  };
}

const INTENT = "abc123";
const STAMP = intentStamp(INTENT);

function row(id: number, displayName: string) {
  return { instanceId: id, displayName, status: "running" };
}

describe("get preserves the transport's outcome class", () => {
  test("a transport failure is indeterminate, not a refusal", async () => {
    const { adapter } = adapterOver([{ status: 0, throws: "socket hang up" }]);
    let thrown: unknown;
    try {
      await adapter.get("203474835");
    } catch (err) {
      thrown = err;
    }
    // "failed" downstream would claim we learned the instance was gone.
    expect(thrown).toBeInstanceOf(IndeterminateProviderError);
  });

  test("a 5xx is indeterminate too", async () => {
    const { adapter } = adapterOver([{ status: 503 }]);
    let thrown: unknown;
    try {
      await adapter.get("203474835");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(IndeterminateProviderError);
  });

  test("a 2xx with no readable row is indeterminate", async () => {
    const { adapter } = adapterOver([{ status: 200, body: { data: [] } }]);
    let thrown: unknown;
    try {
      await adapter.get("203474835");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(IndeterminateProviderError);
  });

  test("a 404 is a real answer: the instance is absent", async () => {
    const { adapter } = adapterOver([{ status: 404 }]);
    const view = await adapter.get("203474835");
    expect(view.assetState).toBe("absent");
  });

  test("a deterministic 4xx stays a plain refusal", async () => {
    const { adapter } = adapterOver([{ status: 400 }]);
    let thrown: unknown;
    try {
      await adapter.get("203474835");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(IndeterminateProviderError);
  });
});

describe("the intent stamp", () => {
  test("uses only characters the provider accepts", () => {
    // Measured 2026-08-09: Contabo answers 400 "Only numbers, letters, spaces
    // and - allowed." A stamp it refuses is a create that cannot be issued and,
    // worse, an intent that find can never match on afterwards.
    expect(intentStamp("abc-123")).toMatch(/^[A-Za-z0-9 -]+$/);
  });

  test("refuses an intent id it cannot stamp legally", () => {
    expect(() => intentStamp("has:a:colon")).toThrow(/only numbers, letters/i);
    expect(() => intentStamp("has_underscore")).toThrow();
  });
});

describe("find", () => {
  test("claims exact only when the filter was honoured and one row matches", async () => {
    const { adapter } = adapterOver([
      {
        status: 200,
        body: { data: [row(1, STAMP)], _pagination: { totalElements: 1 } },
      },
    ]);
    expect(await adapter.find(INTENT)).toEqual({
      providerId: "1",
      confidence: "exact",
    });
  });

  // THE LOAD-BEARING ONE. Contabo silently ignores query parameters it does not
  // recognise: `?foo=bar` returns the whole account. If the adapter trusted the
  // server-side filter, a typo or a silent API change would hand back somebody
  // else's box and the machine would adopt it - the paid-duplicate failure
  // class. Verified live 2026-08-09.
  test("treats a response containing non-matching rows as an ignored filter", async () => {
    const { adapter } = adapterOver([
      {
        status: 200,
        body: {
          data: [row(1, STAMP), row(2, "isomux-cp-someone-else")],
          _pagination: { totalElements: 2 },
        },
      },
    ]);
    const found = await adapter.find(INTENT);
    expect(found?.providerId).toBe("1");
    expect(found?.confidence).toBe("unproven");
  });

  test("never claims exact when more than one row carries our stamp", async () => {
    const { adapter } = adapterOver([
      {
        status: 200,
        body: {
          data: [row(1, STAMP), row(2, STAMP)],
          _pagination: { totalElements: 2 },
        },
      },
    ]);
    expect((await adapter.find(INTENT))?.confidence).toBe("unproven");
  });

  test("never claims exact when the page is a slice of a larger result", async () => {
    const { adapter } = adapterOver([
      {
        status: 200,
        body: { data: [row(1, STAMP)], _pagination: { totalElements: 7 } },
      },
    ]);
    expect((await adapter.find(INTENT))?.confidence).toBe("unproven");
  });
});

describe("create outcome classes", () => {
  test("a 5xx is ambiguous, never rejected", async () => {
    const { adapter } = adapterOver([{ status: 503 }]);
    const out = await adapter.create({
      intentId: INTENT,
      plan: "V153",
      region: "EU",
      publicKeys: [1],
    });
    expect(out.outcome).toBe("ambiguous");
  });

  test("a dropped connection is ambiguous", async () => {
    const { adapter } = adapterOver([{ status: 0, throws: "socket hang up" }]);
    const out = await adapter.create({
      intentId: INTENT,
      plan: "V153",
      region: "EU",
      publicKeys: [1],
    });
    expect(out.outcome).toBe("ambiguous");
  });

  test("a 4xx is a rejection: nothing was spent", async () => {
    const { adapter } = adapterOver([{ status: 400 }]);
    const out = await adapter.create({
      intentId: INTENT,
      plan: "V153",
      region: "EU",
      publicKeys: [1],
    });
    expect(out.outcome).toBe("rejected");
  });

  test("an accepted order with no readable instanceId is ambiguous, not created", async () => {
    const { adapter } = adapterOver([{ status: 201, body: { data: [{}] } }]);
    const out = await adapter.create({
      intentId: INTENT,
      plan: "V153",
      region: "EU",
      publicKeys: [1],
    });
    expect(out.outcome).toBe("ambiguous");
  });

  test("stamps the intent into displayName and sends defaultUser explicitly", async () => {
    let sentBody: Record<string, unknown> = {};
    const t = transport([
      { status: 200, body: { access_token: "t", expires_in: 3600 } },
      { status: 201, body: { data: [{ instanceId: 42 }] } },
    ]);
    const wrapped: FetchLike = (url, init) => {
      if (
        typeof init.body === "string" &&
        url.includes("/v1/compute/instances")
      ) {
        sentBody = JSON.parse(init.body) as Record<string, unknown>;
      }
      return t.fetchImpl(url, init);
    };
    const http = new ContaboHttp({
      fetchImpl: wrapped,
      tokens: new TokenProvider(
        { clientId: "c", clientSecret: "s", apiUser: "u", apiPassword: "p" },
        wrapped,
      ),
    });
    const adapter = new ContaboAdapter({
      http,
      imageId: "image-uuid",
      loginUser: "root",
    });
    const out = await adapter.create({
      intentId: INTENT,
      plan: "V153",
      region: "EU",
      publicKeys: [7],
    });
    expect(out).toEqual({ outcome: "created", providerId: "42" });
    expect(sentBody.displayName).toBe(STAMP);
    // Contabo documents defaultUser as defaulting to "admin" and then produces
    // `ubuntu` when it is omitted, so it is never left to the default.
    expect(sentBody.defaultUser).toBe("root");
    expect(sentBody.addOns).toEqual({ backup: {} });
  });
});

describe("automated backup evidence", () => {
  test("an empty complete snapshot list proves no snapshot row", async () => {
    const { adapter } = adapterOver([
      {
        status: 200,
        body: { data: [], _pagination: { totalElements: 0, page: 1 } },
      },
    ]);
    expect(await adapter.providerSnapshots("203474835")).toEqual({
      newestSnapshotAt: null,
      snapshotCount: 0,
    });
  });

  test("reads every page and derives the newest provider snapshot", async () => {
    const first = Array.from({ length: 100 }, (_, i) => ({
      snapshotId: `snap-${i}`,
      instanceId: 203474835,
      createdDate: `2026-08-${String((i % 10) + 1).padStart(2, "0")}T00:00:00Z`,
    }));
    const { adapter, urls } = adapterOver([
      {
        status: 200,
        body: { data: first, _pagination: { totalElements: 101, page: 1 } },
      },
      {
        status: 200,
        body: {
          data: [
            {
              snapshotId: "snap-newest",
              instanceId: 203474835,
              createdDate: "2026-08-13T01:02:03Z",
            },
          ],
          _pagination: { totalElements: 101, page: 2 },
        },
      },
    ]);
    expect(await adapter.providerSnapshots("203474835")).toEqual({
      newestSnapshotAt: Date.parse("2026-08-13T01:02:03Z"),
      snapshotCount: 101,
    });
    expect(urls.at(-1)).toContain("page=2");
  });

  test("fails closed when pagination metadata is absent", async () => {
    const { adapter } = adapterOver([{ status: 200, body: { data: [] } }]);
    expect(adapter.providerSnapshots("203474835")).rejects.toBeInstanceOf(
      IndeterminateProviderError,
    );
  });

  test("fails closed when a row belongs to another instance", async () => {
    const { adapter } = adapterOver([
      {
        status: 200,
        body: {
          data: [
            {
              snapshotId: "wrong-box",
              instanceId: 1,
              createdDate: "2026-08-13T00:00:00Z",
            },
          ],
          _pagination: { totalElements: 1, page: 1 },
        },
      },
    ]);
    expect(adapter.providerSnapshots("203474835")).rejects.toThrow(
      /outside that instance/,
    );
  });
});

// "Nothing on this page" is only "no box" when the search itself was sound.
// An ignored filter means the rows are a slice of the whole account, so the
// intended box may exist and simply not be on it - and reporting that as a
// clean null lets a caller treat an unfound box as one that was never created.
describe("find must not report absence it cannot establish", () => {
  test("no match, but the filter was ignored -> indeterminate, never null", async () => {
    const { adapter } = adapterOver([
      {
        status: 200,
        body: {
          // Rows we did not ask for: proof the filter was ignored.
          data: [row(1, "isomux-cp-someone-else"), row(2, "isomux-cp-another")],
          _pagination: { totalElements: 2 },
        },
      },
    ]);
    expect(adapter.find(INTENT)).rejects.toThrow(IndeterminateFindError);
  });

  test("no match, and the page is a slice -> indeterminate, never null", async () => {
    const { adapter } = adapterOver([
      { status: 200, body: { data: [], _pagination: { totalElements: 40 } } },
    ]);
    expect(adapter.find(INTENT)).rejects.toThrow(/cannot establish absence/);
  });

  test("no match, filter honoured, response complete -> a real, usable null", async () => {
    const { adapter } = adapterOver([
      { status: 200, body: { data: [], _pagination: { totalElements: 0 } } },
    ]);
    expect(await adapter.find(INTENT)).toBeNull();
  });
});

// Exactness needs affirmative evidence that we saw the whole result. A response
// carrying no pagination metadata tells us nothing, and "nothing" is not proof.
describe("exactness requires positive evidence of a complete response", () => {
  test("a match with NO pagination metadata is unproven, not exact", async () => {
    const { adapter } = adapterOver([
      { status: 200, body: { data: [row(1, STAMP)] } },
    ]);
    expect((await adapter.find(INTENT))?.confidence).toBe("unproven");
  });

  test("absence with NO pagination metadata is indeterminate, not null", async () => {
    const { adapter } = adapterOver([{ status: 200, body: { data: [] } }]);
    expect(adapter.find(INTENT)).rejects.toThrow(IndeterminateFindError);
  });
});

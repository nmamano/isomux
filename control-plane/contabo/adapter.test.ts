import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ContaboAdapter,
  IndeterminateFindError,
  intentStamp,
} from "./adapter.ts";
import {
  IndeterminateProviderError,
  type LoginUser,
  type SshPublicKey,
} from "../provider.ts";
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
  test("a transport failure, a 5xx or a 2xx with no readable row is indeterminate, not a refusal", async () => {
    // "failed" downstream would claim we learned the instance was gone.
    for (const reply of [
      { status: 0, throws: "socket hang up" },
      { status: 503 },
      { status: 200, body: { data: [] } },
    ]) {
      const { adapter } = adapterOver([reply]);
      const thrown = await adapter.get("203474835").then(
        () => null,
        (err: unknown) => err,
      );
      expect([reply, thrown instanceof IndeterminateProviderError]).toEqual([
        reply,
        true,
      ]);
    }
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

// Task 644649b3. A plan change happens in the provider's panel, and the tick
// learns of it from get(): the product code says which plan the box is on now,
// and the instance id says which box the answer is about (the DNS re-point
// only follows an address for the box our asset row names).
describe("get reports the box's product and its own instance id", () => {
  test("a row with both carries them on the view", async () => {
    const { adapter } = adapterOver([
      {
        status: 200,
        body: {
          data: [
            {
              instanceId: 203474835,
              productId: "V155",
              status: "running",
              ipConfig: { v4: { ip: "192.0.2.20" } },
            },
          ],
        },
      },
    ]);
    const view = await adapter.get("203474835");
    expect({
      product: view.product,
      providerId: view.providerId,
      ipv4: view.ipv4,
    }).toEqual({
      product: "V155",
      providerId: "203474835",
      ipv4: "192.0.2.20",
    });
  });

  test("a row without a usable product or id leaves them unset, never a guess", async () => {
    for (const extra of [
      {},
      { productId: "" },
      { productId: 155 },
      { productId: null },
    ]) {
      const { adapter } = adapterOver([
        {
          status: 200,
          body: { data: [{ status: "running", ...extra }] },
        },
      ]);
      const view = await adapter.get("203474835");
      // The read itself succeeded: the row was applied.
      expect(view.assetState).toBe("active");
      expect([extra, view.product, view.providerId]).toEqual([
        extra,
        undefined,
        undefined,
      ]);
    }
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
  test("a 4xx is a rejection; a 5xx, a dropped connection or an order with no readable instanceId is ambiguous", async () => {
    // Rejected means nothing was spent; anything that cannot say so is
    // ambiguous, never rejected and never created.
    for (const [reply, outcome] of [
      [{ status: 400 }, "rejected"],
      [{ status: 503 }, "ambiguous"],
      [{ status: 0, throws: "socket hang up" }, "ambiguous"],
      [{ status: 201, body: { data: [{}] } }, "ambiguous"],
    ] as const) {
      const { adapter } = adapterOver([reply]);
      const out = await adapter.create({
        intentId: INTENT,
        plan: "V153",
        region: "EU",
        publicKeys: [
          {
            algorithm: "ssh-ed25519",
            blob: "AAAAC3NzaC1lZDI1NTE5AAAAIStubStubStubStubStubStubStubStubStubStub",
          },
        ],
      });
      expect([reply, out.outcome]).toEqual([reply, outcome]);
    }
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
      publicKeys: [
        {
          algorithm: "ssh-ed25519",
          blob: "AAAAC3NzaC1lZDI1NTE5AAAAIStubStubStubStubStubStubStubStubStubStub",
        },
      ],
    });
    expect(out).toEqual({ outcome: "created", providerId: "42" });
    expect(sentBody.displayName).toBe(STAMP);
    // Contabo documents defaultUser as defaulting to "admin" and then produces
    // `ubuntu` when it is omitted, so it is never left to the default.
    expect(sentBody.defaultUser).toBe("root");
    expect(sentBody).not.toHaveProperty("addOns");
  });
});

/**
 * What deploy/harden-ssh.sh writes and checks, read from the script itself so
 * the first-boot drop-in and the installer's harden step cannot drift apart:
 * the drop-in path, and each keyword hardening_is_effective requires with the
 * values it accepts (sshd -T spellings, lowercase).
 */
const HARDENING = (() => {
  const script = readFileSync(
    join(import.meta.dir, "../../deploy/harden-ssh.sh"),
    "utf8",
  );
  const configDir = /^SSHD_CONFIG_D=(\S+)$/m.exec(script)?.[1];
  const dropinName = /^DROPIN=\$SSHD_CONFIG_D\/(\S+)$/m.exec(script)?.[1];
  const strictRoot = /^STRICT_ROOT_LOGIN="([^"]+)"$/m.exec(script)?.[1];
  const body = /^hardening_is_effective\(\) \{\n([\s\S]*?)\n\}$/m.exec(
    script,
  )?.[1];
  if (!configDir || !dropinName || !strictRoot || !body) {
    throw new Error("deploy/harden-ssh.sh no longer has the expected shape");
  }
  const required = new Map<string, string[]>();
  for (const m of body.matchAll(/^\s*"([a-z]+) ([^"]+)"/gm)) {
    const values = m[2] === "$STRICT_ROOT_LOGIN" ? strictRoot : m[2];
    required.set(m[1], values.split("|"));
  }
  if (required.size < 3) {
    throw new Error("hardening_is_effective no longer lists its keywords");
  }
  return { dropin: `${configDir}/${dropinName}`, required };
})();

// The run key reaches the box through cloud-init user data in the create (and
// reinstall) call itself. Contabo's key store (/v1/secrets) is not a build
// dependency: it was down for days in 2026-11 and blocked every new box.
describe("the run key travels in cloud-init user data", () => {
  const KEY: SshPublicKey = {
    algorithm: "ssh-ed25519",
    blob: "AAAAC3NzaC1lZDI1NTE5AAAAIGj0T9kq1vYb3wH2mXo5sN8rL4pQe7uZcV6aD0fK9xBy",
  };
  const SK_KEY: SshPublicKey = {
    algorithm: "sk-ssh-ed25519@openssh.com",
    blob: "AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAAIB3c4dE5f6G7h8I9j0K1l2M3",
  };

  interface Sent {
    method: string;
    url: string;
    body: Record<string, unknown> | null;
  }

  function capturing(loginUser: LoginUser, replies: Reply[]) {
    const t = transport([
      { status: 200, body: { access_token: "t", expires_in: 3600 } },
      ...replies,
    ]);
    const sent: Sent[] = [];
    const wrapped: FetchLike = (url, init) => {
      if (url.includes("/v1/compute/instances")) {
        sent.push({
          method: init.method ?? "GET",
          url,
          body:
            typeof init.body === "string"
              ? (JSON.parse(init.body) as Record<string, unknown>)
              : null,
        });
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
    return {
      adapter: new ContaboAdapter({ http, imageId: "image-uuid", loginUser }),
      sent,
      urls: t.urls,
    };
  }

  /** The write_files list, parsed as cloud-init parses it (YAML). */
  function writtenFiles(body: Record<string, unknown> | null) {
    expect(body).not.toBeNull();
    // Neither field may be present: each one refers to a Contabo secret.
    expect(body).not.toHaveProperty("sshKeys");
    expect(body).not.toHaveProperty("rootPassword");
    const userData = body!.userData;
    expect(typeof userData).toBe("string");
    // cloud-init ignores user data that does not open with this header.
    expect((userData as string).split("\n")[0]).toBe("#cloud-config");
    const doc = Bun.YAML.parse(userData as string) as Record<string, unknown>;
    // Only write_files: top-level ssh_authorized_keys or users would also put
    // the key on the image's default sudo user, where revocation never looks.
    // A top-level ssh_pwauth would meet Contabo's own in a merge nobody has
    // checked; the SSH drop-in decides without it.
    expect(Object.keys(doc)).toEqual(["write_files"]);
    const files = doc.write_files as Record<string, unknown>[];
    // The run key and the SSH hardening, nothing else.
    expect(files.map((f) => f.path).sort()).toEqual(
      ["/root/.ssh/authorized_keys", HARDENING.dropin].sort(),
    );
    return files;
  }

  /** The authorized_keys entry's key lines. */
  function keyFileEntry(body: Record<string, unknown> | null) {
    const entry = writtenFiles(body).find(
      (f) => f.path === "/root/.ssh/authorized_keys",
    )!;
    // Append, never replace: the image may already carry lines there.
    expect(entry.append).toBe(true);
    expect(entry.owner).toBe("root:root");
    expect(entry.permissions).toBe("0600");
    expect(entry).not.toHaveProperty("defer");
    expect(entry).not.toHaveProperty("encoding");
    const content = entry.content as string;
    expect(content.endsWith("\n")).toBe(true);
    return content.split("\n").filter((line) => line !== "");
  }

  /**
   * The SSH hardening drop-in must hold from the first boot (task 9d95cd14):
   * Contabo's cloud-config sets a root password and turns password logins on
   * through 50-cloud-init.conf, and sshd keeps the first value it reads. So the
   * file is the one the installer's harden step owns, and it passes that step's
   * own effectiveness check by itself.
   */
  function expectHardeningEntry(body: Record<string, unknown> | null) {
    const entry = writtenFiles(body).find((f) => f.path === HARDENING.dropin)!;
    // Replace, not append, and not deferred to the final stage: it has to be
    // on disk before cloud-init's password step restarts sshd.
    expect(entry.append ?? false).toBe(false);
    expect(entry.defer ?? false).toBe(false);
    expect(entry).not.toHaveProperty("encoding");
    expect(entry.owner).toBe("root:root");
    expect(entry.permissions).toBe("0644");
    expect(typeof entry.content).toBe("string");
    // sshd keywords are case-insensitive, and the first value read wins, so
    // only the first line for a keyword counts.
    const first = new Map<string, string>();
    for (const raw of (entry.content as string).split("\n")) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) continue;
      const [keyword, ...rest] = line.split(/\s+/);
      const key = keyword.toLowerCase();
      // One line per keyword: a repeat is dead text that misleads a reader.
      expect(first.has(key)).toBe(false);
      first.set(key, rest.join(" "));
    }
    // Exactly the keywords the harden step checks: anything more (a
    // PubkeyAuthentication no, say) could lock the provisioner out.
    expect([...first.keys()].sort()).toEqual(
      [...HARDENING.required.keys()].sort(),
    );
    for (const [key, accepted] of HARDENING.required) {
      expect(accepted).toContain(first.get(key)!.toLowerCase());
    }
  }

  const lineOf = (k: SshPublicKey) => `${k.algorithm} ${k.blob} isomux-cp`;

  test("create sends no key-store reference, writes each key as a bare line in root's authorized_keys, and turns off SSH passwords from the first boot", async () => {
    const { adapter, sent } = capturing("root", [
      { status: 201, body: { data: [{ instanceId: 42 }] } },
    ]);
    const out = await adapter.create({
      intentId: INTENT,
      plan: "V153",
      region: "EU",
      publicKeys: [KEY, SK_KEY],
    });
    expect(out).toEqual({ outcome: "created", providerId: "42" });
    expect(sent.map((s) => s.method)).toEqual(["POST"]);
    expect(keyFileEntry(sent[0].body)).toEqual([lineOf(KEY), lineOf(SK_KEY)]);
    expectHardeningEntry(sent[0].body);
    expect(sent[0].body!.defaultUser).toBe("root");
  });

  test("reinstall sends the same user data, SSH hardening included, and no key-store reference", async () => {
    const { adapter, sent } = capturing("root", [{ status: 200, body: {} }]);
    await adapter.reinstall("4711", {
      imageId: "image-uuid",
      publicKeys: [KEY],
      loginUser: "root",
    });
    expect(sent.map((s) => [s.method, new URL(s.url).pathname])).toEqual([
      ["PUT", "/v1/compute/instances/4711"],
    ]);
    expect(keyFileEntry(sent[0].body)).toEqual([lineOf(KEY)]);
    expectHardeningEntry(sent[0].body);
  });

  test("no keys: the body carries no user data and no key-store reference", async () => {
    const { adapter, sent } = capturing("root", [
      { status: 201, body: { data: [{ instanceId: 42 }] } },
      { status: 200, body: {} },
    ]);
    await adapter.create({
      intentId: INTENT,
      plan: "V153",
      region: "EU",
      publicKeys: [],
    });
    await adapter.reinstall("4711", {
      imageId: "image-uuid",
      publicKeys: [],
      loginUser: "root",
    });
    expect(sent.length).toBe(2);
    for (const { body } of sent) {
      expect(body).not.toHaveProperty("userData");
      expect(body).not.toHaveProperty("sshKeys");
      expect(body).not.toHaveProperty("rootPassword");
    }
  });

  test("a login user other than root is refused before any paid call", async () => {
    // Only root's file is ours to revoke from; /home/<user> does not exist yet
    // when write_files runs.
    for (const loginUser of ["admin", "administrator"] as const) {
      const { adapter, sent } = capturing(loginUser, []);
      const refused: string[] = [];
      try {
        await adapter.create({
          intentId: INTENT,
          plan: "V153",
          region: "EU",
          publicKeys: [KEY],
        });
      } catch {
        refused.push("create");
      }
      try {
        await adapter.reinstall("4711", {
          imageId: "image-uuid",
          publicKeys: [KEY],
          loginUser,
        });
      } catch {
        refused.push("reinstall");
      }
      expect([loginUser, refused, sent.length]).toEqual([
        loginUser,
        ["create", "reinstall"],
        0,
      ]);
    }
  });

  test("a key that is not one algorithm and one base64 blob is refused before any paid call", async () => {
    const bad: SshPublicKey[] = [
      { algorithm: "ssh-dss", blob: KEY.blob },
      { algorithm: "ssh-ed25519", blob: "BBBBC3NzaC1lZDI1NTE5" },
      { algorithm: "ssh-ed25519", blob: `${KEY.blob}\nruncmd: [reboot]` },
      { algorithm: "ssh-ed25519", blob: `${KEY.blob} extra` },
      { algorithm: "ssh-ed25519\nruncmd: [reboot]", blob: KEY.blob },
      { algorithm: 'command="sh" ssh-ed25519', blob: KEY.blob },
      { algorithm: "", blob: KEY.blob },
      { algorithm: "ssh-ed25519", blob: "" },
    ];
    for (const key of bad) {
      const { adapter, sent } = capturing("root", []);
      let threw = false;
      try {
        await adapter.create({
          intentId: INTENT,
          plan: "V153",
          region: "EU",
          publicKeys: [KEY, key],
        });
      } catch {
        threw = true;
      }
      expect([key, threw, sent.length]).toEqual([key, true, 0]);
    }
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

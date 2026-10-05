// The webhook registry over a temp dir: records, secrets, file modes, and the
// loud failure on a corrupt file. Routes and auth are in
// server/test-support/routes-webhooks-rest.test.ts.

import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { atomicWriteFileSync } from "../persistence.ts";
import {
  WEBHOOK_MAX_HOOKS,
  WEBHOOK_MAX_RULE_FIELD_CHARS,
  WebhookRegistryError,
  createWebhookRegistry,
  validateWebhookFields,
  type WebhookFields,
} from "./registry.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempRegistryDir(): string {
  const root = mkdtempSync(join(tmpdir(), "webhook-registry-"));
  dirs.push(root);
  return join(root, "webhooks");
}

const fields = (over: Partial<WebhookFields> = {}): WebhookFields => ({
  name: "pr-review",
  scheme: "github-hmac-sha256",
  signatureHeader: null,
  eventHeader: null,
  deliveryHeader: null,
  rules: [{ event: "pull_request", match: { action: "opened" } }],
  target: { kind: "agent", agentId: "agent-1" },
  enabled: true,
  ...over,
});

const owner = {
  userId: "u1",
  username: "nil",
  createdBy: "nil",
};

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof WebhookRegistryError
      ? err.code
      : "not-a-registry-error";
  }
  return undefined;
}

describe("webhook registry: files", () => {
  it("a missing directory is an office with no hooks", () => {
    const registry = createWebhookRegistry({ dir: tempRegistryDir() });
    expect(registry.list()).toEqual([]);
    expect(registry.get("wh_0123456789abcdef")).toBeNull();
  });

  it("keeps the secret out of webhooks.json, in a 0600 file in a 0700 dir", () => {
    const dir = tempRegistryDir();
    const registry = createWebhookRegistry({ dir });
    const hook = registry.create({ fields: fields(), ...owner });
    expect(hook.id).toMatch(/^wh_[0-9a-f]{16}$/);
    const secret = registry.readSecret(hook.id)!;
    // 32 random bytes, base64url.
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(join(dir, "webhooks.json"), "utf-8")).not.toContain(
      secret,
    );
    expect(statSync(join(dir, "secrets.json")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(registry.secretState(hook.id)).toBe("set");
    // A second instance reads the same state: no in-memory cache.
    expect(createWebhookRegistry({ dir }).get(hook.id)).toEqual(hook);
  });

  it("a corrupt webhooks.json fails every operation loudly and is not overwritten", () => {
    const dir = tempRegistryDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "webhooks.json"), "{not json");
    const registry = createWebhookRegistry({ dir });
    expect(codeOf(() => registry.list())).toBe("registry_corrupt");
    expect(codeOf(() => registry.get("wh_0123456789abcdef"))).toBe(
      "registry_corrupt",
    );
    expect(codeOf(() => registry.create({ fields: fields(), ...owner }))).toBe(
      "registry_corrupt",
    );
    expect(readFileSync(join(dir, "webhooks.json"), "utf-8")).toBe("{not json");
  });

  it("a record that breaks a rule is corruption, not a skipped row", () => {
    const dir = tempRegistryDir();
    const registry = createWebhookRegistry({ dir });
    registry.create({ fields: fields(), ...owner });
    const file = join(dir, "webhooks.json");
    const stored = JSON.parse(readFileSync(file, "utf-8"));
    stored.webhooks[0].target.note = "<b>";
    writeFileSync(file, JSON.stringify(stored));
    expect(codeOf(() => registry.list())).toBe("registry_corrupt");
  });

  it("a corrupt secrets.json fails loudly", () => {
    const dir = tempRegistryDir();
    const registry = createWebhookRegistry({ dir });
    const hook = registry.create({ fields: fields(), ...owner });
    writeFileSync(join(dir, "secrets.json"), "[]");
    expect(codeOf(() => registry.secretState(hook.id))).toBe(
      "registry_corrupt",
    );
  });
});

describe("webhook registry: lifecycle", () => {
  it("names are unique and the office holds at most WEBHOOK_MAX_HOOKS", () => {
    const registry = createWebhookRegistry({ dir: tempRegistryDir() });
    registry.create({ fields: fields(), ...owner });
    expect(codeOf(() => registry.create({ fields: fields(), ...owner }))).toBe(
      "name_taken",
    );
    for (let i = 1; i < WEBHOOK_MAX_HOOKS; i++) {
      registry.create({ fields: fields({ name: `hook-${i}` }), ...owner });
    }
    expect(
      codeOf(() =>
        registry.create({ fields: fields({ name: "one-more" }), ...owner }),
      ),
    ).toBe("webhook_limit_reached");
  });

  it("update replaces the fields and keeps the identity and the owner", () => {
    const registry = createWebhookRegistry({ dir: tempRegistryDir() });
    const hook = registry.create({ fields: fields(), ...owner });
    const other = registry.create({
      fields: fields({ name: "other" }),
      ...owner,
    });
    const updated = registry.update(hook.id, fields({ enabled: false }))!;
    expect(updated).toEqual({ ...hook, enabled: false });
    expect(
      codeOf(() => registry.update(hook.id, fields({ name: other.name }))),
    ).toBe("name_taken");
    expect(registry.update("wh_ffffffffffffffff", fields())).toBeNull();
  });

  it("rotate replaces the secret; remove drops the secret, the record and the directory", () => {
    const dir = tempRegistryDir();
    const registry = createWebhookRegistry({ dir });
    const hook = registry.create({ fields: fields(), ...owner });
    const before = registry.readSecret(hook.id)!;
    const rotated = registry.rotateSecret(hook.id)!;
    expect(rotated).not.toBe(before);
    expect(registry.readSecret(hook.id)).toBe(rotated);

    mkdirSync(join(dir, hook.id), { recursive: true });
    writeFileSync(join(dir, hook.id, "deliveries.json"), "[]");
    expect(registry.remove(hook.id)).toEqual(hook);
    expect(registry.list()).toEqual([]);
    expect(registry.readSecret(hook.id)).toBeNull();
    expect(readFileSync(join(dir, "secrets.json"), "utf-8")).not.toContain(
      rotated,
    );
    expect(existsSync(join(dir, hook.id))).toBe(false);
    expect(registry.remove(hook.id)).toBeNull();
    expect(registry.rotateSecret(hook.id)).toBeNull();
  });

  it("a hook whose secret is gone (a restore) reads as missing until a rotate", () => {
    const dir = tempRegistryDir();
    const registry = createWebhookRegistry({ dir });
    const hook = registry.create({ fields: fields(), ...owner });
    rmSync(join(dir, "secrets.json"));
    expect(registry.secretState(hook.id)).toBe("missing");
    expect(registry.readSecret(hook.id)).toBeNull();
    registry.rotateSecret(hook.id);
    expect(registry.secretState(hook.id)).toBe("set");
  });

  it("reads delivery rows newest first, bounded by the limit", () => {
    const dir = tempRegistryDir();
    const registry = createWebhookRegistry({ dir });
    const hook = registry.create({ fields: fields(), ...owner });
    mkdirSync(join(dir, hook.id), { recursive: true });
    const rows = [1, 2, 3].map((n) => ({ id: `d_${n}`, receivedAt: n }));
    writeFileSync(join(dir, hook.id, "deliveries.json"), JSON.stringify(rows));
    expect(registry.readDeliveries(hook.id, 2).map((r) => r.id)).toEqual([
      "d_3",
      "d_2",
    ]);
    expect(registry.readDeliveries("wh_ffffffffffffffff", 5)).toEqual([]);
  });
});

describe("webhook fields: validation", () => {
  const valid = {
    name: "pr-review",
    scheme: "github-hmac-sha256",
    signatureHeader: null,
    eventHeader: null,
    deliveryHeader: null,
    rules: [],
    target: { kind: "agent", agentId: "agent-1" },
    enabled: true,
  };
  const refusal = (over: Record<string, unknown>) =>
    codeOf(() => validateWebhookFields({ ...valid, ...over }));

  it("accepts a minimal hook and normalizes header names and the note", () => {
    expect(
      validateWebhookFields({
        ...valid,
        scheme: "hmac-sha256",
        signatureHeader: "X-Signature",
        target: {
          kind: "agent",
          agentId: "agent-1",
          note: "line one\nline two",
        },
      }),
    ).toEqual({
      ...valid,
      scheme: "hmac-sha256",
      signatureHeader: "x-signature",
      rules: [],
      target: { kind: "agent", agentId: "agent-1", note: "line one line two" },
    } as WebhookFields);
  });

  it("refuses each broken field with its own code", () => {
    expect(refusal({ name: "Bad_Name" })).toBe("invalid_name");
    expect(refusal({ scheme: "jwt" })).toBe("invalid_scheme");
    expect(refusal({ signatureHeader: "x-signature" })).toBe("invalid_headers");
    expect(refusal({ scheme: "hmac-sha256" })).toBe("invalid_headers");
    expect(
      refusal({ scheme: "hmac-sha256", signatureHeader: "bad header" }),
    ).toBe("invalid_headers");
    expect(refusal({ rules: [{ event: "" }] })).toBe("invalid_rules");
    expect(refusal({ rules: [{ event: "push", extra: 1 }] })).toBe(
      "invalid_rules",
    );
    expect(refusal({ rules: [{ event: "push", args: { Repo: "x" } }] })).toBe(
      "invalid_rules",
    );
    expect(
      refusal({ rules: Array.from({ length: 21 }, () => ({ event: "*" })) }),
    ).toBe("invalid_rules");
    expect(refusal({ target: { kind: "room", roomId: "r1" } })).toBe(
      "invalid_target",
    );
    expect(
      refusal({ target: { kind: "agent", agentId: "a", note: "<script>" } }),
    ).toBe("invalid_note");
    expect(refusal({ enabled: "yes" })).toBe("invalid_request");
  });

  it("keeps a rule event raw: no character rule, no reduction", () => {
    const rules = [{ event: "pull request/v2 ✓" }];
    expect(validateWebhookFields({ ...valid, rules }).rules).toEqual(rules);
  });

  it("bounds each match path, match value and template at WEBHOOK_MAX_RULE_FIELD_CHARS", () => {
    const at = "a".repeat(WEBHOOK_MAX_RULE_FIELD_CHARS);
    const over = at + "a";
    const rule = (r: Record<string, unknown>) => ({
      rules: [{ event: "*", ...r }],
    });
    expect(refusal(rule({ match: { [at]: at }, args: { x: at } }))).toBe(
      undefined,
    );
    expect(refusal(rule({ match: { [over]: "v" } }))).toBe(
      "rule_field_too_long",
    );
    expect(refusal(rule({ match: { path: over } }))).toBe(
      "rule_field_too_long",
    );
    expect(refusal(rule({ args: { x: over } }))).toBe("rule_field_too_long");
  });
});

describe("webhook registry: a failed write leaves a consistent state", () => {
  // A writer that fails on the Nth write to `file` and otherwise writes.
  function failingOn(file: string) {
    let armed = false;
    return {
      arm: () => (armed = true),
      writeFile: (path: string, data: string, mode?: number) => {
        if (armed && path.endsWith(file)) throw new Error("disk full");
        atomicWriteFileSync(path, data, mode);
      },
    };
  }

  it("a create whose record write fails leaves no hook and no secret", () => {
    const dir = tempRegistryDir();
    const writer = failingOn("webhooks.json");
    const registry = createWebhookRegistry({
      dir,
      writeFile: writer.writeFile,
    });
    const kept = registry.create({
      fields: fields({ name: "kept" }),
      ...owner,
    });
    writer.arm();
    expect(codeOf(() => registry.create({ fields: fields(), ...owner }))).toBe(
      "persist_failed",
    );
    // A fresh instance reads only what is on disk.
    const reread = createWebhookRegistry({ dir });
    expect(reread.list()).toEqual([kept]);
    const secrets = JSON.parse(
      readFileSync(join(dir, "secrets.json"), "utf-8"),
    );
    expect(Object.keys(secrets)).toEqual([kept.id]);
  });

  it("a create whose secret write fails leaves no hook", () => {
    const dir = tempRegistryDir();
    const writer = failingOn("secrets.json");
    const registry = createWebhookRegistry({
      dir,
      writeFile: writer.writeFile,
    });
    writer.arm();
    expect(codeOf(() => registry.create({ fields: fields(), ...owner }))).toBe(
      "persist_failed",
    );
    expect(createWebhookRegistry({ dir }).list()).toEqual([]);
  });

  it("a delete whose record write fails leaves the hook, without its secret, and a retry finishes", () => {
    const dir = tempRegistryDir();
    const writer = failingOn("webhooks.json");
    const registry = createWebhookRegistry({
      dir,
      writeFile: writer.writeFile,
    });
    const hook = registry.create({ fields: fields(), ...owner });
    writer.arm();
    expect(codeOf(() => registry.remove(hook.id))).toBe("persist_failed");
    const reread = createWebhookRegistry({ dir });
    expect(reread.list()).toEqual([hook]);
    expect(reread.secretState(hook.id)).toBe("missing");
    expect(reread.remove(hook.id)).toEqual(hook);
    expect(reread.list()).toEqual([]);
  });
});

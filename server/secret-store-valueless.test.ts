// A restored member's secrets come back without their values (task 321e7b8e):
// the shape is kept at the removal, the value is not. A secret without a value
// reaches nothing: no proxy snapshot, no app, no MCP header, no Show. Setting
// a value (Rotate) makes it a plain secret again.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSecretStore,
  type SecretScope,
  type SecretShape,
} from "./secret-store.ts";

const VALUE = "fake-linear-value-0001";
const OTHER = "fake-linear-value-0002";
const MIA: SecretScope = { kind: "user", userId: "u-mia" };
const BOB: SecretScope = { kind: "user", userId: "u-bob" };

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function store() {
  const root = mkdtempSync(join(tmpdir(), "isomux-secret-valueless-"));
  roots.push(root);
  return { root, store: createSecretStore(root) };
}

const body = (name: string, value = VALUE, over = {}) => ({
  name,
  value,
  hosts: ["mcp.example.com"],
  form: { kind: "authorization" },
  ...over,
});

// Every file under `dir`, as text.
function allText(dir: string): string {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
    .join("\n");
}

describe("exporting the shapes at a removal", () => {
  it("keeps name, hosts, form, note, apps and times, and never a value", () => {
    const { store: s } = store();
    expect(
      s.create(
        MIA,
        body("LINEAR_TOKEN", VALUE, {
          note: "For the Linear MCP server.",
          apps: [{ name: "bot", createdAt: 1_000 }],
        }),
      ).ok,
    ).toBe(true);
    const [shape] = s.exportShapes("u-mia", []);
    expect(shape).toMatchObject({
      name: "LINEAR_TOKEN",
      hosts: ["mcp.example.com"],
      form: { kind: "authorization" },
      note: "For the Linear MCP server.",
      apps: [{ name: "bot", createdAt: 1_000 }],
    });
    expect(typeof shape.createdAt).toBe("number");
    expect(typeof shape.updatedAt).toBe("number");
    expect(Object.keys(shape).sort()).toEqual(
      [
        "apps",
        "createdAt",
        "form",
        "hosts",
        "name",
        "note",
        "updatedAt",
      ].sort(),
    );
    expect(JSON.stringify(shape)).not.toContain(VALUE);
  });

  it("leaves out the names an MCP sign-in wrote, and other members' secrets", () => {
    const { store: s } = store();
    s.create(MIA, body("LINEAR_TOKEN"));
    s.create(MIA, body("MCP_REFRESH_LINEAR", OTHER));
    s.create(BOB, body("BOB_TOKEN"));
    expect(
      s.exportShapes("u-mia", ["MCP_REFRESH_LINEAR"]).map((x) => x.name),
    ).toEqual(["LINEAR_TOKEN"]);
  });

  it("a member with no secrets exports none", () => {
    const { store: s } = store();
    expect(s.exportShapes("u-mia", [])).toEqual([]);
  });
});

describe("a secret without a value, after a restore", () => {
  function restored() {
    const t = store();
    t.store.create(MIA, body("LINEAR_TOKEN", VALUE, { note: "For Linear." }));
    const shapes: SecretShape[] = t.store.exportShapes("u-mia", []);
    t.store.removeMember("u-mia");
    t.store.importShapes("u-mia", shapes);
    return t;
  }

  it("is listed with its shape, marked as needing a value", () => {
    const { store: s } = restored();
    const [wire] = s.list(MIA);
    expect(wire).toMatchObject({
      name: "LINEAR_TOKEN",
      hosts: ["mcp.example.com"],
      note: "For Linear.",
      needsValue: true,
    });
  });

  it("reaches nothing: not in the proxy snapshot, and no value to read", () => {
    const { store: s } = restored();
    expect(s.readForProxy(MIA).map((x) => x.name)).toEqual([]);
    expect(s.readSecretValues(MIA, "LINEAR_TOKEN")).toBeNull();
  });

  it("keeps no value on disk, also after a reload, and never an empty string", () => {
    const { root } = restored();
    expect(allText(root)).not.toContain(VALUE);
    const again = createSecretStore(root);
    expect(again.list(MIA)[0]?.needsValue).toBe(true);
    expect(again.readForProxy(MIA)).toEqual([]);
    expect(again.readSecretValues(MIA, "LINEAR_TOKEN")).toBeNull();
    expect(
      readFileSync(join(root, "secrets", "users", "u-mia.json"), "utf8"),
    ).not.toContain('"value":""');
  });

  it("a new value makes it a plain secret again", () => {
    const { store: s } = restored();
    expect(s.rotate(MIA, "LINEAR_TOKEN", OTHER).ok).toBe(true);
    expect(s.list(MIA)[0]?.needsValue).toBeUndefined();
    expect(s.readSecretValues(MIA, "LINEAR_TOKEN")?.value).toBe(OTHER);
    expect(s.readForProxy(MIA).map((x) => [x.name, x.value])).toEqual([
      ["LINEAR_TOKEN", OTHER],
    ]);
  });

  it("a live secret of the same name wins over an imported shape", () => {
    const { store: s } = store();
    s.create(MIA, body("LINEAR_TOKEN", OTHER));
    s.importShapes("u-mia", [
      {
        name: "LINEAR_TOKEN",
        hosts: ["other.example.com"],
        form: { kind: "authorization" },
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    expect(s.list(MIA)).toHaveLength(1);
    expect(s.list(MIA)[0]?.needsValue).toBeUndefined();
    expect(s.readSecretValues(MIA, "LINEAR_TOKEN")).toMatchObject({
      value: OTHER,
      hosts: ["mcp.example.com"],
    });
  });

  it("a new secret still needs a value: create refuses one without", () => {
    const { store: s } = store();
    for (const value of [undefined, null, ""]) {
      const change = s.create(MIA, { ...body("NEW_TOKEN"), value });
      expect({ value, ok: change.ok }).toEqual({ value, ok: false });
    }
    expect(s.list(MIA)).toEqual([]);
  });

  it("other secrets of the member keep their values", () => {
    const { store: s } = restored();
    s.create(MIA, body("SECOND_TOKEN", OTHER));
    expect(s.readForProxy(MIA).map((x) => x.name)).toEqual(["SECOND_TOKEN"]);
    expect(s.list(MIA).map((x) => [x.name, x.needsValue ?? false])).toEqual([
      ["LINEAR_TOKEN", true],
      ["SECOND_TOKEN", false],
    ]);
  });
});

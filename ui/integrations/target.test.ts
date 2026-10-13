import { describe, expect, it } from "bun:test";
import { en } from "../../shared/i18n/en.ts";
import { translatorFor } from "../../shared/i18n/translate.ts";
import {
  basePath,
  canEdit,
  canShowSecret,
  summaryOnly,
  whose,
} from "./target.ts";

const office = { kind: "office" } as const;
const self = { kind: "self", username: "Ann Lee" } as const;
const member = { kind: "member", username: "Stephen" } as const;

describe("targets", () => {
  it("routes each target to its own base path", () => {
    expect(basePath(office)).toBe("/api/office");
    expect(basePath(self)).toBe("/api/users/Ann%20Lee");
    expect(basePath(member)).toBe("/api/users/Stephen");
  });

  it("lets owners change the office's and a member's items, and a member only their own", () => {
    expect([canEdit(office, "owner"), canEdit(office, "member")]).toEqual([
      true,
      false,
    ]);
    expect([canEdit(self, "owner"), canEdit(self, "member")]).toEqual([
      true,
      true,
    ]);
    expect(canEdit(member, "owner")).toBe(true);
    expect([
      summaryOnly(office, "member"),
      summaryOnly(office, "owner"),
    ]).toEqual([true, false]);
  });

  it("shows a value to its own member and an office value to an owner, never a member's to an owner", () => {
    expect(canShowSecret(self, "member")).toBe(true);
    expect(canShowSecret(self, "owner")).toBe(true);
    expect(canShowSecret(office, "owner")).toBe(true);
    expect(canShowSecret(office, "member")).toBe(false);
    expect(canShowSecret(member, "owner")).toBe(false);
  });
});

describe("whose", () => {
  // Every sentence base that has a ".self" form has all three, so no target
  // falls back to a raw key.
  it("has the self, member and office form of every sentence", () => {
    const keys = Object.keys(en);
    const bases = keys
      .filter((key) => key.startsWith("integrations.") && key.endsWith(".self"))
      .map((key) => key.slice(0, -".self".length));
    expect(bases.length).toBeGreaterThan(5);
    for (const base of bases) {
      expect(keys).toContain(`${base}.member`);
      expect(keys).toContain(`${base}.office`);
      expect(en[`${base}.member` as keyof typeof en]).toContain("{member}");
    }
  });

  it("names the member only on a member's target", () => {
    const { t } = translatorFor("en");
    const vars = { name: "GH_TOKEN" };
    expect(whose(t, "integrations.dialog.remove", member, vars)).toBe(
      t("integrations.dialog.remove.member", { member: "Stephen", ...vars }),
    );
    expect(whose(t, "integrations.dialog.remove", member, vars)).toContain(
      "Stephen",
    );
    expect(whose(t, "integrations.dialog.remove", self, vars)).toBe(
      t("integrations.dialog.remove.self", vars),
    );
    expect(whose(t, "integrations.dialog.remove", office, vars)).toBe(
      t("integrations.dialog.remove.office", vars),
    );
  });
});

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const WEB = path.join(import.meta.dir, "web");
const form = fs.readFileSync(
  path.join(WEB, "components/signup-form.tsx"),
  "utf8",
);
const page = fs.readFileSync(path.join(WEB, "app/signup/page.tsx"), "utf8");
const route = fs.readFileSync(
  path.join(WEB, "app/api/signup/route.ts"),
  "utf8",
);

describe("the signup private-key boundary", () => {
  test("the visible private key is unnamed and only the public line enters FormData", () => {
    const privateTextarea = form.match(
      /<textarea[\s\S]*?data-testid="server-administrator-private-key"[\s\S]*?\/>/,
    )?.[0];
    expect(privateTextarea).toBeDefined();
    expect(privateTextarea).not.toMatch(/\bname=/);
    expect(privateTextarea).toContain("readOnly");
    expect(privateTextarea).toContain(
      'value={revealed ? (key?.privateKey ?? "") : ""}',
    );
    const appended = form.indexOf("document.body.append(link)");
    const clicked = form.indexOf("link.click()", appended);
    const removed = form.indexOf("link.remove()", clicked);
    const revoked = form.indexOf(
      "setTimeout(() => URL.revokeObjectURL(url), 0)",
      removed,
    );
    expect(appended).toBeGreaterThan(0);
    expect(clicked).toBeGreaterThan(appended);
    expect(removed).toBeGreaterThan(clicked);
    expect(revoked).toBeGreaterThan(removed);
    expect(form).toContain('form.set("customerSshKey", key.publicKey)');
    expect(form).not.toContain('form.set("customerSshKey", key.privateKey)');
  });

  test("the server page receives no key prop and continuation renders no key field", () => {
    expect(page).not.toContain("privateKey=");
    expect(page).not.toContain("customerSshKey");
    expect(page).toContain('name="officeName" value={state.officeName}');
  });

  test("a keyless initial request is refused before the reservation service", () => {
    const refusal = route.indexOf("if (!customerSshKey)");
    const signup = route.indexOf("await signUpOffice");
    expect(refusal).toBeGreaterThan(0);
    expect(signup).toBeGreaterThan(refusal);
  });

  test("explicit intent selects continuation, which refuses a key and keeps the reserved name", () => {
    expect(route).toContain('field("signupIntent")');
    const continuation = route.slice(
      route.indexOf('if (signupIntent === "continue")'),
      route.indexOf("if (!customerSshKey)"),
    );
    expect(continuation).toContain(
      "if (customerSshKey) return new Response(null, { status: 400 })",
    );
    expect(continuation).toContain('state.kind !== "continue"');
    expect(continuation).toContain("if (officeName !== state.officeName)");
    expect(continuation).toContain(
      "await continueSignup(accountId, officeName)",
    );
  });
});

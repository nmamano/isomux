import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const home = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const signup = readFileSync(
  new URL("../app/signup/page.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);

test("account controls sit above the dashboard title", () => {
  expect(home.indexOf('className="account-line"')).toBeLessThan(
    home.indexOf(
      '<h1>{offices.length > 1 ? "Your offices" : "Your office"}</h1>',
    ),
  );
});

test("signup links back to the signed-in office page", () => {
  expect(signup).toContain('<Link href="/">&larr; Your office</Link>');
  expect(signup.indexOf('className="back-link"')).toBeLessThan(
    signup.indexOf("<h1>Set up your office</h1>"),
  );
});

test("copied feedback keeps a gap from the copy button", () => {
  const rule = styles.match(/\.form \.copy-status \{[\s\S]*?\n\}/)?.[0];
  expect(rule).toContain("right: 166px;");
  expect(styles.match(/\.copy-status/g)).toHaveLength(2);
});

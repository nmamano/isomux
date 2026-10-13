// The Test button and its result line (ported from the Settings
// ConnectionsList tests): one run at a time, the account or the tool count on
// success, and a reason that names the host on failure.

import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { setApiShim } = await import("../api.ts");
const { TestButton, TestResult, useConnectionTest } =
  await import("./ConnectionTest.tsx");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
afterAll(() => setApiShim(null));

const { t, tn } = translatorFor("en");

function Harness({ path }: { path: string }) {
  const { test, run } = useConnectionTest(path);
  return createElement(
    "div",
    null,
    createElement(TestButton, { test, run: () => void run() }),
    createElement(TestResult, { test }),
  );
}

it("runs one test at a time and reports each answer", async () => {
  let answer: unknown = {
    result: {
      ok: true,
      kind: "secret",
      host: "api.github.com",
      account: "octocat",
    },
  };
  let fails = false;
  let release = () => {};
  const sent: string[] = [];
  setApiShim(async (method, path) => {
    sent.push(`${method} ${path}`);
    await new Promise<void>((resolve) => (release = resolve));
    if (fails) throw new Error("gone");
    return answer;
  });
  const view = render(
    createElement(Harness, { path: "/api/office/secrets/GH_TOKEN" }),
  );
  const button = view.container.querySelector<HTMLButtonElement>(
    "[data-connection-test]",
  )!;
  const result = () =>
    view.container.querySelector<HTMLElement>("[data-connection-test-result]");

  await act(async () => fireEvent.click(button));
  expect(button.disabled).toBe(true);
  expect(button.textContent).toBe(t("settings.connections.test.running"));
  await act(async () => fireEvent.click(button));
  await act(async () => release());
  expect(sent).toEqual(["POST /api/office/secrets/GH_TOKEN/test"]);
  expect(result()?.dataset.connectionTestResult).toBe("ok");
  expect(result()?.textContent).toBe(
    `${t("settings.connections.test.works")} · octocat`,
  );

  answer = {
    result: {
      ok: true,
      kind: "mcp",
      host: "wiki.example.com",
      server: "Wiki",
      tools: 3,
    },
  };
  await act(async () => fireEvent.click(button));
  await act(async () => release());
  expect(result()?.textContent).toBe(
    `${t("settings.connections.test.works")} · Wiki · ${tn("settings.connections.test.tools", 3)}`,
  );

  for (const [reason, key] of [
    ["refused", "settings.connections.test.refused"],
    ["forbidden", "settings.connections.test.forbidden"],
    ["timeout", "settings.connections.test.timeout"],
    ["unreachable", "settings.connections.test.unreachable"],
  ] as const) {
    answer = { result: { ok: false, host: "api.github.com", reason } };
    await act(async () => fireEvent.click(button));
    await act(async () => release());
    expect(result()?.dataset.connectionTestResult).toBe("failed");
    expect(result()?.textContent).toBe(t(key, { host: "api.github.com" }));
  }

  answer = {
    result: {
      ok: false,
      host: "api.github.com",
      reason: "status",
      status: 500,
    },
  };
  await act(async () => fireEvent.click(button));
  await act(async () => release());
  expect(result()?.textContent).toBe(
    t("settings.connections.test.status", {
      host: "api.github.com",
      status: "500",
    }),
  );

  // The request itself fails (for example, the secret was just removed).
  fails = true;
  await act(async () => fireEvent.click(button));
  await act(async () => release());
  expect(result()?.dataset.connectionTestResult).toBe("error");
  expect(result()?.textContent).toBe(
    t("settings.connections.test.requestFailed"),
  );
});

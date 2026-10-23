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
const { IDENTITY_CHECKS } = await import("../../server/connection-tests.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
afterAll(() => setApiShim(null));

const { t, tn } = translatorFor("en");

// The result's words, without its (?).
function words(el: HTMLElement | null): string | null {
  if (!el) return null;
  const copy = el.cloneNode(true) as HTMLElement;
  copy.querySelector("[data-help-tip]")?.parentElement?.remove();
  return copy.textContent;
}

// The (?)'s text, opened by a click, or null when the result has none.
async function helpText(el: HTMLElement | null): Promise<string | null> {
  const tip = el?.querySelector<HTMLButtonElement>("[data-help-tip]");
  if (!tip) return null;
  await act(async () => fireEvent.click(tip));
  return el!.querySelector('[role="note"]')?.textContent ?? null;
}

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
  expect(words(result())).toBe(
    `${t("settings.connections.test.works")} · octocat`,
  );
  // What Works means, as the call the test made.
  expect(await helpText(result())).toBe(
    t("settings.connections.test.help.github"),
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
  expect(words(result())).toBe(
    `${t("settings.connections.test.works")} · Wiki · ${tn("settings.connections.test.tools", 3)}`,
  );
  expect(await helpText(result())).toBe(
    t("settings.connections.test.help.mcp"),
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
    expect(await helpText(result())).toBeNull();
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

it("explains Works for every secret the server can test, by its host", async () => {
  // What the result says for one host: whether it has a (?), and its text.
  const helpFor = async (host: string) => {
    setApiShim(async () => ({
      result: { ok: true, kind: "secret", host, account: null },
    }));
    const view = render(
      createElement(Harness, { path: "/api/office/secrets/X" }),
    );
    await act(async () =>
      fireEvent.click(view.container.querySelector("[data-connection-test]")!),
    );
    const result = view.container.querySelector<HTMLElement>(
      "[data-connection-test-result]",
    );
    expect(result?.dataset.connectionTestResult, host).toBe("ok");
    const text = await helpText(result);
    view.unmount();
    return text;
  };
  const hosts = Object.values(IDENTITY_CHECKS).map((check) => check.host);
  expect(hosts.length).toBeGreaterThan(0);
  const helps = new Set<string>();
  for (const host of hosts) {
    const text = await helpFor(host);
    expect(text, host).not.toBeNull();
    helps.add(text!);
  }
  // Each check explains its own call.
  expect(helps.size).toBe(hosts.length);
  // A host with no test of its own: no (?), rather than a wrong one.
  expect(await helpFor("api.other.com")).toBeNull();
});

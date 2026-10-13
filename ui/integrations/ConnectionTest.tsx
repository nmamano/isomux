// The Test button of a secret or an MCP server row, and the line that reports
// its result (integrations A3). The server runs the test; a result names hosts
// only, and the service-authored account or server name renders as text.

import { useState, type CSSProperties } from "react";
import type {
  ConnectionTestRes,
  ConnectionTestResult,
} from "../../shared/contract-shapes.ts";
import { apiFetch } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { Btn } from "./kit.tsx";

export type TestState =
  | { state: "idle" }
  | { state: "running" }
  | { state: "done"; result: ConnectionTestResult }
  | { state: "failed" };

// One test per row. `path` is the item's route; the test is `${path}/test`.
export function useConnectionTest(path: string) {
  const [test, setTest] = useState<TestState>({ state: "idle" });
  async function run() {
    if (test.state === "running") return;
    setTest({ state: "running" });
    try {
      const { result } = await apiFetch<ConnectionTestRes>(
        "POST",
        `${path}/test`,
      );
      setTest(
        result && typeof result.ok === "boolean"
          ? { state: "done", result }
          : { state: "failed" },
      );
    } catch {
      setTest({ state: "failed" });
    }
  }
  return { test, run };
}

export function TestButton({
  test,
  run,
}: {
  test: TestState;
  run: () => void;
}) {
  const { t } = useI18n();
  const running = test.state === "running";
  return (
    <Btn small disabled={running} onClick={run} data-connection-test>
      {running
        ? t("settings.connections.test.running")
        : t("settings.connections.test.button")}
    </Btn>
  );
}

const resultStyle = (ok: boolean): CSSProperties => ({
  fontSize: 12,
  margin: "6px 0 0",
  color: ok ? "var(--green-text)" : "var(--red-text)",
  overflowWrap: "anywhere",
});

export function TestResult({ test }: { test: TestState }) {
  const { t, tn } = useI18n();
  if (test.state === "idle" || test.state === "running") return null;
  if (test.state === "failed")
    return (
      <div data-connection-test-result="error" style={resultStyle(false)}>
        {t("settings.connections.test.requestFailed")}
      </div>
    );
  const { result } = test;
  if (!result.ok) {
    const host = result.host ?? "";
    let text: string;
    switch (result.reason) {
      case "refused":
        text = t("settings.connections.test.refused", { host });
        break;
      case "forbidden":
        text = t("settings.connections.test.forbidden", { host });
        break;
      case "no_credential":
        text = t("settings.connections.test.noCredential", { host });
        break;
      case "status":
        text = t("settings.connections.test.status", {
          host,
          status: String(result.status ?? ""),
        });
        break;
      case "redirect":
        text = t("settings.connections.test.redirect", { host });
        break;
      case "timeout":
        text = t("settings.connections.test.timeout", { host });
        break;
      case "unreachable":
        text = t("settings.connections.test.unreachable", { host });
        break;
      case "needs_oauth":
        text = t("settings.connections.test.needsOauth", { host });
        break;
      case "not_testable":
        text = t("settings.connections.test.noHostTest");
        break;
      default:
        text = t("settings.connections.test.unexpected", { host });
    }
    return (
      <div data-connection-test-result="failed" style={resultStyle(false)}>
        {text}
      </div>
    );
  }
  const parts = [t("settings.connections.test.works")];
  if (result.kind === "mcp") {
    if (result.server) parts.push(result.server);
    parts.push(tn("settings.connections.test.tools", result.tools));
  } else if (result.account) parts.push(result.account);
  return (
    <div data-connection-test-result="ok" style={resultStyle(true)}>
      {parts.join(" · ")}
    </div>
  );
}

// The Test button of a secret or an MCP server row, and the line that reports
// its result (integrations A3). The server runs the test; a result names hosts
// only, and the service-authored account or server name renders as text.

import { useState, type CSSProperties, type ReactNode } from "react";
import type {
  ConnectionTestRes,
  ConnectionTestResult,
} from "../../shared/contract-shapes.ts";
import { apiFetch } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { Btn, Data } from "./kit.tsx";

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
  const { t, tn, rich } = useI18n();
  if (test.state === "idle" || test.state === "running") return null;
  if (test.state === "failed")
    return (
      <div data-connection-test-result="error" style={resultStyle(false)}>
        {t("settings.connections.test.requestFailed")}
      </div>
    );
  const { result } = test;
  if (!result.ok) {
    const host = <Data>{result.host ?? ""}</Data>;
    let text: ReactNode;
    switch (result.reason) {
      case "refused":
        text = rich("settings.connections.test.refused", { host });
        break;
      case "forbidden":
        text = rich("settings.connections.test.forbidden", { host });
        break;
      case "no_credential":
        text = rich("settings.connections.test.noCredential", { host });
        break;
      case "status":
        text = rich("settings.connections.test.status", {
          host,
          status: String(result.status ?? ""),
        });
        break;
      case "redirect":
        text = rich("settings.connections.test.redirect", { host });
        break;
      case "timeout":
        text = rich("settings.connections.test.timeout", { host });
        break;
      case "unreachable":
        text = rich("settings.connections.test.unreachable", { host });
        break;
      case "needs_oauth":
        text = rich("settings.connections.test.needsOauth", { host });
        break;
      case "not_testable":
        text = t("settings.connections.test.noHostTest");
        break;
      default:
        text = rich("settings.connections.test.unexpected", { host });
    }
    return (
      <div data-connection-test-result="failed" style={resultStyle(false)}>
        {text}
      </div>
    );
  }
  // Service-authored names: rendered as text only.
  const named =
    result.kind === "mcp" ? (result.server ?? null) : (result.account ?? null);
  return (
    <div data-connection-test-result="ok" style={resultStyle(true)}>
      {t("settings.connections.test.works")}
      {named && (
        <>
          {" · "}
          <Data>{named}</Data>
        </>
      )}
      {result.kind === "mcp" &&
        ` · ${tn("settings.connections.test.tools", result.tools)}`}
    </div>
  );
}

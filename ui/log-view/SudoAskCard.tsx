// An agent's request to run one command as root, as an ask
// (server/sudo-requests.ts, task 43a28eed). The office owner it is for reads
// the whole command and types the server account's password in a masked
// field here; the server gives it to sudo and forgets it. Run or Decline
// closes the ask. The typed password lives in this component's state only,
// in no draft, and is cleared on each answer.

import { useState } from "react";

import type { AskMemberWire, SudoAskRequest } from "../../shared/types.ts";
import { apiFetch, ApiError } from "../api.ts";
import { useI18n, type UiTranslator } from "../i18n.tsx";
import { useAppState, useDispatch } from "../store.tsx";
import { timeSince } from "../../shared/i18n/time.ts";
import {
  dialogInput,
  dialogLabel,
  dialogSaveBtn,
  filledSecondaryBtn,
} from "../components/dialog-styles.ts";
import { MaskedInput } from "../components/MaskedInput.tsx";
import { AskAboutButton } from "./AskAboutButton.tsx";
import { AskIdChip } from "./AskIdChip.tsx";
import { InlineMarkdown } from "../members-chat/InlineMarkdown.tsx";
import { noTranslate } from "../no-translate.ts";

// The card's title, which the collapsed stack shows too.
export function sudoAskTitle(t: UiTranslator["t"]): string {
  return t("cards.sudoRequest.title");
}

const hintStyle = {
  fontSize: 12,
  color: "var(--text-secondary)",
  margin: "0 0 8px",
} as const;

export function SudoAskCard({
  entry,
  sudo,
  isMobile,
  onFocusAgent,
  onChatAgent,
}: {
  entry: AskMemberWire;
  sudo: SudoAskRequest;
  isMobile: boolean;
  onFocusAgent?: (agentId: string) => void;
  onChatAgent?: (agentId: string) => void;
}) {
  const { t, language } = useI18n();
  const dispatch = useDispatch();
  const { agents, users } = useAppState();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agent = agents.find((a) => a.id === entry.agentId);
  const manager = agent?.userId
    ? [...users.values()].find((user) => user.id === agent.userId)?.name
    : undefined;
  const since = timeSince(language, entry.createdAt);
  const age = since.kind === "now" ? t("common.justNow") : since.text;
  const base = `/api/agents/${encodeURIComponent(entry.agentId)}/sudo-requests/${encodeURIComponent(sudo.requestId)}`;

  function errorText(caught: unknown, kind: "run" | "decline"): string {
    const failed =
      kind === "run"
        ? t("cards.sudoRequest.runFailed")
        : t("cards.secretRequest.declineFailed");
    if (!(caught instanceof ApiError)) return failed;
    const detail = caught.detail ?? {};
    if (caught.code === "not_started")
      return t("cards.sudoRequest.notStarted", {
        reason: typeof detail.reason === "string" ? detail.reason : "",
        attempts: String(
          typeof detail.attemptsLeft === "number" ? detail.attemptsLeft : 0,
        ),
      });
    if (caught.code === "invalid_password")
      return t("cards.sudoRequest.invalidPassword");
    if (caught.code === "run_in_progress")
      return t("cards.sudoRequest.runInProgress");
    if (caught.code === "forbidden") return t("cards.secretRequest.forbidden");
    return failed;
  }

  async function answer(kind: "run" | "decline") {
    const typed = password;
    setPassword("");
    setBusy(true);
    setError(null);
    try {
      if (kind === "run")
        await apiFetch("POST", `${base}/run`, { password: typed });
      else await apiFetch("POST", `${base}/decline`);
      dispatch({ type: "ask_removed", id: entry.id });
    } catch (caught) {
      // 404: the request closed elsewhere (the agent's withdraw, the last
      // refused attempt); the push removes it too.
      if (caught instanceof ApiError && caught.status === 404) {
        dispatch({ type: "ask_removed", id: entry.id });
        return;
      }
      setError(errorText(caught, kind));
      setBusy(false);
    }
  }

  const fontSize = isMobile ? 14 : 13;
  const canRun = !busy && password !== "";

  return (
    <div
      data-ask={entry.id}
      data-sudo-request={sudo.requestId}
      style={{
        padding: isMobile ? "9px 10px 10px 11px" : "8px 10px 9px 11px",
        borderRadius: 8,
        background: "var(--bg-subtle)",
        border: "1px solid var(--border-light)",
        borderLeft: "3px solid var(--red)",
        marginBottom: 6,
        fontFamily: "var(--font-ui)",
        fontSize,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            fontWeight: 650,
            color: "var(--text-primary)",
            marginBottom: 4,
            overflowWrap: "break-word",
          }}
        >
          {sudoAskTitle(t)}
        </div>
        {!isMobile && <AskIdChip id={entry.id} isMobile={isMobile} />}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            flexShrink: 0,
          }}
        >
          <span
            style={{ color: "var(--text-ghost)", fontSize: isMobile ? 12 : 11 }}
          >
            {age}
          </span>
          {isMobile && <AskIdChip id={entry.id} isMobile={isMobile} />}
        </div>
      </div>
      <p style={hintStyle}>
        {manager
          ? t("cards.sudoRequest.byAgentOf", {
              agent: agent?.name ?? entry.agentId,
              manager,
            })
          : t("cards.sudoRequest.byAgent", {
              agent: agent?.name ?? entry.agentId,
            })}
      </p>
      {/* The whole command, never cut: what the member reads is what runs. */}
      <pre
        data-sudo-command=""
        {...noTranslate()}
        style={{
          margin: "0 0 6px",
          padding: "6px 8px",
          borderRadius: 6,
          background: "var(--tool-call-bg)",
          fontFamily: "monospace",
          fontSize: 12,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          color: "var(--text-primary)",
        }}
      >
        {sudo.command}
      </pre>
      <p style={hintStyle}>
        {t("cards.sudoRequest.cwd")}{" "}
        <code {...noTranslate()} style={{ overflowWrap: "anywhere" }}>
          {sudo.cwd}
        </code>
      </p>
      <p style={hintStyle} {...noTranslate()}>
        <InlineMarkdown content={entry.prompt} code />
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (canRun) void answer("run");
        }}
      >
        <label style={{ display: "block", marginBottom: 8 }}>
          <span style={dialogLabel}>{t("cards.sudoRequest.password")}</span>
          <MaskedInput
            value={password}
            disabled={busy}
            style={dialogInput}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <p style={hintStyle}>{t("cards.sudoRequest.hint")}</p>
        {error && (
          <p role="alert" style={{ ...hintStyle, color: "var(--red-text)" }}>
            {error}
          </p>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="submit" style={dialogSaveBtn} disabled={!canRun}>
            {busy ? t("cards.sudoRequest.running") : t("cards.sudoRequest.run")}
          </button>
          <button
            type="button"
            style={filledSecondaryBtn}
            disabled={busy}
            onClick={() => void answer("decline")}
          >
            {t("cards.secretRequest.decline")}
          </button>
          <AskAboutButton
            entry={entry}
            style={filledSecondaryBtn}
            disabled={busy}
            onFocusAgent={onFocusAgent}
            onChatAgent={onChatAgent}
          />
        </div>
      </form>
    </div>
  );
}

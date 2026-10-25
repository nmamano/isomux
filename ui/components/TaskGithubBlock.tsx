import { useEffect, useState } from "react";
import { apiFetch } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { noTranslate } from "../no-translate.ts";
import { dialogHint, dialogLabel } from "./dialog-styles.ts";
import {
  parseIssueData,
  type GithubIssueData,
} from "../../shared/github-issue.ts";
import type { PlainMessageKey } from "../../shared/i18n/translate.ts";
import type {
  TaskDetailExternal,
  TaskExternal,
  TaskItem,
} from "../../shared/types.ts";

function stateKey(
  external: Pick<TaskExternal, "state" | "stateReason">,
): PlainMessageKey {
  if (external.state === "open") return "tasks.github.state.open";
  if (external.stateReason === "not_planned")
    return "tasks.github.state.notPlanned";
  if (external.stateReason === "duplicate")
    return "tasks.github.state.duplicate";
  return "tasks.github.state.completed";
}

// The row chip for a task imported from a GitHub issue. A click opens the
// issue, never the task.
export function TaskGithubChip({ external }: { external: TaskExternal }) {
  const { t } = useI18n();
  return (
    <a
      {...noTranslate()}
      data-task-github-chip
      href={external.url}
      target="_blank"
      rel="noopener noreferrer"
      title={t("tasks.github.chipTitle")}
      onClick={(e) => e.stopPropagation()}
      style={{
        fontSize: 10,
        fontWeight: 700,
        fontFamily: "var(--font-ui)",
        color: "var(--text-dim)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 4,
        padding: "1px 5px",
        marginRight: 6,
        whiteSpace: "nowrap",
        textDecoration: "none",
      }}
    >
      {external.repo}#{external.number}
    </a>
  );
}

// The read-only GitHub issue in the task detail (task 7fc83592). The text
// comes from GET /api/tasks/:id inside its outside-data wrapper, and shows as
// plain text.
export function TaskGithubBlock({ task }: { task: TaskItem }) {
  const { t } = useI18n();
  const [detail, setDetail] = useState<{
    external: TaskDetailExternal;
    issue: GithubIssueData | null;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiFetch<TaskItem & { external?: TaskDetailExternal }>(
      "GET",
      `/api/tasks/${task.id}`,
    )
      .then((r) => {
        if (cancelled || !r.external) return;
        setDetail({
          external: r.external,
          issue: r.external.issue ? parseIssueData(r.external.issue) : null,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [task.id, task.version]);
  if (!detail) return null;
  const { external, issue } = detail;
  return (
    <div data-task-github data-syncing={String(external.syncing)}>
      <label style={dialogLabel}>{t("tasks.github.heading")}</label>
      <div
        style={{
          border: "1px solid var(--border-subtle)",
          borderRadius: 6,
          padding: "8px 10px",
          fontSize: 12,
          color: "var(--text-primary)",
        }}
      >
        <div
          {...noTranslate()}
          style={{ fontSize: 11, color: "var(--text-dim)" }}
        >
          <a href={external.url} target="_blank" rel="noopener noreferrer">
            {external.repo}#{external.number}
          </a>
          {" · "}
          <span translate="yes">{t(stateKey(external))}</span>
          {issue?.author ? ` · ${issue.author}` : ""}
        </div>
        {issue && (
          <>
            <div {...noTranslate()} style={{ fontWeight: 600, marginTop: 6 }}>
              {issue.title}
            </div>
            {issue.labels.length > 0 && (
              <div
                {...noTranslate()}
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 4,
                  marginTop: 4,
                }}
              >
                {issue.labels.map((label) => (
                  <span
                    key={label}
                    style={{
                      fontSize: 10,
                      border: "1px solid var(--border-subtle)",
                      borderRadius: 4,
                      padding: "0 5px",
                      color: "var(--text-dim)",
                    }}
                  >
                    {label}
                  </span>
                ))}
              </div>
            )}
            <div
              {...noTranslate()}
              data-task-github-body
              style={{
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                marginTop: 6,
                maxHeight: 240,
                overflowY: "auto",
              }}
            >
              {issue.body}
            </div>
          </>
        )}
      </div>
      <p style={{ ...dialogHint, marginTop: 4 }}>
        {t(
          external.syncing ? "tasks.github.syncing" : "tasks.github.notSyncing",
        )}
      </p>
    </div>
  );
}

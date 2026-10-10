import { dialogInput, dialogLabel, dialogCancelBtn } from "./dialog-styles.ts";
import { useEffect, useState } from "react";
import { apiFetch } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import type { AuditEntry, AuditPage, TaskHistory } from "../../shared/audit.ts";

function AuditRows({
  items,
  restore,
  onError,
}: {
  items: AuditEntry[];
  restore?: boolean;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const [restored, setRestored] = useState<number[]>([]);
  return (
    <ol style={{ paddingLeft: 20, overflowWrap: "anywhere" }}>
      {items.map((entry) => (
        <li key={entry.sequence} style={{ marginBottom: 16 }}>
          <div>
            {new Date(entry.time).toLocaleString()} · {entry.actor.name} ·{" "}
            {entry.operation}
          </div>
          <div>{entry.targets.join(", ")}</div>
          {entry.taskChanges ? (
            <dl>
              {Object.entries(entry.taskChanges).map(([field, values]) => (
                <div key={field}>
                  <dt>{field}</dt>
                  <dd style={{ whiteSpace: "pre-wrap" }}>
                    {JSON.stringify(values.old)} → {JSON.stringify(values.new)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <div>{entry.fields.join(", ")}</div>
          )}
          {entry.memoryContent !== undefined && (
            <pre style={{ whiteSpace: "pre-wrap" }}>{entry.memoryContent}</pre>
          )}
          {restore && entry.deletedTask && (
            <button
              style={dialogCancelBtn}
              disabled={restored.includes(entry.sequence)}
              onClick={() => {
                void apiFetch(
                  "POST",
                  `/api/tasks/${encodeURIComponent(entry.deletedTask!.id)}/restore`,
                )
                  .then(() => setRestored((old) => [...old, entry.sequence]))
                  .catch((error) => onError(String(error)));
              }}
            >
              {restored.includes(entry.sequence)
                ? t("audit.restored")
                : t("audit.restore")}
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}
export function AuditPane() {
  const { t } = useI18n();
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [refresh, setRefresh] = useState(0);
  const requestKey = `${query}:${refresh}`;
  const [page, setPage] = useState<AuditPage>({ items: [], nextBefore: null });
  const [error, setError] = useState("");
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null);
  const loading = loadedQuery !== requestKey;
  useEffect(() => {
    let live = true;
    apiFetch<AuditPage>("GET", `/api/audit-log?${query}`)
      .then((result) => {
        if (live) {
          setPage(result);
          setError("");
        }
      })
      .catch((error) => {
        if (live) setError(String(error));
      })
      .finally(() => {
        if (live) setLoadedQuery(requestKey);
      });
    return () => {
      live = false;
    };
  }, [query, requestKey]);
  return (
    <section style={{ padding: 20 }}>
      <h2>{t("audit.title")}</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const params = new URLSearchParams();
          for (const [key, value] of Object.entries(filters))
            if (value) params.set(key, value);
          setQuery(params.toString());
          setRefresh((value) => value + 1);
        }}
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "end",
          marginBottom: 16,
        }}
      >
        {(
          [
            "actorKind",
            "actorId",
            "ownerId",
            "targetId",
            "operation",
            "from",
            "to",
          ] as const
        ).map((key) => (
          <label key={key} style={dialogLabel}>
            {t(`audit.${key}`)}
            <input
              value={filters[key] ?? ""}
              onChange={(event) =>
                setFilters({ ...filters, [key]: event.target.value })
              }
              style={{ ...dialogInput, display: "block", width: 150 }}
            />
          </label>
        ))}
        <button type="submit" style={dialogCancelBtn}>
          {t("audit.filter")}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {loading ? (
        <p>{t("audit.loading")}</p>
      ) : (
        <AuditRows items={page.items} restore onError={setError} />
      )}
      {page.nextBefore !== null && (
        <button
          style={dialogCancelBtn}
          onClick={() => {
            const params = new URLSearchParams(query);
            params.set("before", String(page.nextBefore));
            setQuery(params.toString());
          }}
        >
          {t("audit.older")}
        </button>
      )}
    </section>
  );
}
export function TaskHistoryList({
  id,
  version,
}: {
  id: string;
  version: string;
}) {
  return <TaskHistoryDisclosure key={`${id}:${version}`} id={id} />;
}
function TaskHistoryDisclosure({ id }: { id: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <details
      onToggle={(event) => setOpen(event.currentTarget.open)}
      style={{ marginTop: 4 }}
    >
      <summary style={{ ...HINT, cursor: "pointer" }}>
        {t("audit.history")}
      </summary>
      {open && <TaskHistoryContent id={id} />}
    </details>
  );
}
function TaskHistoryContent({ id }: { id: string }) {
  const { t } = useI18n();
  const [history, setHistory] = useState<TaskHistory | null>(null);
  const [before, setBefore] = useState<number | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    apiFetch<TaskHistory>(
      "GET",
      `/api/tasks/${encodeURIComponent(id)}/history${before === null ? "" : `?before=${before}`}`,
    )
      .then((value) => {
        if (live) setHistory(value);
      })
      .catch((error) => {
        if (live) setError(String(error));
      });
    return () => {
      live = false;
    };
  }, [id, before]);
  return (
    <div style={{ marginTop: 6 }}>
      {error && (
        <div role="alert" style={{ ...HINT, color: "var(--red-text)" }}>
          {error}
        </div>
      )}
      {history?.items.map((entry) => (
        <TaskHistoryEntry key={entry.sequence} entry={entry} />
      ))}
      {history && history.nextBefore !== null && (
        <button
          type="button"
          style={{ ...dialogCancelBtn, marginTop: 6 }}
          onClick={() => {
            setBefore(history.nextBefore);
            setHistory(null);
            setError("");
          }}
        >
          {t("audit.older")}
        </button>
      )}
    </div>
  );
}

const HINT = {
  fontSize: 11,
  color: "var(--text-hint)",
  fontFamily: "'JetBrains Mono',monospace",
} as const;

// Fields shown as "old -> new"; any other changed field shows as edited.
const VALUE_FIELDS = ["status", "priority", "assignee", "title"] as const;
const FIELD_LABEL = {
  title: "tasks.field.title",
  description: "tasks.field.description",
  priority: "tasks.field.priority",
  status: "tasks.field.status",
  assignee: "tasks.field.assignee",
  roomId: "tasks.field.room",
} as const;
const STATUS_LABEL = {
  open: "tasks.status.open",
  in_progress: "tasks.status.inProgress",
  done: "tasks.status.done",
  obsolete: "tasks.status.obsolete",
} as const;
// Bookkeeping fields that every write touches; they say nothing to a reader.
const HIDDEN_FIELDS = new Set([
  "id",
  "version",
  "createdAt",
  "createdBy",
  "username",
  "updatedAt",
]);

// One line per write, e.g. "Nil P2 → P1". The time is in the tooltip.
function TaskHistoryEntry({ entry }: { entry: AuditEntry }) {
  const { t, language } = useI18n();
  const show = (field: string, value: unknown): string => {
    if (value === null || value === undefined || value === "") return "—";
    if (
      field === "status" &&
      typeof value === "string" &&
      value in STATUS_LABEL
    )
      return t(STATUS_LABEL[value as keyof typeof STATUS_LABEL]);
    return typeof value === "string" ? value : JSON.stringify(value);
  };
  const parts: React.ReactNode[] = [];
  if (entry.operation === "tasks.create") parts.push(t("audit.taskCreated"));
  else if (entry.operation === "tasks.delete")
    parts.push(t("audit.taskDeleted"));
  else if (entry.operation === "tasks.restore")
    parts.push(t("audit.taskRestored"));
  else {
    const changes = entry.taskChanges ?? {};
    const fields = entry.taskChanges ? Object.keys(changes) : entry.fields;
    for (const field of fields) {
      if (HIDDEN_FIELDS.has(field)) continue;
      const change = changes[field];
      if (change && (VALUE_FIELDS as readonly string[]).includes(field))
        parts.push(
          <>
            {show(field, change.old)}
            <span style={{ color: "var(--text-hint)", margin: "0 4px" }}>
              →
            </span>
            <span style={{ color: "var(--text)" }}>
              {show(field, change.new)}
            </span>
          </>,
        );
      else {
        const label =
          field in FIELD_LABEL
            ? t(FIELD_LABEL[field as keyof typeof FIELD_LABEL])
            : field;
        parts.push(
          t("audit.fieldEdited", { field: label.toLocaleLowerCase(language) }),
        );
      }
    }
  }
  return (
    <div
      title={new Date(entry.time).toLocaleString(language)}
      style={{
        fontSize: 12,
        color: "var(--text-dim)",
        marginTop: 4,
        overflowWrap: "anywhere",
      }}
    >
      <span style={{ color: "var(--accent)", fontWeight: 600, marginRight: 6 }}>
        {entry.actor.name}
      </span>
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 && ", "}
          {part}
        </span>
      ))}
    </div>
  );
}

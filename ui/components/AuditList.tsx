import { dialogInput, dialogLabel, dialogCancelBtn } from "./dialog-styles.ts";
import { useEffect, useId, useState } from "react";
import { apiFetch } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { useAppState } from "../store.tsx";
import { AUDIT_OPERATIONS } from "../audit-operations.ts";
import { AUDIT_ACTOR_KINDS } from "../../shared/audit.ts";
import type { MemoryScope } from "../../shared/types.ts";
import type {
  PlainMessageKey,
  Translator,
} from "../../shared/i18n/translate.ts";
import type {
  AuditActorKind,
  AuditEntry,
  AuditPage,
  TaskHistory,
} from "../../shared/audit.ts";

const ACTOR_KIND_LABEL: Record<AuditActorKind, PlainMessageKey> = {
  member: "audit.kind.member",
  agent: "audit.kind.agent",
  api_token: "audit.kind.apiToken",
  cronjob: "audit.kind.cronjob",
  webhook: "audit.kind.webhook",
  admin_cli: "audit.kind.adminCli",
  setup: "audit.kind.setup",
  app: "audit.kind.app",
  secret_proxy: "audit.kind.secretProxy",
  auto_handoff: "audit.kind.autoHandoff",
};
const MEMORY_LABEL: Record<MemoryScope, PlainMessageKey> = {
  office: "audit.memory.office",
  room: "audit.memory.room",
  agent: "audit.memory.agent",
  boss: "audit.memory.member",
} as const;

function targetName(
  id: string,
  entry: AuditEntry,
  names: Map<string, string>,
  t: Translator["t"],
): React.ReactNode {
  if (entry.deletedTask?.id === id && entry.deletedTask.title)
    return entry.deletedTask.title;
  if (names.has(id)) return names.get(id)!;
  if (
    entry.operation.startsWith("tasks.") &&
    typeof entry.taskChanges?.title?.new === "string"
  )
    return entry.taskChanges.title.new;
  if (id.startsWith("memory:")) {
    const [, scope, ...parts] = id.split(":");
    const scopeId = parts.join(":");
    if (scope && scope in MEMORY_LABEL)
      return (
        <>
          <span style={HINT}>
            {t(MEMORY_LABEL[scope as keyof typeof MEMORY_LABEL])}
          </span>
          {scope !== "office" && <> · {names.get(scopeId) ?? scopeId}</>}
        </>
      );
  }
  return id;
}

function AuditRows({
  items,
  restore,
  onError,
  names,
}: {
  items: AuditEntry[];
  names: Map<string, string>;
  restore?: boolean;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const [restored, setRestored] = useState<number[]>([]);
  return (
    <ol style={{ paddingLeft: 20, overflowWrap: "anywhere" }}>
      {items.map((entry) => (
        <li key={entry.sequence} style={{ marginBottom: 16 }}>
          <div style={{ ...HINT, marginBottom: 6 }}>
            {new Date(entry.time).toLocaleString()} ·{" "}
            <span title={entry.actor.id}>
              {entry.actor.name || names.get(entry.actor.id) || entry.actor.id}
            </span>{" "}
            · {entry.operation}
          </div>
          <div>
            {entry.targets.map((id, index) => (
              <span key={id} title={id}>
                {index > 0 && ", "}
                {targetName(id, entry, names, t)}
              </span>
            ))}
          </div>
          {entry.operation.startsWith("tasks.") ? (
            <TaskChanges entry={entry} />
          ) : (
            <div style={HINT}>{entry.fields.join(", ")}</div>
          )}
          {typeof entry.secretUse?.host === "string" &&
            typeof entry.secretUse.method === "string" &&
            typeof entry.secretUse.path === "string" && (
              <div style={HINT}>
                {entry.secretUse.method} {entry.secretUse.host}
                {entry.secretUse.path}
              </div>
            )}
          {entry.memoryContent !== undefined && (
            <pre style={{ whiteSpace: "pre-wrap" }}>{entry.memoryContent}</pre>
          )}
          {entry.promptContent !== undefined && (
            <pre style={{ whiteSpace: "pre-wrap" }}>{entry.promptContent}</pre>
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
  const state = useAppState();
  const members = [...state.users.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const names = new Map<string, string>([
    ...members.map((item) => [item.id, item.name] as [string, string]),
    ...state.agents.map((item) => [item.id, item.name] as [string, string]),
    ...state.rooms.map((item) => [item.id, item.name] as [string, string]),
    ...state.tasks.map((item) => [item.id, item.title] as [string, string]),
    ...state.cronjobs.map((item) => [item.id, item.name] as [string, string]),
    ...state.webhooks.map((item) => [item.id, item.name] as [string, string]),
    ...state.apps.map((item) => [item.name, item.name] as [string, string]),
  ]);
  const listId = useId();
  const [filterError, setFilterError] = useState("");
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
          const from = filters.from
            ? new Date(filters.from).getTime()
            : undefined;
          const to = filters.to
            ? new Date(filters.to).getTime() + 59_999
            : undefined;
          if (
            [from, to].some(
              (value) =>
                value !== undefined && (!Number.isFinite(value) || value < 0),
            ) ||
            (from !== undefined && to !== undefined && from > to)
          ) {
            setFilterError(t("audit.invalidRange"));
            return;
          }
          setFilterError("");
          for (const [key, value] of Object.entries(filters))
            if (value && key !== "from" && key !== "to") params.set(key, value);
          if (from !== undefined) params.set("from", String(from));
          if (to !== undefined) params.set("to", String(to));
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
        ).map((key) => {
          const memberControl =
            key === "ownerId" ||
            (key === "actorId" && filters.actorKind === "member");
          const change = (value: string) =>
            setFilters((old) => ({
              ...old,
              [key]: value,
              ...(key === "actorKind" ? { actorId: "" } : {}),
            }));
          const options =
            key === "actorKind"
              ? AUDIT_ACTOR_KINDS.map((kind) => ({
                  id: kind,
                  name: t(ACTOR_KIND_LABEL[kind]),
                }))
              : members;
          return (
            <label
              key={key}
              style={{ ...dialogLabel, flex: "1 1 200px", minWidth: 0 }}
            >
              {t(`audit.${key}`)}
              {key === "actorKind" || memberControl ? (
                <select
                  name={key}
                  value={filters[key] ?? ""}
                  onChange={(event) => change(event.target.value)}
                  style={{ ...dialogInput, display: "block" }}
                >
                  <option value="">{t("audit.any")}</option>
                  {options.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  name={key}
                  type={
                    key === "from" || key === "to" ? "datetime-local" : "text"
                  }
                  step={key === "from" || key === "to" ? 60 : undefined}
                  list={
                    key === "operation"
                      ? `${listId}-operations`
                      : key === "targetId"
                        ? `${listId}-targets`
                        : key === "actorId"
                          ? `${listId}-actors`
                          : undefined
                  }
                  value={filters[key] ?? ""}
                  onChange={(event) => change(event.target.value)}
                  style={{ ...dialogInput, display: "block", minWidth: 0 }}
                />
              )}
            </label>
          );
        })}
        <datalist id={`${listId}-operations`}>
          {AUDIT_OPERATIONS.map((operation) => (
            <option key={operation} value={operation} />
          ))}
        </datalist>
        <datalist id={`${listId}-targets`}>
          {[...names].map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </datalist>
        <datalist id={`${listId}-actors`}>
          {(filters.actorKind === "agent" ? state.agents : []).map((actor) => (
            <option key={actor.id} value={actor.id}>
              {actor.name}
            </option>
          ))}
        </datalist>
        <div style={{ display: "flex", gap: 8, flexBasis: "100%" }}>
          <button type="submit" style={dialogCancelBtn}>
            {t("audit.filter")}
          </button>
          <button
            type="button"
            style={dialogCancelBtn}
            onClick={() => {
              setFilters({});
              setQuery("");
              setFilterError("");
              setRefresh((value) => value + 1);
            }}
          >
            {t("audit.clear")}
          </button>
        </div>
        {filterError && (
          <p role="alert" style={{ width: "100%", color: "var(--red-text)" }}>
            {filterError}
          </p>
        )}
      </form>
      {error && <p role="alert">{error}</p>}
      {loading ? (
        <p>{t("audit.loading")}</p>
      ) : (
        <AuditRows
          items={page.items}
          names={names}
          restore
          onError={setError}
        />
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

// The actor sits above full-width changes. Interface words
// (field names, "edited", "created") use the small mono hint style so they never
// read as task content; old and new values use the content font, the old one
// struck through. The time is in the tooltip.
function TaskChanges({ entry }: { entry: AuditEntry }) {
  const { t } = useI18n();
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
  const label = (field: string) =>
    field in FIELD_LABEL
      ? t(FIELD_LABEL[field as keyof typeof FIELD_LABEL])
      : field;
  const rows: { label?: string; body: React.ReactNode }[] = [];
  const word = (text: string) => <span style={HINT}>{text}</span>;
  if (entry.operation === "tasks.create")
    rows.push({ body: word(t("audit.taskCreated")) });
  else if (entry.operation === "tasks.delete")
    rows.push({ body: word(t("audit.taskDeleted")) });
  else if (entry.operation === "tasks.restore")
    rows.push({ body: word(t("audit.taskRestored")) });
  else {
    const changes = entry.taskChanges ?? {};
    const fields = entry.taskChanges ? Object.keys(changes) : entry.fields;
    for (const field of fields) {
      if (HIDDEN_FIELDS.has(field)) continue;
      const change = changes[field];
      rows.push({
        label: label(field),
        body:
          change && (VALUE_FIELDS as readonly string[]).includes(field) ? (
            <span
              style={{
                display: "grid",
                width: field === "title" ? "100%" : "fit-content",
                maxWidth: "100%",
                gridTemplateColumns:
                  field === "title"
                    ? "1fr"
                    : "minmax(0, 1fr) 16px minmax(0, 1fr)",
                gap: 4,
                alignItems: "baseline",
              }}
            >
              <span
                style={{
                  color: "var(--text-secondary)",
                  textDecoration: "line-through",
                  textDecorationColor: "var(--text-hint)",
                  ...(field === "title" ? { paddingLeft: 20 } : {}),
                }}
              >
                {show(field, change.old)}
              </span>
              {field === "title" ? (
                <span
                  style={{
                    display: "grid",
                    gridTemplateColumns: "16px minmax(0, 1fr)",
                    gap: 4,
                  }}
                >
                  <span
                    aria-hidden
                    style={{ color: "var(--accent)", fontWeight: 700 }}
                  >
                    →
                  </span>
                  <span style={{ color: "var(--text)" }}>
                    {show(field, change.new)}
                  </span>
                </span>
              ) : (
                <>
                  <span
                    aria-hidden
                    style={{ color: "var(--accent)", fontWeight: 700 }}
                  >
                    →
                  </span>
                  <span style={{ color: "var(--text)" }}>
                    {show(field, change.new)}
                  </span>
                </>
              )}
            </span>
          ) : (
            word(t("audit.edited"))
          ),
      });
    }
  }
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr)",
        gap: 6,
        fontSize: 12,
        marginTop: 6,
        overflowWrap: "anywhere",
      }}
    >
      {rows.map((row, index) => (
        <div key={index}>
          {row.label && (
            <span
              style={{
                ...HINT,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                display: "block",
                marginBottom: 3,
              }}
            >
              {row.label}
            </span>
          )}
          {row.body}
        </div>
      ))}
    </div>
  );
}

function TaskHistoryEntry({ entry }: { entry: AuditEntry }) {
  const { language } = useI18n();
  return (
    <div
      title={new Date(entry.time).toLocaleString(language)}
      style={{
        borderTop: "1px solid var(--border)",
        paddingTop: 8,
        marginTop: 6,
        fontSize: 12,
        overflowWrap: "anywhere",
      }}
    >
      <div style={{ color: "var(--accent)", fontWeight: 600 }}>
        {entry.actor.name}
      </div>
      <TaskChanges entry={entry} />
    </div>
  );
}

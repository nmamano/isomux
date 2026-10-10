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
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{t("audit.history")}</summary>
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
    <>
      {error && <p role="alert">{error}</p>}
      {history && (
        <>
          <p>
            {history.createdBy} · {new Date(history.createdAt).toLocaleString()}
          </p>
          <AuditRows items={history.items} onError={setError} />
          {history.nextBefore !== null && (
            <button
              type="button"
              style={dialogCancelBtn}
              onClick={() => {
                setBefore(history.nextBefore);
                setHistory(null);
                setError("");
              }}
            >
              {t("audit.older")}
            </button>
          )}
        </>
      )}
    </>
  );
}

import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { noTranslate } from "../no-translate.ts";
import {
  dialogCancelBtn,
  dialogHint,
  dialogInput,
  dialogLabel,
  dialogSaveBtn,
  disabledLook,
} from "./dialog-styles.ts";
import type { PlainMessageKey } from "../../shared/i18n/translate.ts";
import type { GithubLinkStatus, GithubLinkWire } from "../../shared/types.ts";

// Same default as the server's DEFAULT_GITHUB_SYNC_SECRET.
const DEFAULT_SECRET = "GITHUB_SYNC_TOKEN";

const STATUS_TEXT: Record<string, PlainMessageKey> = {
  pending: "settings.room.github.status.pending",
  ok: "settings.room.github.status.ok",
  "paused:missing": "settings.room.github.status.missing",
  "paused:host": "settings.room.github.status.host",
  "paused:refused": "settings.room.github.status.refused",
  "paused:no_access": "settings.room.github.status.noAccess",
  waiting: "settings.room.github.status.waiting",
  error: "settings.room.github.status.error",
};

function statusKey(status: GithubLinkStatus): PlainMessageKey {
  return (
    STATUS_TEXT[`${status.kind}:${status.reason}`] ??
    STATUS_TEXT[status.kind] ??
    STATUS_TEXT.error
  );
}

// A room's GitHub issue link (task 7fc83592), in Room settings, for office
// owners only. It saves on its own: the link is not part of the room's PATCH.
export function RoomGithubLink({ roomId }: { roomId: string }) {
  const { t } = useI18n();
  const [link, setLink] = useState<GithubLinkWire | null>(null);
  const [repo, setRepo] = useState("");
  const [labels, setLabels] = useState("");
  const [collaboratorsOnly, setCollaboratorsOnly] = useState(false);
  const [secretName, setSecretName] = useState(DEFAULT_SECRET);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function show(next: GithubLinkWire | null) {
    setLink(next);
    setRepo(next?.repo ?? "");
    setLabels(next ? next.labels.join(", ") : "");
    setCollaboratorsOnly(next?.collaboratorsOnly ?? false);
    setSecretName(next?.secretName ?? DEFAULT_SECRET);
  }

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ link: GithubLinkWire | null }>(
      "GET",
      `/api/rooms/${roomId}/github-link`,
    )
      .then((r) => {
        if (!cancelled) show(r.link);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(async () => {
      const saved = await apiFetch<{ link: GithubLinkWire }>(
        "PUT",
        `/api/rooms/${roomId}/github-link`,
        {
          repo: repo.trim(),
          labels: labels
            .split(",")
            .map((label) => label.trim())
            .filter(Boolean),
          collaboratorsOnly,
          secretName: secretName.trim(),
        },
      );
      show(saved.link);
    });

  const unlink = () =>
    run(async () => {
      await apiFetch<void>("DELETE", `/api/rooms/${roomId}/github-link`);
      show(null);
    });

  const label: React.CSSProperties = { ...dialogLabel, marginTop: 14 };
  return (
    <div data-github-link>
      <h4 className="agent-settings-group-title" style={{ marginTop: 24 }}>
        {t("settings.room.github.title")}
      </h4>
      <p style={{ ...dialogHint, marginTop: 6 }}>
        {t("settings.room.github.hint")}
      </p>
      <label style={label}>{t("settings.room.github.repo")}</label>
      <input
        {...noTranslate()}
        data-github-link-repo
        value={repo}
        onChange={(e) => setRepo(e.target.value)}
        placeholder="owner/repo"
        style={dialogInput}
      />
      <label style={label}>{t("settings.room.github.labels")}</label>
      <input
        {...noTranslate()}
        data-github-link-labels
        value={labels}
        onChange={(e) => setLabels(e.target.value)}
        style={dialogInput}
      />
      <p style={{ ...dialogHint, marginTop: 4 }}>
        {t("settings.room.github.labelsHint")}
      </p>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 12,
          color: "var(--text-primary)",
          marginTop: 10,
        }}
      >
        <input
          type="checkbox"
          data-github-link-collaborators
          checked={collaboratorsOnly}
          onChange={() => setCollaboratorsOnly(!collaboratorsOnly)}
        />
        {t("settings.room.github.collaboratorsOnly")}
      </label>
      <label style={label}>{t("settings.room.github.secret")}</label>
      <input
        {...noTranslate()}
        data-github-link-secret
        value={secretName}
        onChange={(e) => setSecretName(e.target.value)}
        style={dialogInput}
      />
      <p style={{ ...dialogHint, marginTop: 4 }}>
        {t("settings.room.github.secretHint")}
      </p>
      {link && (
        <p
          data-github-link-status
          data-kind={link.status.kind}
          style={{ ...dialogHint, marginTop: 10 }}
        >
          {t(statusKey(link.status))}
        </p>
      )}
      {error && (
        <p
          style={{ fontSize: 10, color: "var(--red-text)", margin: "6px 0 0" }}
        >
          {error}
        </p>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button
          data-github-link-save
          onClick={() => void save()}
          disabled={busy || !repo.trim()}
          style={{
            ...dialogSaveBtn,
            ...(busy || !repo.trim() ? disabledLook : {}),
          }}
        >
          {t(
            link ? "settings.room.github.update" : "settings.room.github.link",
          )}
        </button>
        {link && (
          <button
            data-github-link-unlink
            onClick={() => void unlink()}
            disabled={busy}
            style={{ ...dialogCancelBtn, ...(busy ? disabledLook : {}) }}
          >
            {t("settings.room.github.unlink")}
          </button>
        )}
      </div>
    </div>
  );
}

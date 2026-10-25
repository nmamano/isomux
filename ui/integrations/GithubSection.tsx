// The GitHub issues tab of Integrations (task 7ac5ba2e; the link itself is
// task 7fc83592), for office owners only. A Room select picks the room, and
// the form below it saves that room's link on its own (it is not part of the
// room's PATCH). The select names each room's linked repo, so the tab also
// reads as the list of links. The token is picked from the office secrets
// the sync will send to GitHub (task edcc3e34).

import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { useAppState } from "../store.tsx";
import { onConnectionsChanged } from "../connections-events.ts";
import { noTranslate } from "../no-translate.ts";
import {
  dialogCancelBtn,
  dialogHint,
  dialogInput,
  dialogLabel,
  dialogSaveBtn,
  disabledLook,
} from "../components/dialog-styles.ts";
import { Btn, card, hintText, input } from "./kit.tsx";
import type { PlainMessageKey } from "../../shared/i18n/translate.ts";
import type { GithubLinkStatus, GithubLinkWire } from "../../shared/types.ts";
import type { SecretListRes } from "../../shared/contract-shapes.ts";
import {
  DEFAULT_GITHUB_SYNC_SECRET,
  GITHUB_HOST,
} from "../../shared/github-sync.ts";

// The secret a new link starts on: the default name, else the only choice.
function defaultSecret(usable: string[]): string {
  if (usable.includes(DEFAULT_GITHUB_SYNC_SECRET))
    return DEFAULT_GITHUB_SYNC_SECRET;
  return usable.length === 1 ? usable[0] : "";
}

// The missing secret's line links the Secrets tab, so it is drawn apart.
const MISSING = "paused:missing";
const STATUS_TEXT: Record<string, PlainMessageKey> = {
  pending: "integrations.github.status.pending",
  ok: "integrations.github.status.ok",
  "paused:host": "integrations.github.status.host",
  "paused:refused": "integrations.github.status.refused",
  "paused:no_access": "integrations.github.status.noAccess",
  waiting: "integrations.github.status.waiting",
  error: "integrations.github.status.error",
};

function statusKey(status: GithubLinkStatus): PlainMessageKey {
  return (
    STATUS_TEXT[`${status.kind}:${status.reason}`] ??
    STATUS_TEXT[status.kind] ??
    STATUS_TEXT.error
  );
}

// onSecrets switches the page to the Secrets tab.
export function GithubSection({ onSecrets }: { onSecrets: () => void }) {
  const { t } = useI18n();
  const { rooms, allRooms } = useAppState();
  const choices = (allRooms.length > 0 ? allRooms : rooms).filter(
    (room) => room.type !== "lobby",
  );
  const ids = choices.map((room) => room.id).join(",");
  // The saved link of each room, by room id; null until every room answered.
  const [links, setLinks] = useState<Record<string, GithubLinkWire> | null>(
    null,
  );
  const [picked, setPicked] = useState<string | null>(null);
  // The names of the office secrets the sync may send to GitHub; null until
  // the list answered. A failed load offers none.
  const [usable, setUsable] = useState<string[] | null>(null);

  useEffect(() => {
    let alive = true;
    // Only the newest load may set the list: an older answer can come last.
    let latest = 0;
    const load = () => {
      const mine = ++latest;
      return apiFetch<SecretListRes>("GET", "/api/office/secrets")
        .then((result) =>
          result.secrets
            .filter((secret) => secret.hosts.includes(GITHUB_HOST))
            .map((secret) => secret.name),
        )
        .catch(() => [])
        .then((names) => {
          if (alive && mine === latest) setUsable(names);
        });
    };
    void load();
    // A secret added or removed on the Secrets tab changes the choices.
    const stop = onConnectionsChanged(() => void load());
    return () => {
      alive = false;
      stop();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const roomIds = ids ? ids.split(",") : [];
    void Promise.all(
      roomIds.map((roomId) =>
        apiFetch<{ link: GithubLinkWire | null }>(
          "GET",
          `/api/rooms/${roomId}/github-link`,
        )
          .then((r) => r.link)
          .catch(() => null),
      ),
    ).then((found) => {
      if (cancelled) return;
      const next: Record<string, GithubLinkWire> = {};
      for (const link of found) if (link) next[link.roomId] = link;
      setLinks(next);
      // Open on the first linked room, else the first room.
      setPicked(
        (prev) =>
          prev ?? roomIds.find((roomId) => next[roomId]) ?? roomIds[0] ?? null,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [ids]);

  if (choices.length === 0)
    return (
      <section style={card}>
        <p data-github-link-empty style={{ ...hintText, margin: 0 }}>
          {t("integrations.github.empty")}
        </p>
      </section>
    );
  if (!links || !picked || !usable) return null;
  const roomId = choices.some((room) => room.id === picked)
    ? picked
    : choices[0].id;
  return (
    <section data-integrations-card="github" style={card}>
      <label style={dialogLabel}>{t("integrations.github.room")}</label>
      <select
        data-github-link-room
        value={roomId}
        onChange={(e) => setPicked(e.target.value)}
        style={input}
      >
        {choices.map((room) => (
          <option key={room.id} value={room.id}>
            {links[room.id]
              ? `${room.name} · ${links[room.id].repo}`
              : room.name}
          </option>
        ))}
      </select>
      <RoomGithubLink
        key={roomId}
        roomId={roomId}
        saved={links[roomId] ?? null}
        usable={usable}
        onSecrets={onSecrets}
        onSaved={(link) =>
          setLinks((prev) => {
            const next = { ...prev };
            if (link) next[roomId] = link;
            else delete next[roomId];
            return next;
          })
        }
      />
    </section>
  );
}

// One room's link: the saved link and its status, Save and Unlink.
function RoomGithubLink({
  roomId,
  saved,
  usable,
  onSecrets,
  onSaved,
}: {
  roomId: string;
  saved: GithubLinkWire | null;
  usable: string[];
  onSecrets: () => void;
  onSaved: (link: GithubLinkWire | null) => void;
}) {
  const { t, rich } = useI18n();
  // Keyed by room: a new room starts a new form from its saved link.
  const [link, setLink] = useState(saved);
  const [repo, setRepo] = useState(saved?.repo ?? "");
  const [labels, setLabels] = useState(saved ? saved.labels.join(", ") : "");
  const [collaboratorsOnly, setCollaboratorsOnly] = useState(
    saved?.collaboratorsOnly ?? false,
  );
  // "" until the member picks a secret, for a new link.
  const [pickedSecret, setPickedSecret] = useState(saved?.secretName ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function show(next: GithubLinkWire | null) {
    setLink(next);
    setRepo(next?.repo ?? "");
    setLabels(next ? next.labels.join(", ") : "");
    setCollaboratorsOnly(next?.collaboratorsOnly ?? false);
    setPickedSecret(next?.secretName ?? "");
  }

  // The choices keep the saved and the picked secret even when the office
  // no longer offers them, so the select always shows what Save sends.
  const secretName = pickedSecret || defaultSecret(usable);
  const choices = [...usable];
  for (const name of [link?.secretName, secretName])
    if (name && !choices.includes(name)) choices.push(name);
  const ready = repo.trim() !== "" && secretName !== "";

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
      const result = await apiFetch<{ link: GithubLinkWire }>(
        "PUT",
        `/api/rooms/${roomId}/github-link`,
        {
          repo: repo.trim(),
          labels: labels
            .split(",")
            .map((label) => label.trim())
            .filter(Boolean),
          collaboratorsOnly,
          secretName,
        },
      );
      show(result.link);
      onSaved(result.link);
    });

  const unlink = () =>
    run(async () => {
      await apiFetch<void>("DELETE", `/api/rooms/${roomId}/github-link`);
      show(null);
      onSaved(null);
    });

  const label: React.CSSProperties = { ...dialogLabel, marginTop: 14 };
  return (
    <div data-github-link>
      <label style={label}>{t("integrations.github.repo")}</label>
      <input
        {...noTranslate()}
        data-github-link-repo
        value={repo}
        onChange={(e) => setRepo(e.target.value)}
        placeholder="owner/repo"
        style={dialogInput}
      />
      <label style={label}>{t("integrations.github.labels")}</label>
      <input
        {...noTranslate()}
        data-github-link-labels
        value={labels}
        onChange={(e) => setLabels(e.target.value)}
        style={dialogInput}
      />
      <p style={{ ...dialogHint, marginTop: 4 }}>
        {t("integrations.github.labelsHint")}
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
        {t("integrations.github.collaboratorsOnly")}
      </label>
      <label style={label}>{t("integrations.github.secret")}</label>
      {choices.length > 0 ? (
        <>
          <select
            {...noTranslate()}
            data-github-link-secret
            value={secretName}
            onChange={(e) => setPickedSecret(e.target.value)}
            style={dialogInput}
          >
            <option value="" disabled>
              {t("integrations.github.pickSecret")}
            </option>
            {choices.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <p style={{ ...dialogHint, marginTop: 4 }}>
            {t("integrations.github.secretHint")}
          </p>
        </>
      ) : (
        <p data-github-link-no-secret style={{ ...dialogHint, marginTop: 4 }}>
          {rich("integrations.github.noSecret", {
            link: (chunk) => (
              <Btn kind="link" onClick={onSecrets} data-go-secrets>
                {chunk}
              </Btn>
            ),
          })}
        </p>
      )}
      {link && (
        <p
          data-github-link-status
          data-kind={link.status.kind}
          style={{ ...dialogHint, marginTop: 10 }}
        >
          {`${link.status.kind}:${link.status.reason}` === MISSING
            ? rich("integrations.github.status.missing", {
                link: (chunk) => (
                  <Btn kind="link" onClick={onSecrets} data-go-secrets>
                    {chunk}
                  </Btn>
                ),
              })
            : t(statusKey(link.status))}
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
          disabled={busy || !ready}
          style={{
            ...dialogSaveBtn,
            ...(busy || !ready ? disabledLook : {}),
          }}
        >
          {t(link ? "integrations.github.update" : "integrations.github.link")}
        </button>
        {link && (
          <button
            data-github-link-unlink
            onClick={() => void unlink()}
            disabled={busy}
            style={{ ...dialogCancelBtn, ...(busy ? disabledLook : {}) }}
          >
            {t("integrations.github.unlink")}
          </button>
        )}
      </div>
    </div>
  );
}

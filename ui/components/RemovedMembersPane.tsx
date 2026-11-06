// Owner-only: the members removed in the last 30 days (task 321e7b8e). Restore
// brings one back with the same id; Delete now deletes them for good. The list
// is the owners-only removed_members event, seeded here with one GET.

import { useEffect, useState } from "react";
import { useAppState, useDispatch } from "../store.tsx";
import { apiFetch, ApiError } from "../api.ts";
import type {
  MemberRestoreReq,
  MemberRestoreRes,
  RemovedMemberListRes,
  RemovedMemberWire,
} from "../../shared/contract-shapes.ts";
import { formatDateTime } from "../../shared/i18n/time.ts";
import { useI18n } from "../i18n.tsx";
import { noTranslate } from "../no-translate.ts";
import { GhostGraphic } from "../office/ghostVariants.tsx";
import { cardStyle, hint, sectionHeader } from "./access-shared.tsx";
import {
  dialogSaveBtn,
  disabledLook,
  filledDangerBtn,
} from "./dialog-styles.ts";

// One GET per connection; the event keeps the list current after it.
export function useRemovedMembersSeed(isOwner: boolean): void {
  const { removedMembersLoaded, sessionContext } = useAppState();
  const dispatch = useDispatch();
  // Keyed on sessionContext too: see useAccessListsSeed.
  useEffect(() => {
    if (!isOwner || removedMembersLoaded) return;
    apiFetch<RemovedMemberListRes>("GET", "/api/removed-members")
      .then((r) => dispatch({ type: "removed_members", members: r.members }))
      .catch(() => {});
  }, [isOwner, removedMembersLoaded, sessionContext, dispatch]);
}

export function RemovedMembersPane({
  onRestored,
}: {
  onRestored: (userId: string) => void;
}) {
  const { removedMembers } = useAppState();
  const { t } = useI18n();
  return (
    <div style={{ marginTop: 24 }}>
      <h4 style={sectionHeader}>{t("settings.removedMembers.title")}</h4>
      <p style={hint}>{t("settings.removedMembers.intro")}</p>
      {removedMembers.length === 0 ? (
        <p style={hint}>{t("settings.access.none")}</p>
      ) : (
        removedMembers.map((member) => (
          <RemovedMemberCard
            key={member.user.id}
            member={member}
            onRestored={onRestored}
          />
        ))
      )}
    </div>
  );
}

function RemovedMemberCard({
  member,
  onRestored,
}: {
  member: RemovedMemberWire;
  onRestored: (userId: string) => void;
}) {
  const { t, language } = useI18n();
  const { user, heirName, passed } = member;
  const passedAny = passed.agents + passed.schedules + passed.webhooks > 0;
  const [moveBack, setMoveBack] = useState(true);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = `/api/removed-members/${encodeURIComponent(user.id)}`;

  function run(request: Promise<unknown>, failed: string) {
    setPending(true);
    setError(null);
    return request
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : failed);
        return null;
      })
      .finally(() => setPending(false));
  }

  function restore() {
    const body: MemberRestoreReq = { agents: moveBack };
    void run(
      apiFetch<MemberRestoreRes>("POST", `${path}/restore`, body),
      t("settings.removedMembers.restoreFailed"),
    ).then((res) => {
      if (res) onRestored(user.id);
    });
  }

  function purge() {
    if (!confirmPurge) {
      setConfirmPurge(true);
      return;
    }
    setConfirmPurge(false);
    void run(
      apiFetch<void>("DELETE", path),
      t("settings.profile.deleteFailed"),
    );
  }

  return (
    <div style={cardStyle} data-removed-member={user.id}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <GhostGraphic
          variant={user.avatarVariant}
          color={user.avatarColor}
          size={22}
        />
        <span
          {...noTranslate()}
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          {user.name}
        </span>
      </div>
      <p style={hint}>
        {t("settings.removedMembers.removedOn", {
          date: formatDateTime(language, member.removedAt, "date"),
          name: member.removedBy,
          expires: formatDateTime(language, member.expiresAt, "date"),
        })}
      </p>
      {heirName && passedAny && (
        <label
          style={{
            ...hint,
            display: "flex",
            alignItems: "center",
            gap: 6,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={moveBack}
            onChange={(e) => setMoveBack(e.target.checked)}
            data-removed-member-move-back=""
          />
          {t("settings.removedMembers.moveBack", { heir: heirName })}
        </label>
      )}
      {error && <p style={{ ...hint, color: "var(--red-text)" }}>{error}</p>}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button
          onClick={restore}
          disabled={pending}
          style={{ ...dialogSaveBtn, ...(pending ? disabledLook : {}) }}
          data-removed-member-restore=""
        >
          {t("settings.removedMembers.restore")}
        </button>
        <button
          onClick={purge}
          onBlur={() => setConfirmPurge(false)}
          disabled={pending}
          style={{ ...filledDangerBtn, ...(pending ? disabledLook : {}) }}
          data-removed-member-delete=""
        >
          {confirmPurge
            ? t("common.confirmQuestion")
            : t("settings.removedMembers.deleteNow")}
        </button>
      </div>
    </div>
  );
}

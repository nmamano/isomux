// An agent's settings as a full page (task 59538509): the agent's sections in
// the list column, the open one beside it, and the form's footer under it.
// The form itself (one form across every section) is in EditAgentDialog.tsx,
// which also keeps the spawn dialog.

import type { ReactNode } from "react";
import { useAppState } from "../store.tsx";
import { useLeaveGuard, type LeaveGuard } from "../page-leave-guard.ts";
import { SidebarGroupRows } from "./SidebarGroups.tsx";
import { SidebarPage } from "./SidebarPage.tsx";
import { UnsavedChangesPrompt } from "./UnsavedChangesPrompt.tsx";
import { dialogCancelBtn, dialogSaveBtn } from "./dialog-styles.ts";
import { useI18n } from "../i18n.tsx";
import type { AgentSettingsSection } from "./EditAgentDialog.tsx";

export function AgentSettingsPage({
  agentId,
  title,
  subtitle,
  sections,
  section,
  onSection,
  onClose,
  guard,
  saveError,
  leavePrompt,
  dirty,
  saving,
  saved,
  saveBlocked,
  onRevert,
  onSave,
}: {
  agentId: string;
  title: string;
  subtitle: ReactNode;
  sections: { id: AgentSettingsSection; label: string; body: ReactNode }[];
  // null: a phone shows the list.
  section: AgentSettingsSection | null;
  onSection: (section: AgentSettingsSection | null) => void;
  onClose: () => void;
  // How the page leaves for a sidebar row: through the form's discard
  // prompt.
  guard: LeaveGuard;
  // The form's footer: a refused save's reason, the discard prompt, Cancel
  // and Save.
  saveError: ReactNode;
  leavePrompt: { open: boolean; discard: () => void; cancel: () => void };
  dirty: boolean;
  saving: boolean;
  // The last save went through.
  saved: boolean;
  saveBlocked: boolean;
  onRevert: () => void;
  onSave: () => void;
}) {
  const { isMobile } = useAppState();
  const { t } = useI18n();
  useLeaveGuard(guard);
  const shown = sections.find((s) => s.id === section) ?? null;
  return (
    <SidebarPage
      rootAttrs={{ "data-agent-settings-page": agentId }}
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      listShown={section === null}
      onBackToList={() => onSection(null)}
      backLabel={title}
      listLabel={title}
      list={
        <>
          <SidebarGroupRows
            group={{
              id: "agent",
              rows: sections.map((s) => ({
                key: s.id,
                label: s.label,
                selected: s.id === section,
                target: s.id,
              })),
            }}
            first
            onSelect={onSection}
            rowAttrs={(row) => ({ "data-agent-settings-section": row.target })}
          />
          {/* A phone showing the list has no footer: an exit that waits on
            the discard prompt shows it here. */}
          {!shown && leavePrompt.open && (
            <div style={{ padding: "0 16px" }}>
              <UnsavedChangesPrompt
                onDiscard={leavePrompt.discard}
                onCancel={leavePrompt.cancel}
              />
            </div>
          )}
        </>
      }
    >
      {shown && (
        <>
          <div
            className="agent-settings-page-body"
            style={{
              flex: 1,
              maxWidth: 900,
              width: "100%",
              boxSizing: "border-box",
              padding: isMobile ? "14px 16px 24px" : "20px 24px 24px",
            }}
          >
            {shown.body}
          </div>
          {/* The one footer of the form: Save writes every section. Sticky,
              so it shows however long the section is. */}
          <div
            style={{
              position: "sticky",
              bottom: 0,
              padding: isMobile
                ? "12px 16px max(12px, env(safe-area-inset-bottom))"
                : "12px 24px",
              borderTop: "1px solid var(--border)",
              background: "var(--bg-base)",
            }}
          >
            {saveError && (
              <p
                role="alert"
                style={{
                  fontSize: 12,
                  color: "var(--red-text)",
                  margin: "0 0 10px",
                  lineHeight: 1.4,
                }}
              >
                {saveError}
              </p>
            )}
            {leavePrompt.open && (
              <div style={{ marginBottom: 10 }}>
                <UnsavedChangesPrompt
                  onDiscard={leavePrompt.discard}
                  onCancel={leavePrompt.cancel}
                />
              </div>
            )}
            <div
              style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}
            >
              {/* Cancel throws the edits away and stays, as on the room
                  pane; the header's close leaves. */}
              <button
                onClick={onRevert}
                style={dialogCancelBtn}
                disabled={saving || !dirty}
              >
                {t("common.cancel")}
              </button>
              <button
                data-agent-settings-save=""
                onClick={onSave}
                style={dialogSaveBtn}
                disabled={saving || saveBlocked}
              >
                {saving
                  ? t("common.saving")
                  : saved && !dirty
                    ? t("common.saved")
                    : t("common.save")}
              </button>
            </div>
          </div>
        </>
      )}
    </SidebarPage>
  );
}

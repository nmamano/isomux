// A listed item's settings inside Settings (task 1f79f2e3; the agent's page
// before it, task 59538509): a member, a room or an agent lists its parts in
// the list column, under a back row to the Settings list, and the pane shows
// the open part over the item's one footer. Each editor (UserEditPanel,
// RoomPane, EditAgentDialog) hands its parts, body and footer to its parent
// as a SettingsItemView; UserSettingsView wraps every one of them here, so
// the three items share one layout and one Escape owner.

import {
  useEffect,
  type CSSProperties,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { useAppState } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { SidebarGroupRows, type SidebarRow } from "./SidebarGroups.tsx";
import { SidebarPage } from "./SidebarPage.tsx";
import { UnsavedChangesPrompt } from "./UnsavedChangesPrompt.tsx";
import { dialogCancelBtn, dialogSaveBtn } from "./dialog-styles.ts";
import { PageNavButton } from "./PageNavButton.tsx";

/** What an item's editor hands its parent. */
export interface SettingsItemView<P extends string = string> {
  // The parts the viewer gets, in order; `dirty` marks a part that holds an
  // unsaved edit (ui/settings-parts.ts).
  parts: { id: P; label: string; dirty: boolean }[];
  // The open part; null shows the part list (a phone).
  part: P | null;
  // Beside the page title: the item's name (and the agent's place).
  subtitle: ReactNode;
  // The open part's fields.
  body: ReactNode;
  // The item's one footer (SettingsSaveFooter): Save writes every part.
  footer: ReactNode;
  // The item's discard prompt.
  prompt: { open: boolean; discard: () => void; cancel: () => void };
  // A save is in flight: Escape does not leave.
  busy: boolean;
}

/** What the page's Escape needs of the open item, kept fresh by the page. */
export interface SettingsItemEscape {
  prompt: { open: boolean; cancel: () => void };
  part: string | null;
  busy: boolean;
  onPart: (part: null) => void;
}

/** The open part's body, marked with its part. */
export function SettingsPartBody({
  part,
  children,
}: {
  part: string;
  children: ReactNode;
}) {
  return <div data-settings-part-body={part}>{children}</div>;
}

/** The part rows of an item, as sidebar rows. */
export function partRows<P extends string>(
  view: SettingsItemView<P>,
): SidebarRow<P>[] {
  return view.parts.map((p) => ({
    key: p.id,
    label: p.label,
    selected: p.id === view.part,
    target: p.id,
    dirty: p.dirty,
  }));
}

/** The data attributes of a part row. */
export function partRowAttrs<P extends string>(
  row: SidebarRow<P>,
): Record<string, string> {
  return {
    "data-settings-part": row.target,
    ...(row.dirty ? { "data-settings-part-dirty": "" } : {}),
  };
}

export function SettingsItemPage<P extends string>({
  item,
  backLabel,
  view,
  onPart,
  onBackToSettings,
  onClose,
  escapeRef,
}: {
  // data-settings-item: "<kind>:<id>", or "newMember".
  item: string;
  // The phone back row from a part to the part list: the item's settings.
  backLabel: ReactNode;
  view: SettingsItemView<P>;
  onPart: (part: P | null) => void;
  // The back row to the Settings list; the parent routes it through the
  // item's discard prompt.
  onBackToSettings: () => void;
  onClose: () => void;
  escapeRef: MutableRefObject<SettingsItemEscape | null>;
}) {
  const { isMobile } = useAppState();
  const { t } = useI18n();
  const title = t("common.settings");
  // No deps: the page's Escape reads the latest state.
  useEffect(() => {
    escapeRef.current = {
      prompt: view.prompt,
      part: view.part,
      busy: view.busy,
      onPart: () => onPart(null),
    };
    return () => {
      escapeRef.current = null;
    };
  });
  const shown = view.part !== null;
  return (
    <SidebarPage
      rootAttrs={{ "data-settings-item": item }}
      detailAttrs={{ "data-testid": "settings-content" }}
      title={title}
      subtitle={view.subtitle}
      onClose={onClose}
      listShown={!shown}
      onBackToList={() => onPart(null)}
      backLabel={backLabel}
      listLabel={title}
      list={
        <>
          <div style={{ padding: "0 14px 10px" }}>
            <PageNavButton
              label={t("common.settings")}
              onClick={onBackToSettings}
              data-settings-back=""
            />
          </div>
          <SidebarGroupRows
            group={{ id: "item", rows: partRows(view) }}
            first
            onSelect={onPart}
            rowAttrs={partRowAttrs}
          />
          {/* A phone showing the list has no footer: an exit that waits on
              the discard prompt shows it here. */}
          {!shown && view.prompt.open && (
            <div style={{ padding: "0 16px" }}>
              <UnsavedChangesPrompt
                onDiscard={view.prompt.discard}
                onCancel={view.prompt.cancel}
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
            <SettingsPartBody part={view.part!}>{view.body}</SettingsPartBody>
          </div>
          {view.footer}
        </>
      )}
    </SidebarPage>
  );
}

/** The sticky footer of a Settings part that saves (an item's parts, and the
 *  sections laid out by SettingsFormLayout): the refused save's reason, the
 *  discard prompt, Cancel and Save. It derives its states from the form, so
 *  every part acts the same:
 *  - Cancel: enabled while the form holds unsaved edits.
 *  - Save: enabled while the form holds unsaved edits and `canSave`.
 *  - The Save label: Saving while a save runs; Saved when a save succeeded
 *    since the part opened and the form equals what was saved; else Save
 *    (`saveLabel` replaces the plain Save, as Create on New member). */
export function SettingsSaveFooter({
  error,
  prompt,
  dirty,
  saving,
  saved,
  canSave = true,
  onCancel,
  onSave,
  saveLabel,
}: {
  error: ReactNode;
  // `message` and `confirmLabel` replace the prompt's default text and its
  // Discard label (Storage while a delete runs).
  prompt?: {
    open: boolean;
    discard: () => void;
    cancel: () => void;
    message?: ReactNode;
    confirmLabel?: ReactNode;
  };
  // The form differs from what is saved.
  dirty: boolean;
  saving: boolean;
  // A save succeeded since the part opened.
  saved: boolean;
  // The blockers that keep Save disabled (a field missing, data not loaded).
  canSave?: boolean;
  onCancel: () => void;
  onSave: () => void;
  saveLabel?: string;
}) {
  const { isMobile } = useAppState();
  const { t } = useI18n();
  return (
    <div
      data-settings-footer=""
      style={{
        position: "sticky",
        bottom: 0,
        marginTop: "auto",
        padding: isMobile
          ? "12px 16px max(12px, env(safe-area-inset-bottom))"
          : "12px 24px",
        borderTop: "1px solid var(--border)",
        background: "var(--bg-base)",
      }}
    >
      {error && (
        <p
          role="alert"
          style={{
            fontSize: 12,
            color: "var(--red-text)",
            margin: "0 0 10px",
            lineHeight: 1.4,
          }}
        >
          {error}
        </p>
      )}
      {prompt?.open && (
        <div style={{ marginBottom: 10 }}>
          <UnsavedChangesPrompt
            onDiscard={prompt.discard}
            onCancel={prompt.cancel}
            message={prompt.message}
            confirmLabel={prompt.confirmLabel}
          />
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button
          onClick={onCancel}
          style={dialogCancelBtn}
          disabled={saving || !dirty}
        >
          {t("common.cancel")}
        </button>
        <button
          data-settings-save=""
          onClick={onSave}
          style={dialogSaveBtn}
          disabled={saving || !dirty || !canSave}
        >
          {saving
            ? t("common.saving")
            : saved && !dirty
              ? t("common.saved")
              : (saveLabel ?? t("common.save"))}
        </button>
      </div>
    </div>
  );
}

/** A Settings section that saves: its fields in the section's padded box
 *  (data-settings-form-body), and its SettingsSaveFooter under it across the
 *  whole pane, as on an item's parts. */
export function SettingsFormLayout({
  children,
  footer,
}: {
  children: ReactNode;
  footer: ReactNode;
}) {
  const { isMobile } = useAppState();
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
      <div data-settings-form-body="" style={settingsSectionBox(isMobile)}>
        {children}
      </div>
      {footer}
    </div>
  );
}

/** The padded column a Settings section's content sits in. */
export function settingsSectionBox(isMobile: boolean): CSSProperties {
  return {
    padding: isMobile ? "0 16px 24px" : "0 24px 24px",
    maxWidth: 720,
    width: "100%",
    boxSizing: "border-box",
  };
}

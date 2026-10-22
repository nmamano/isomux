// Install the office as an app (ui/app-install.ts): a one-time notice on a
// phone browser that can install it, and the entry in Settings > Device
// label.
// Neither shows in an installed window.

import { useEffect, useState, useSyncExternalStore } from "react";
import { useAppState } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import {
  closeOfficeInstallSteps,
  heldInstallPrompt,
  installMode,
  officeInstallStepsOpen,
  promptInstall,
  readInstallEnv,
  showOfficeInstallNotice,
  subscribeInstallPrompt,
  subscribeOfficeInstallSteps,
  type InstallMode,
} from "../app-install.ts";
import {
  markOfficeInstallNoticeSeen,
  officeInstallNoticeSeen,
} from "../device-settings.ts";
import { sectionHeader } from "./access-shared.tsx";
import { dialogSaveBtn } from "./dialog-styles.ts";
import { ShareIcon } from "./install-icons.tsx";

// A server render has no held prompt and no open steps.
const serverSnapshot = () => false;

function useHeldInstallPrompt(): boolean {
  return useSyncExternalStore(
    subscribeInstallPrompt,
    () => heldInstallPrompt() !== null,
    serverSnapshot,
  );
}

// What Install as app does in this browser now; null hides every entry.
export function useInstallMode(): InstallMode {
  return installMode(readInstallEnv(), useHeldInstallPrompt());
}

export function OfficeInstallNotice(): React.ReactElement | null {
  const { isMobile } = useAppState();
  const { t } = useI18n();
  const held = useHeldInstallPrompt();
  const env = readInstallEnv();
  const mode = installMode(env, held);
  const stepsOpen = useSyncExternalStore(
    subscribeOfficeInstallSteps,
    officeInstallStepsOpen,
    serverSnapshot,
  );
  // Read once: the flag this notice writes must not hide it on this visit.
  const [seen] = useState(officeInstallNoticeSeen);
  const [dismissed, setDismissed] = useState(false);
  const show =
    (mode === "ios-steps" && stepsOpen) ||
    (!dismissed && showOfficeInstallNotice(env, held, isMobile, seen));
  useEffect(() => {
    if (show) markOfficeInstallNoticeSeen();
  }, [show]);
  // Steps the phone menu opened do not outlive the office view.
  useEffect(() => closeOfficeInstallSteps, []);
  if (!show || !mode) return null;

  const close = () => {
    setDismissed(true);
    closeOfficeInstallSteps();
  };
  return (
    <div
      role="status"
      data-office-install-notice={mode === "prompt" ? "prompt" : "steps"}
      style={{
        position: "absolute",
        top: 8,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 600,
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "max-content",
        maxWidth: "calc(100vw - 24px)",
        boxSizing: "border-box",
        padding: "6px 6px 6px 14px",
        borderRadius: 14,
        background: "var(--bg-surface-solid)",
        border: "1px solid var(--border-medium)",
        boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
        color: "var(--text-primary)",
        fontSize: 12,
        animation: "fadeIn 0.2s ease",
      }}
    >
      {mode === "prompt" ? (
        <>
          <span>{t("officeInstall.notice")}</span>
          <button
            onClick={() => void promptInstall()}
            style={{
              padding: "4px 12px",
              borderRadius: 999,
              border: "none",
              background: "var(--accent-text)",
              color: "var(--bg-base)",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            {t("officeInstall.install")}
          </button>
        </>
      ) : (
        <>
          <span style={{ color: "var(--accent-text)", display: "flex" }}>
            <ShareIcon />
          </span>
          <span>{t("officeInstall.noticeSteps")}</span>
        </>
      )}
      <button
        data-office-install-dismiss=""
        onClick={close}
        aria-label={t("common.dismiss")}
        title={t("common.dismiss")}
        style={{
          width: 24,
          height: 24,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          borderRadius: "50%",
          border: "none",
          background: "transparent",
          color: "var(--text-dim)",
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path
            d="M1 1l8 8M9 1l-8 8"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}

// The Settings > Device label section, on every viewport.
export function OfficeInstallEntry(): React.ReactElement | null {
  const { t } = useI18n();
  const mode = useInstallMode();
  if (!mode) return null;
  return (
    <div data-office-install-entry={mode === "prompt" ? "prompt" : "steps"}>
      <h4 style={{ ...sectionHeader, marginTop: 32 }}>
        {t("appWidget.install")}
      </h4>
      {mode === "prompt" ? (
        <button
          onClick={() => void promptInstall()}
          style={{ ...dialogSaveBtn, marginTop: 4 }}
        >
          {t("officeInstall.install")}
        </button>
      ) : (
        <p
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            margin: "4px 0 0",
            fontSize: 13,
            color: "var(--text-secondary)",
          }}
        >
          <span style={{ color: "var(--accent-text)", display: "flex" }}>
            <ShareIcon />
          </span>
          {t("appWidget.installSteps")}
        </p>
      )}
    </div>
  );
}

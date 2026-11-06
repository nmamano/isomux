// The Enterprise Contract lock (task 8b80e61f): a full-screen overlay while
// the server says the office is locked (full_state.office.enterpriseLocked,
// office_enterprise_lock). Owners get the Settings section inline, to paste
// the secret or uncheck the box; members get the text only.
import { useAppState } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { EnterpriseContractSection } from "./EnterpriseContractSection.tsx";

export function EnterpriseLock() {
  const { enterpriseLocked, sessionContext } = useAppState();
  const { t } = useI18n();
  if (!enterpriseLocked) return null;
  const owner = sessionContext?.role === "owner";
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 8900,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "var(--bg-base)",
      }}
    >
      <div style={{ width: "100%", maxWidth: 440 }}>
        <p
          style={{
            fontSize: 13,
            color: "var(--text-primary)",
            textAlign: "center",
          }}
        >
          {owner
            ? t("settings.office.enterprise.locked")
            : t("settings.office.enterprise.lockedMember")}
        </p>
        {owner && <EnterpriseContractSection inLock />}
      </div>
    </div>
  );
}

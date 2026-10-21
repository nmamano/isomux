import { useI18n } from "../i18n.tsx";

// The Variables tab, in a new tab: leaving this page would drop a recording
// the member is about to retry (task 4481e64b).
export function VoiceVariablesLink() {
  const i18n = useI18n();
  return (
    <a
      href="/integrations/variables"
      target="_blank"
      rel="noopener"
      style={{ color: "inherit", textDecoration: "underline" }}
    >
      {i18n.t("voice.openVariables")}
    </a>
  );
}

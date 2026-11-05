import { useI18n } from "../i18n.tsx";
import { useCan } from "../hooks/useCan.ts";

// The Variables tab, in a new tab: leaving this page would drop a recording
// the member is about to retry (task 4481e64b). Nothing for a member whose
// permission pack hides that tab (task 93191798).
export function VoiceVariablesLink() {
  const i18n = useI18n();
  if (!useCan("environment", "read")) return null;
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

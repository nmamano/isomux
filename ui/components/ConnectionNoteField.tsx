import { CONNECTION_NOTE_MAX_LENGTH } from "../../shared/connection-notes.ts";
import { useI18n } from "../i18n.tsx";
import { dialogInput, dialogLabel } from "./dialog-styles.ts";

// The usage note for agents in the secret and MCP server forms (integrations
// A4). Agents read it from GET /api/agent-connections.
export function ConnectionNoteField({
  value,
  onChange,
}: {
  value: string;
  onChange: (note: string) => void;
}) {
  const { t } = useI18n();
  return (
    <label style={{ display: "block", marginBottom: 8 }}>
      <span style={dialogLabel}>{t("settings.connections.note")}</span>
      <textarea
        rows={2}
        maxLength={CONNECTION_NOTE_MAX_LENGTH}
        value={value}
        placeholder={t("settings.connections.notePlaceholder")}
        style={{ ...dialogInput, fontFamily: "inherit", resize: "vertical" }}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

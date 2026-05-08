import type { FilePayload } from "../../shared/types.ts";

function relativeOrAbs(payload: FilePayload): string {
  // If the path is inside the cwd, show the relative form. Otherwise show
  // the absolute path so the boss can see exactly what will open.
  const { cwd, path } = payload;
  if (path === cwd) return path;
  const prefix = cwd.endsWith("/") ? cwd : cwd + "/";
  if (path.startsWith(prefix)) return path.slice(prefix.length);
  return path;
}

export function EditRequestCard({
  payload,
  onOpen,
}: {
  payload: FilePayload;
  onOpen: (path: string) => void;
}) {
  const display = relativeOrAbs(payload);
  return (
    <div style={{
      margin: "8px 0",
      borderRadius: 10,
      background: "var(--bg-subtle)",
      border: "1px solid var(--border)",
      overflow: "hidden",
    }}>
      <div style={{
        padding: "10px 12px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
      }}>
        <span style={{
          fontFamily: "'JetBrains Mono',monospace",
          fontSize: 13,
          color: "var(--text-secondary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
          minWidth: 0,
        }} title={payload.path}>
          {display}
        </span>
        <button
          onClick={() => onOpen(payload.path)}
          style={{
            padding: "4px 12px",
            borderRadius: 6,
            border: "1px solid var(--green-border)",
            background: "var(--green-bg)",
            color: "var(--green)",
            fontSize: 12,
            fontFamily: "'JetBrains Mono',monospace",
            cursor: "pointer",
            flexShrink: 0,
          }}
          title={`Open ${payload.path} in the editor side panel`}
        >
          Open in editor
        </button>
      </div>
    </div>
  );
}

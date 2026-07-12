import type { IsomuxCurlRequest } from "./isomux-curl.ts";

// Ports the isomux server may be reachable on from the agent's shell. 4000 is
// the documented default; window.location.port covers offices that serve the
// UI (and therefore the API) on a nonstandard port.
export const isomuxUiPorts: readonly string[] = Array.from(
  new Set(
    ["4000", typeof window !== "undefined" ? window.location.port : ""].filter(
      Boolean,
    ),
  ),
);

const METHOD_COLORS: Record<string, { color: string; bg: string }> = {
  GET: { color: "var(--green)", bg: "var(--green-bg)" },
  POST: { color: "var(--accent)", bg: "var(--accent-bg)" },
  PUT: { color: "var(--orange)", bg: "var(--orange-bg)" },
  PATCH: { color: "var(--orange)", bg: "var(--orange-bg)" },
  DELETE: { color: "var(--red)", bg: "var(--red-bg)" },
};

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Inline header parts for a Bash tool-call row whose command is a curl against
 * the isomux API: method badge, human action label (when the route is known),
 * and the path. Rendered inside the existing collapsible tool-call button, in
 * place of the "Bash <raw command>" summary.
 */
export function IsomuxCurlHeader({
  req,
  isMobile,
}: {
  req: IsomuxCurlRequest;
  isMobile?: boolean;
}) {
  const methodStyle = METHOD_COLORS[req.method] ?? {
    color: "var(--text-dim)",
    bg: "var(--bg-code)",
  };
  return (
    <>
      <span
        style={{
          padding: "0 6px",
          borderRadius: 4,
          background: methodStyle.bg,
          color: methodStyle.color,
          fontSize: isMobile ? 11 : 10,
          fontWeight: 700,
          letterSpacing: "0.04em",
          flexShrink: 0,
        }}
      >
        {req.method}
      </span>
      {req.action && (
        <span style={{ fontWeight: 600, flexShrink: 0 }}>{req.action}</span>
      )}
      <span
        style={{
          color: "var(--text-faint)",
          fontSize: isMobile ? 13 : 11,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
          minWidth: 40,
        }}
        title={req.path}
      >
        {req.path}
      </span>
      {req.pipeTail && (
        // Always verbatim and untruncated: the parser does not semantically
        // validate the tail, so concealing any of it here would let the card
        // hide a side effect that the raw rendering would have shown. Long
        // tails are already rejected at parse time (MAX_PIPE_TAIL).
        <span
          style={{
            color: "var(--text-ghost)",
            fontSize: isMobile ? 12 : 10,
            overflowWrap: "anywhere",
          }}
        >
          {req.pipeTail}
        </span>
      )}
    </>
  );
}

const MAX_FIELDS = 5;
const MAX_VALUE_CHARS = 64;

/**
 * Full-width second row inside the tool-call button showing the request's key
 * payload fields as chips. Returns null when the request carries no body.
 */
export function IsomuxCurlFields({
  req,
  isMobile,
}: {
  req: IsomuxCurlRequest;
  isMobile?: boolean;
}) {
  const chips: Array<{ key: string | null; value: string }> = [];
  if (req.bodyFields && req.bodyFields.length > 0) {
    for (const f of req.bodyFields.slice(0, MAX_FIELDS)) {
      chips.push({ key: f.key, value: truncate(f.value, MAX_VALUE_CHARS) });
    }
  } else if (req.bodyRaw) {
    chips.push({ key: null, value: truncate(req.bodyRaw, MAX_VALUE_CHARS) });
  }
  if (chips.length === 0) return null;
  const hidden = (req.bodyFields?.length ?? 0) - MAX_FIELDS;
  return (
    <span
      style={{
        flexBasis: "100%",
        display: "flex",
        flexWrap: "wrap",
        gap: 4,
        paddingLeft: 20,
        marginTop: 2,
      }}
    >
      {chips.map((chip, i) => (
        <span
          key={i}
          style={{
            display: "inline-flex",
            gap: 4,
            padding: "0 6px",
            borderRadius: 4,
            background: "var(--bg-code)",
            border: "1px solid var(--border-subtle)",
            fontSize: isMobile ? 12 : 10,
            fontWeight: 400,
            maxWidth: "100%",
            overflow: "hidden",
          }}
        >
          {chip.key !== null && (
            <span style={{ color: "var(--text-faint)", flexShrink: 0 }}>
              {chip.key}:
            </span>
          )}
          <span
            style={{
              color: "var(--text-dim)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {chip.value}
          </span>
        </span>
      ))}
      {hidden > 0 && (
        <span
          style={{
            color: "var(--text-ghost)",
            fontSize: isMobile ? 12 : 10,
            fontWeight: 400,
            alignSelf: "center",
          }}
        >
          +{hidden} more
        </span>
      )}
    </span>
  );
}

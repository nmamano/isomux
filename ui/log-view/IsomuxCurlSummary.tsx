import type { IsomuxCurlRequest } from "./isomux-curl.ts";
import { humanizeIsomuxRequest, pipeTailForDisplay } from "./isomux-curl.ts";
import { useAppState } from "../store.tsx";

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

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Inline header parts for a Bash tool-call row whose command is a curl against
 * the isomux API: an "isomux" tag (distinguishing these cards from ordinary
 * tool calls) followed by a plain-language description of what the call does
 * ("Send a message to Isomuxer4", "Read memories for this agent"). The raw
 * path is only shown when no description exists; it is always available in
 * the hover tooltip and the expanded raw view. Rendered inside the existing
 * collapsible tool-call button, in place of the "Bash <raw command>" summary.
 */
export function IsomuxCurlHeader({
  req,
  isMobile,
}: {
  req: IsomuxCurlRequest;
  isMobile?: boolean;
}) {
  const { agents } = useAppState();
  const label =
    humanizeIsomuxRequest(
      req,
      (id) => agents.find((a) => a.id === id)?.name ?? null,
    ) ?? req.action;
  return (
    <>
      {/* Rendered exactly like the plain "Bash" tool name (same inherited
          font size and weight, no chip box) so the text aligns with other
          tool rows; the accent color + tinted card background are what set
          isomux cards apart. */}
      <span
        style={{
          color: "var(--accent)",
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        Isomux
      </span>
      {label ? (
        <span
          style={{
            fontWeight: 600,
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            minWidth: 40,
          }}
          title={`${req.method} ${req.path}`}
        >
          {label}
        </span>
      ) : (
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
          title={`${req.method} ${req.path}`}
        >
          {req.method} {req.path}
        </span>
      )}
      {req.pipeTail && (
        // Elided only by pipeTailForDisplay, which is bounded so the card
        // always shows more of the tail than the raw collapsed row it replaces
        // — the parser does not semantically validate tails, so a card that
        // showed less could hide a side effect (a `sed w` script).
        <span
          style={{
            color: "var(--text-ghost)",
            fontSize: isMobile ? 12 : 10,
            overflowWrap: "anywhere",
          }}
        >
          {pipeTailForDisplay(req.pipeTail)}
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
  const chips: Array<{ key: string | null; value: string; note?: boolean }> =
    [];
  if (req.bodyFields && req.bodyFields.length > 0) {
    for (const f of req.bodyFields.slice(0, MAX_FIELDS)) {
      chips.push({ key: f.key, value: truncate(f.value, MAX_VALUE_CHARS) });
    }
  } else if (req.bodyRaw) {
    chips.push({ key: null, value: truncate(req.bodyRaw, MAX_VALUE_CHARS) });
  } else if (req.bodyNote) {
    // e.g. "body built with jq" for producer pipelines the parser accepted
    // but could not resolve into concrete fields.
    chips.push({ key: null, value: req.bodyNote, note: true });
  }
  if (req.outputFile) {
    // A file write is a side effect: always surfaced, never truncated away
    // silently (truncate keeps the leading part of the path visible).
    chips.push({
      key: null,
      value: `output ${req.outputAppend ? "appended" : "saved"} to ${truncate(req.outputFile, MAX_VALUE_CHARS)}`,
      note: true,
    });
  }
  if (chips.length === 0) return null;
  const hidden = (req.bodyFields?.length ?? 0) - MAX_FIELDS;
  return (
    <span
      style={{
        flexBasis: "100%",
        // minWidth 0 all the way down: each level here is a flex item, and a
        // flex item's default min-width:auto lets a long unbreakable value
        // (a file path, a URL) propagate its full width up and push the row
        // past the card and the page edge. With the chain zeroed, the row
        // caps at the card width and the value span ellipsizes instead.
        minWidth: 0,
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
            minWidth: 0,
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
              color: chip.note ? "var(--text-faint)" : "var(--text-dim)",
              fontStyle: chip.note ? "italic" : undefined,
              minWidth: 0,
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

// The parts every tab of the Integrations page shares: buttons, pills, rows,
// form fields and the card styles (task 911c9bbb, design A of the mocks).

import { useState, type CSSProperties, type ReactNode } from "react";
import { useAppState } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { disabledLook } from "../components/dialog-styles.ts";
import { whose, type Target, type WhoseKey } from "./target.ts";

export const mono: CSSProperties = {
  fontFamily: "'JetBrains Mono',monospace",
};

// Data inside the page's prose (an email, a member's name, a path, a host,
// a server or variable name) looks unlike the words around it (Nil,
// 2026-10-13): one style for all of it, the Data component below.
export const dataStyle: CSSProperties = {
  fontFamily: "'JetBrains Mono',monospace",
  fontSize: "0.92em",
  fontWeight: 500,
  color: "var(--text-primary)",
  background: "var(--bg-code)",
  padding: "1px 5px",
  borderRadius: 4,
  overflowWrap: "anywhere",
};

// Service-authored and member-authored text: rendered as text only.
export function Data({ children }: { children: ReactNode }) {
  return (
    <span data-integrations-data="" style={dataStyle}>
      {children}
    </span>
  );
}

export const hintText: CSSProperties = {
  fontSize: 12,
  color: "var(--text-muted)",
  lineHeight: 1.45,
};

export const card: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 10,
  background: "var(--bg-input)",
  padding: 14,
};

export const input: CSSProperties = {
  width: "100%",
  padding: "8px 11px",
  background: "var(--bg-base)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text-primary)",
  fontSize: 12.5,
  outline: "none",
  boxSizing: "border-box",
  fontFamily: "inherit",
};

export const errorText: CSSProperties = {
  color: "var(--red-text)",
  fontSize: 12,
  margin: "8px 0 0",
  overflowWrap: "anywhere",
};

const btnBase: CSSProperties = {
  padding: "6px 13px",
  borderRadius: 8,
  fontSize: 12,
  cursor: "pointer",
  whiteSpace: "nowrap",
  fontFamily: "inherit",
};

export type BtnKind = "primary" | "secondary" | "link" | "danger";

export function Btn({
  kind = "secondary",
  onClick,
  children,
  small,
  disabled,
  style,
  ...data
}: {
  kind?: BtnKind;
  onClick?: () => void;
  children: ReactNode;
  small?: boolean;
  disabled?: boolean;
  style?: CSSProperties;
  [data: `data-${string}`]: string | boolean | undefined;
}) {
  const look: CSSProperties =
    kind === "primary"
      ? {
          border: "none",
          background: "var(--accent-text)",
          color: "var(--bg-base)",
          fontWeight: 600,
        }
      : kind === "link"
        ? {
            border: "none",
            background: "none",
            color: "var(--accent-text)",
            padding: 0,
            fontSize: 12,
          }
        : kind === "danger"
          ? {
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--red-text)",
            }
          : {
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text-dim)",
            };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      {...data}
      style={{
        ...btnBase,
        ...(small && kind !== "link"
          ? { padding: "3px 9px", fontSize: 11 }
          : {}),
        ...look,
        ...(disabled && kind !== "link"
          ? { ...disabledLook, cursor: "not-allowed" }
          : {}),
        ...style,
      }}
    >
      {children}
    </button>
  );
}

export type Tone = "green" | "orange" | "red" | "neutral" | "accent";

const TONES: Record<Tone, CSSProperties> = {
  green: { color: "var(--green-text)", background: "var(--green-bg)" },
  orange: { color: "var(--orange-text)", background: "var(--orange-bg)" },
  red: { color: "var(--red-text)", background: "var(--red-bg)" },
  neutral: { color: "var(--text-muted)", background: "var(--btn-surface)" },
  accent: { color: "var(--accent-text)", background: "var(--accent-bg)" },
};

export function Pill({
  tone,
  children,
  ...data
}: {
  tone: Tone;
  children: ReactNode;
  [data: `data-${string}`]: string | undefined;
}) {
  return (
    <span
      {...data}
      style={{
        display: "inline-block",
        fontSize: 10.5,
        fontWeight: 600,
        padding: "2px 7px",
        borderRadius: 999,
        whiteSpace: "nowrap",
        ...TONES[tone],
      }}
    >
      {children}
    </span>
  );
}

// A monogram tile for a service. The known services get their colour; the
// rest a neutral tile with the first letter of the name.
const LOGO_COLORS: Record<string, string> = {
  GitHub: "#6e7681",
  Stripe: "#635bff",
  Fly: "#8b5cf6",
};

export function Logo({ label, size = 28 }: { label: string; size?: number }) {
  const bg = LOGO_COLORS[label] ?? "var(--border-strong, var(--border))";
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: size / 4,
        background: bg,
        color: "#fff",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size * 0.42,
        fontWeight: 700,
        flexShrink: 0,
      }}
    >
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}

// One line of a list: a title, a quieter detail line, a status and actions,
// and whatever opens under it (a form, a test result).
export function ItemRow({
  title,
  detail,
  status,
  actions,
  logo,
  children,
  ...data
}: {
  title: ReactNode;
  detail?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  logo?: ReactNode;
  children?: ReactNode;
  [data: `data-${string}`]: string | undefined;
}) {
  const { isMobile } = useAppState();
  return (
    <div
      {...data}
      style={{
        borderTop: "1px solid var(--border-subtle)",
        padding: "10px 2px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: isMobile ? "flex-start" : "center",
          gap: 10,
          flexWrap: isMobile ? "wrap" : undefined,
        }}
      >
        {logo}
        {/* On a phone the name takes the line and the actions wrap under
            it, rather than squeezing the name into a column. */}
        <div
          style={{
            flex: isMobile ? `1 1 calc(100% - ${logo ? 38 : 0}px)` : 1,
            minWidth: 0,
          }}
        >
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              overflowWrap: "anywhere",
            }}
          >
            {title}
          </div>
          {detail && (
            <div
              style={{
                ...hintText,
                fontSize: 11.5,
                marginTop: 2,
                overflowWrap: "anywhere",
              }}
            >
              {detail}
            </div>
          )}
        </div>
        {status}
        {actions && (
          <div
            style={{
              display: "flex",
              gap: 6,
              flexShrink: 0,
              flexWrap: "wrap",
              marginLeft: isMobile && logo ? 38 : undefined,
            }}
          >
            {actions}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

// The usage note for agents, under its row.
export function NoteLine({ note }: { note: string | null | undefined }) {
  const { t } = useI18n();
  if (!note) return null;
  return (
    <div
      data-connection-note
      aria-label={t("settings.connections.note")}
      title={t("settings.connections.note")}
      style={{
        fontSize: 12,
        margin: "6px 0 0",
        padding: "2px 0 2px 8px",
        borderLeft: "2px solid var(--border)",
        color: "var(--text-secondary)",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      }}
    >
      {note}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label style={{ display: "block", marginTop: 12 }}>
      <span
        style={{
          display: "block",
          fontSize: 12,
          fontWeight: 600,
          color: "var(--text-dim)",
          marginBottom: 5,
        }}
      >
        {label}
      </span>
      {children}
      {hint && (
        <span style={{ ...hintText, display: "block", marginTop: 4 }}>
          {hint}
        </span>
      )}
    </label>
  );
}

// A row of choices that reads as one control (a radio group).
export function Choice<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      style={{ display: "flex", flexWrap: "wrap", gap: 6 }}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            data-choice={o.value}
            onClick={(e) => {
              e.preventDefault();
              onChange(o.value);
            }}
            style={{
              ...btnBase,
              padding: "5px 11px",
              border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
              background: on ? "var(--accent-bg)" : "transparent",
              color: on ? "var(--accent-text)" : "var(--text-dim)",
              fontWeight: on ? 600 : 400,
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// A heading as words (for an aria-label) and as shown, its data (the item's
// name, the member) in the data style.
export type Heading = { text: string; node: ReactNode };

// whose() for a heading: the same sentence, also as nodes.
export function useWhose() {
  const { t, rich } = useI18n();
  return (
    base: WhoseKey,
    target: Target,
    vars: Record<string, string> = {},
  ): Heading => {
    const all =
      target.kind === "member" ? { ...vars, member: target.username } : vars;
    // The key is built at run time, as in whose().
    const richAny = rich as unknown as (
      key: string,
      parts: Record<string, ReactNode>,
    ) => ReactNode;
    return {
      text: whose(t, base, target, vars),
      node: richAny(
        `${base}.${target.kind}`,
        Object.fromEntries(
          Object.entries(all).map(([key, value]) => [
            key,
            <Data key={key}>{value}</Data>,
          ]),
        ),
      ),
    };
  };
}

// The panel a row opens for an add, a change or a removal. Its heading names
// whose item it is (Nil, 2026-10-13: "Remove Stephen's GH_TOKEN?").
export function Panel({
  heading,
  children,
  ...data
}: {
  heading: Heading;
  children: ReactNode;
  [data: `data-${string}`]: string | undefined;
}) {
  return (
    <div
      {...data}
      role="group"
      aria-label={heading.text}
      style={{ ...card, marginTop: 8 }}
    >
      <div data-panel-heading style={{ fontSize: 12.5, fontWeight: 650 }}>
        {heading.node}
      </div>
      {children}
    </div>
  );
}

export function FormButtons({
  ready,
  busy,
  onCancel,
  onSave,
  saveLabel,
  danger,
}: {
  ready: boolean;
  busy: boolean;
  onCancel: () => void;
  onSave: () => void | Promise<void>;
  saveLabel: string;
  danger?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "flex-end",
        gap: 8,
        marginTop: 14,
        flexWrap: "wrap",
      }}
    >
      <Btn onClick={onCancel} disabled={busy}>
        {t("common.cancel")}
      </Btn>
      <Btn
        kind={danger ? "danger" : "primary"}
        disabled={!ready || busy}
        onClick={() => void onSave()}
        data-panel-save
      >
        {busy ? t("common.saving") : saveLabel}
      </Btn>
    </div>
  );
}

// A (?) that opens a short explanation in place. A title tooltip never shows
// on a phone, so it is a button.
export function HelpTip({ text }: { text: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        data-help-tip
        aria-label={t("integrations.helpTip")}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        style={{
          width: 16,
          height: 16,
          marginLeft: 4,
          borderRadius: "50%",
          border: "1px solid var(--border-medium, var(--border))",
          background: "transparent",
          color: "var(--text-muted)",
          fontSize: 10,
          lineHeight: "14px",
          padding: 0,
          cursor: "pointer",
          verticalAlign: "middle",
        }}
      >
        ?
      </button>
      {open && (
        <span
          role="note"
          style={{
            display: "block",
            whiteSpace: "normal",
            position: "absolute",
            zIndex: 30,
            left: -40,
            top: "calc(100% + 6px)",
            width: 240,
            padding: "8px 10px",
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--bg-surface-solid, var(--bg-base))",
            boxShadow: "0 8px 24px var(--shadow-heavy, rgba(0,0,0,0.3))",
            ...hintText,
            color: "var(--text-secondary)",
            fontWeight: 400,
          }}
        >
          {text}
        </span>
      )}
    </span>
  );
}

// A list that is still loading: the Loading line, and the Add row the
// loaded list will have, disabled, so the card keeps its height when the
// answer comes (Nil, 2026-10-13). `addLabel` is set when the loaded list
// shows an Add row to this viewer.
export function ListLoading({
  text,
  addLabel,
}: {
  text: string;
  addLabel?: string;
}) {
  return (
    <div data-integrations-loading="">
      <Empty>{text}</Empty>
      {addLabel !== undefined && <AddRow label={addLabel} disabled />}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        ...hintText,
        borderTop: "1px solid var(--border-subtle)",
        padding: "10px 2px",
      }}
    >
      {children}
    </div>
  );
}

// The Add button at the foot of a list.
export function AddRow({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <div
      style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: 10 }}
    >
      <Btn small onClick={onClick} disabled={disabled} data-integrations-add>
        + {label}
      </Btn>
    </div>
  );
}

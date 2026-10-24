// The variables of one card on the Variables tab: plain settings that agents
// read at session start, such as a time zone, and model API keys (those cannot
// be secrets: model hosts are on the never-list). Values render masked until
// Show, so a shared screen shows nothing (Nil).
//
// Who sees what (Lead, 2026-10-13, option B): a member edits their own
// values; an owner edits the office's; an owner sees a member's names and
// notes only, never the values, and replaces or removes one variable at a
// time. Every card saves one variable per request (PUT/DELETE .../env/<name>),
// so no save can drop a value the page never read or undo a change made
// elsewhere after the page loaded. Nothing on a card can save until its read
// has succeeded.

import { useEffect, useState } from "react";
import type {
  OfficeEnvNamesRes,
  UserEnvNamesRes,
  UserEnvRes,
} from "../../shared/contract-shapes.ts";
import { apiFetch, ApiError } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { notifyManagedEnvSaved } from "../connections-events.ts";
import { ConnectionNoteField } from "../components/ConnectionNoteField.tsx";
import {
  AddRow,
  ListLoading,
  Btn,
  Empty,
  Field,
  FormButtons,
  ItemRow,
  NoteLine,
  Panel,
  errorText,
  hintText,
  input,
  mono,
  type Heading,
  useWhose,
} from "./kit.tsx";
import { Confirm } from "./SecretsSection.tsx";
import { useAlive } from "./use-alive.ts";
import { basePath, canEdit, isGone, type Role, type Target } from "./target.ts";
import { isModelKeySecretName } from "../../shared/secret-hosts.ts";
import { MaskedInput } from "../components/MaskedInput.tsx";

type Variable = { name: string; value: string | null; note: string };

// Model sign-in keys go here, not in Secrets, so the "looks like a key" hint
// leaves them alone. The caller passes the trimmed name.
function looksLikeKey(name: string): boolean {
  return /KEY|TOKEN|SECRET|PASSWORD/i.test(name) && !isModelKeySecretName(name);
}

type Mode =
  | { kind: "idle" }
  | { kind: "add" }
  | { kind: "edit"; name: string }
  | { kind: "remove"; name: string };

function fromValues(result: UserEnvRes): Variable[] | null {
  if (!result || typeof result.values !== "object" || result.values === null)
    return null;
  const notes = result.notes ?? {};
  return Object.entries(result.values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => ({ name, value, note: notes[name] ?? "" }));
}

// The names-only reads: the office's ({variables}) for everyone, a member's
// ({names, notes}) for an owner.
function fromNames(
  result: Partial<OfficeEnvNamesRes & UserEnvNamesRes> | null,
): Variable[] | null {
  if (Array.isArray(result?.variables))
    return result.variables
      .filter((entry) => typeof entry?.name === "string")
      .map((entry) => ({
        name: entry.name,
        value: null,
        note: typeof entry.note === "string" ? entry.note : "",
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  if (Array.isArray(result?.names)) {
    const notes = result.notes ?? {};
    return result.names
      .filter((name) => typeof name === "string")
      .map((name) => ({ name, value: null, note: notes[name] ?? "" }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  return null;
}

// A variable route's refusal: the server's own sentence, as the old editor
// showed it.
function envErrorText(caught: unknown, fallback: string): string {
  return caught instanceof ApiError && caught.message
    ? caught.message
    : fallback;
}

export function VariablesSection({
  target,
  role,
  onGone,
}: {
  target: Target;
  role: Role;
  // The member left the office while the card showed them.
  onGone?: () => void;
}) {
  const { t } = useI18n();
  const whoseHeading = useWhose();
  const alive = useAlive();
  const base = basePath(target);
  const editable = canEdit(target, role);
  // The office's values reach owners only; a member's reach that member only.
  const withValues =
    target.kind === "self" || (target.kind === "office" && role === "owner");
  const [variables, setVariables] = useState<Variable[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });

  const load = () =>
    (withValues
      ? apiFetch<UserEnvRes>("GET", `${base}/env`).then(fromValues)
      : apiFetch<OfficeEnvNamesRes | UserEnvNamesRes>(
          "GET",
          `${base}/env/names`,
        ).then(fromNames)
    )
      .then((next) => {
        if (!alive.current) return;
        setVariables(next);
        setLoadError(next === null);
      })
      .catch((caught: unknown) => {
        if (!alive.current) return;
        // A failed reread keeps nothing it could save from.
        setVariables(null);
        setLoadError(true);
        if (isGone(caught, target)) onGone?.();
      });

  useEffect(() => {
    void load();
    // The section is keyed by its target; the path never changes in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => setMode({ kind: "idle" });
  const changed = async () => {
    close();
    await load();
    notifyManagedEnvSaved();
  };

  // One variable set (renamed from `from` when given) or removed (`next`
  // null).
  async function write(
    name: string,
    next: { value: string; note: string } | null,
    from?: string,
  ): Promise<void> {
    const path = (n: string) => `${base}/env/${encodeURIComponent(n)}`;
    if (!next) {
      await apiFetch("DELETE", path(name));
      return;
    }
    await apiFetch("PUT", path(name), {
      value: next.value,
      note: next.note.trim() ? next.note.trim() : null,
    });
    // A rename: the new name is saved first, so a failure loses nothing.
    if (from && from !== name) await apiFetch("DELETE", path(from));
  }

  // Nothing can be changed until the read has succeeded.
  const ready = variables !== null && !loadError;
  const idle = mode.kind === "idle";

  return (
    <div data-managed-env-path={`${base}/env`}>
      {loadError ? (
        <p role="alert" style={errorText}>
          {t("settings.env.loadFailed")}
        </p>
      ) : variables === null ? (
        <ListLoading
          text={t("settings.env.loadingVariables")}
          addLabel={editable ? t("settings.env.add") : undefined}
        />
      ) : variables.length === 0 ? (
        <Empty>{t("integrations.variables.empty")}</Empty>
      ) : (
        variables.map((variable) => (
          <VariableItem
            key={variable.name}
            variable={variable}
            others={variables
              .map((v) => v.name)
              .filter((n) => n !== variable.name)}
            target={target}
            editable={editable && ready}
            mode={mode}
            setMode={setMode}
            write={write}
            onChanged={changed}
          />
        ))
      )}
      {editable &&
        ready &&
        (mode.kind === "add" ? (
          <VariableEditor
            heading={whoseHeading("integrations.variables.addHeading", target)}
            taken={variables.map((v) => v.name)}
            onCancel={close}
            onSave={async (name, value, note) => {
              await write(name, { value, note });
              await changed();
            }}
          />
        ) : (
          idle && (
            <AddRow
              label={t("settings.env.add")}
              onClick={() => setMode({ kind: "add" })}
            />
          )
        ))}
    </div>
  );
}

function VariableItem({
  variable,
  others,
  target,
  editable,
  mode,
  setMode,
  write,
  onChanged,
}: {
  variable: Variable;
  others: string[];
  target: Target;
  editable: boolean;
  mode: Mode;
  setMode: (mode: Mode) => void;
  write: (
    name: string,
    next: { value: string; note: string } | null,
    from?: string,
  ) => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  const { t } = useI18n();
  const whoseHeading = useWhose();
  const [shown, setShown] = useState(false);
  const here =
    (mode.kind === "edit" || mode.kind === "remove") &&
    mode.name === variable.name;
  // Without the value (an owner on a member's variables), a change replaces
  // it: the field starts empty and is never filled from anywhere, and the
  // name stays (a rename would need the value).
  const replaceOnly = variable.value === null;
  return (
    <ItemRow
      data-env-entry={variable.name}
      title={<span style={mono}>{variable.name}</span>}
      detail={
        variable.value !== null ? (
          <span
            style={{ display: "inline-flex", gap: 8, alignItems: "center" }}
          >
            <code data-env-value style={{ ...mono, fontSize: 11.5 }}>
              {shown ? variable.value : "••••••••"}
            </code>
            <Btn
              kind="link"
              onClick={() => setShown(!shown)}
              data-env-show
              style={{ fontSize: 11.5 }}
            >
              {shown ? t("integrations.hide") : t("integrations.show")}
            </Btn>
          </span>
        ) : undefined
      }
      actions={
        editable && mode.kind === "idle" ? (
          <>
            <Btn
              small
              onClick={() => setMode({ kind: "edit", name: variable.name })}
              data-env-edit
            >
              {replaceOnly ? t("settings.secrets.rotate") : t("common.edit")}
            </Btn>
            <Btn
              small
              kind="danger"
              onClick={() => setMode({ kind: "remove", name: variable.name })}
              data-env-remove
            >
              {t("integrations.remove")}
            </Btn>
          </>
        ) : null
      }
    >
      <NoteLine note={variable.note} />
      {here && mode.kind === "edit" && (
        <VariableEditor
          heading={whoseHeading(
            replaceOnly
              ? "integrations.variables.replaceHeading"
              : "integrations.dialog.edit",
            target,
            { name: variable.name },
          )}
          fixedName={replaceOnly ? variable.name : undefined}
          initialName={variable.name}
          taken={others}
          initialValue={variable.value ?? ""}
          initialNote={variable.note}
          requireValue={replaceOnly}
          onCancel={() => setMode({ kind: "idle" })}
          onSave={async (name, value, note) => {
            await write(name, { value, note }, variable.name);
            await onChanged();
          }}
        />
      )}
      {here && mode.kind === "remove" && (
        <Confirm
          data-env-remove-panel=""
          heading={whoseHeading("integrations.dialog.remove", target, {
            name: variable.name,
          })}
          action={t("integrations.remove")}
          danger
          request={() => write(variable.name, null)}
          errorFor={(caught) =>
            envErrorText(caught, t("settings.env.saveFailed"))
          }
          onCancel={() => setMode({ kind: "idle" })}
          onDone={onChanged}
        />
      )}
    </ItemRow>
  );
}

function VariableEditor({
  heading,
  fixedName,
  initialName = "",
  initialValue = "",
  initialNote = "",
  taken = [],
  requireValue = false,
  onCancel,
  onSave,
}: {
  heading: Heading;
  // Shown, not editable: an owner replacing a member's value.
  fixedName?: string;
  initialName?: string;
  initialValue?: string;
  initialNote?: string;
  // The other names on the card: a name already there is refused.
  taken?: string[];
  requireValue?: boolean;
  onCancel: () => void;
  onSave: (name: string, value: string, note: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const alive = useAlive();
  const [name, setName] = useState(fixedName ?? initialName);
  const [value, setValue] = useState(initialValue);
  const [note, setNote] = useState(initialNote);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const duplicate = !fixedName && taken.includes(trimmed);
  const editing = !!(fixedName || initialName);
  return (
    <Panel
      heading={heading}
      {...(editing ? { "data-env-edit-panel": "" } : { "data-env-add": "" })}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)",
          gap: 10,
        }}
      >
        {fixedName ? (
          <Field label={t("settings.secrets.name")}>
            <div style={{ ...mono, fontSize: 12.5, padding: "8px 0" }}>
              {fixedName}
            </div>
          </Field>
        ) : (
          <Field label={t("settings.secrets.name")}>
            <input
              aria-label={t("settings.env.variableName")}
              data-env-name
              style={{ ...input, ...mono }}
              value={name}
              spellCheck={false}
              autoComplete="off"
              placeholder="TZ"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        )}
        <Field label={t("settings.secrets.value")}>
          <MaskedInput
            aria-label={t("settings.env.valueLabel", {
              name: trimmed || t("settings.env.variable"),
            })}
            data-env-value-input
            style={{ ...input, ...mono }}
            value={value}
            placeholder={t("settings.env.valuePlaceholder")}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
      </div>
      {!fixedName && looksLikeKey(trimmed) && (
        <div
          data-env-key-hint
          style={{ ...hintText, color: "var(--orange-text)", marginTop: 8 }}
        >
          {t("integrations.variables.looksLikeKey")}
        </div>
      )}
      {duplicate && (
        <div style={{ ...errorText }}>{t("integrations.variables.exists")}</div>
      )}
      <div style={{ marginTop: 4 }}>
        <ConnectionNoteField value={note} onChange={setNote} />
      </div>
      <FormButtons
        ready={
          trimmed.length > 0 && !duplicate && (!requireValue || value !== "")
        }
        busy={busy}
        saveLabel={t("common.save")}
        onCancel={onCancel}
        onSave={async () => {
          setBusy(true);
          setError(null);
          try {
            await onSave(trimmed, value, note);
          } catch (caught) {
            if (alive.current)
              setError(envErrorText(caught, t("settings.env.saveFailed")));
          } finally {
            if (alive.current) setBusy(false);
          }
        }}
      />
      {error && (
        <p role="alert" style={errorText}>
          {error}
        </p>
      )}
    </Panel>
  );
}

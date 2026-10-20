// The secrets of one card on the Secrets tab (internal-docs/secrets-design.md,
// section 1). A value is write-only for agents; a person sees it with Show only
// where canShowSecret allows, and only in this row's state while it is shown.
// A service preset fills and hides the name, the addresses and how the value
// is sent; Other starts every field empty.

import { Fragment, useEffect, useRef, useState } from "react";
import type {
  AppListWire,
  SecretListRes,
  SecretValueRes,
  SecretWire,
} from "../../shared/contract-shapes.ts";
import { SECRET_PRESETS, type SecretForm } from "../../shared/secret-hosts.ts";
import { formatDateTime } from "../../shared/i18n/time.ts";
import { apiFetch, ApiError } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import {
  notifyConnectionsChanged,
  onConnectionsChanged,
} from "../connections-events.ts";
import { ConnectionNoteField } from "../components/ConnectionNoteField.tsx";
import {
  AddRow,
  ListLoading,
  Btn,
  Choice,
  Empty,
  Field,
  FormButtons,
  ItemRow,
  Logo,
  NoteLine,
  Panel,
  errorText,
  hintText,
  input,
  mono,
  type Heading,
  Data,
  useWhose,
} from "./kit.tsx";
import {
  TestButton,
  TestResult,
  useConnectionTest,
} from "./ConnectionTest.tsx";
import { hasSecretTest } from "./secret-test.ts";
import { useAlive } from "./use-alive.ts";
import {
  basePath,
  canEdit,
  canShowSecret,
  isGone,
  summaryOnly,
  type Role,
  type Target,
} from "./target.ts";
import { MaskedInput } from "../components/MaskedInput.tsx";

// A row as the list shows it. A member reading the office's secrets gets the
// name, the hosts and the note only.
type SecretRow = {
  name: string;
  hosts: string[];
  note: string | null;
  form?: SecretForm;
  valueSetAt?: number;
  // The apps that read the value (task c7007f8b).
  apps: string[];
};

type Mode =
  | { kind: "idle" }
  | { kind: "add" }
  | { kind: "replace"; name: string }
  | { kind: "edit"; name: string }
  | { kind: "reissue"; name: string }
  | { kind: "remove"; name: string };

function hostsOf(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((host) => host.trim())
    .filter(Boolean);
}

const sameList = (a: string[], b: string[]): boolean =>
  a.length === b.length &&
  [...a].sort().every((x, i) => x === [...b].sort()[i]);

function presetOf(row: SecretRow) {
  return SECRET_PRESETS.find(
    (preset) =>
      preset.name === row.name &&
      preset.hosts.length === row.hosts.length &&
      preset.hosts.every((host) => row.hosts.includes(host)),
  );
}

function rowsOf(result: unknown): SecretRow[] | null {
  const secrets = (result as Partial<SecretListRes> | null)?.secrets;
  if (!Array.isArray(secrets)) return null;
  return secrets
    .filter(
      (secret) =>
        typeof secret?.name === "string" && Array.isArray(secret.hosts),
    )
    .map((secret: Partial<SecretWire>) => ({
      name: secret.name!,
      hosts: secret.hosts!,
      note: typeof secret.note === "string" && secret.note ? secret.note : null,
      form: secret.form,
      valueSetAt: secret.valueSetAt,
      apps: Array.isArray(secret.apps) ? secret.apps : [],
    }));
}

export function useSecretErrorText() {
  const { t } = useI18n();
  return (caught: unknown): string => {
    if (!(caught instanceof ApiError)) return t("settings.secrets.saveFailed");
    const detail = caught.detail ?? {};
    if (caught.code === "host_not_allowed")
      return t("settings.secrets.error.neverListed", {
        host: typeof detail.host === "string" ? detail.host : "",
      });
    if (caught.code === "secret_exists")
      return t("settings.secrets.error.exists");
    if (caught.code === "invalid_secret") {
      if (detail.field === "name")
        return detail.reason === "reserved"
          ? t("settings.secrets.error.reservedName")
          : t("settings.secrets.error.name");
      if (detail.field === "value") return t("settings.secrets.error.value");
      if (detail.field === "hosts") return t("settings.secrets.error.hosts");
      if (detail.field === "form") return t("settings.secrets.error.header");
      if (detail.field === "note") return t("settings.connections.error.note");
      if (detail.field === "apps")
        return detail.reason === "clash"
          ? t("settings.secrets.error.appClash")
          : t("settings.secrets.error.apps");
    }
    return t("settings.secrets.saveFailed");
  };
}

export function SecretsSection({
  target,
  role,
  ownerUserId,
  onGone,
}: {
  target: Target;
  role: Role;
  // The user id of the target member, whose own apps the apps checklist
  // offers; null for the office (every app) or a member the page does not
  // know (no app). By id: an app's username is a snapshot that a rename
  // leaves stale.
  ownerUserId: string | null;
  // The member left the office while the card showed them.
  onGone?: () => void;
}) {
  const { t, language } = useI18n();
  const alive = useAlive();
  const path = `${basePath(target)}/secrets`;
  const editable = canEdit(target, role);
  const summary = summaryOnly(target, role);
  const [secrets, setSecrets] = useState<SecretRow[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });

  const load = () =>
    apiFetch<SecretListRes>("GET", path)
      .then((result) => {
        if (!alive.current) return;
        const rows = rowsOf(result);
        setSecrets(rows);
        setLoadError(rows === null);
      })
      .catch((caught: unknown) => {
        if (!alive.current) return;
        setLoadError(true);
        if (isGone(caught, target)) onGone?.();
      });

  useEffect(() => {
    void load();
    // The section is keyed by its target; the path never changes in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The MCP server editor can add a secret.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => onConnectionsChanged(() => void load()), []);

  const close = () => setMode({ kind: "idle" });
  const changed = async () => {
    close();
    await load();
    notifyConnectionsChanged();
  };

  return (
    <div data-secrets-path={path}>
      {loadError ? (
        <p role="alert" style={errorText}>
          {t("settings.secrets.loadFailed")}
        </p>
      ) : secrets === null ? (
        <ListLoading
          text={t("common.loading")}
          addLabel={
            editable && !summary ? t("integrations.secrets.add") : undefined
          }
        />
      ) : secrets.length === 0 ? (
        <Empty>{t("integrations.secrets.empty")}</Empty>
      ) : (
        secrets.map((secret) => (
          <SecretItem
            key={secret.name}
            secret={secret}
            path={`${path}/${encodeURIComponent(secret.name)}`}
            target={target}
            ownerUserId={ownerUserId}
            summary={summary}
            editable={editable && !summary}
            showable={canShowSecret(target, role) && !summary}
            mode={mode}
            setMode={setMode}
            onChanged={changed}
            setOn={
              secret.valueSetAt
                ? formatDateTime(language, secret.valueSetAt, "date")
                : null
            }
          />
        ))
      )}
      {editable &&
        !summary &&
        secrets !== null &&
        !loadError &&
        (mode.kind === "add" ? (
          <AddSecret
            path={path}
            target={target}
            ownerUserId={ownerUserId}
            onCancel={close}
            onSaved={changed}
          />
        ) : (
          // One open form per card: a click elsewhere never drops a typed
          // value.
          mode.kind === "idle" && (
            <AddRow
              label={t("integrations.secrets.add")}
              onClick={() => setMode({ kind: "add" })}
            />
          )
        ))}
    </div>
  );
}

function SecretItem({
  secret,
  path,
  target,
  ownerUserId,
  summary,
  editable,
  showable,
  mode,
  setMode,
  onChanged,
  setOn,
}: {
  secret: SecretRow;
  path: string;
  target: Target;
  ownerUserId: string | null;
  // A member's row of an office secret: name, hosts and note only.
  summary: boolean;
  editable: boolean;
  showable: boolean;
  mode: Mode;
  setMode: (mode: Mode) => void;
  onChanged: () => Promise<void>;
  setOn: string | null;
}) {
  const { t, rich } = useI18n();
  const whoseHeading = useWhose();
  const errorFor = useSecretErrorText();
  const preset = presetOf(secret);
  const { test, run } = useConnectionTest(path);
  const open = (kind: Exclude<Mode["kind"], "idle" | "add">) =>
    setMode({ kind, name: secret.name });
  const here =
    mode.kind !== "idle" && mode.kind !== "add" && mode.name === secret.name;
  const hosts = secret.hosts.map((host, index) => (
    <Fragment key={host}>
      {index > 0 && ", "}
      <Data>{host}</Data>
    </Fragment>
  ));
  const apps = secret.apps.map((app, index) => (
    <Fragment key={app}>
      {index > 0 && ", "}
      <Data>{app}</Data>
    </Fragment>
  ));
  // A secret that only apps read has no address to name. A summary row does
  // not know its apps, so it says nothing about where it goes.
  const where =
    summary && secret.hosts.length === 0
      ? null
      : preset
        ? setOn
          ? t("integrations.secrets.presetSet", {
              service: preset.label,
              date: setOn,
            })
          : preset.label
        : secret.hosts.length === 0
          ? secret.apps.length === 0
            ? t("integrations.secrets.reachesNothing")
            : setOn
              ? rich("integrations.secrets.readBySet", { apps, date: setOn })
              : rich("integrations.secrets.readBy", { apps })
          : setOn
            ? rich("integrations.secrets.goesToSet", { hosts, date: setOn })
            : rich("integrations.secrets.goesTo", { hosts });
  const readBy =
    secret.hosts.length > 0 && secret.apps.length > 0 ? (
      <>
        {" · "}
        {rich("integrations.secrets.readBy", { apps })}
      </>
    ) : null;
  const form =
    secret.form?.kind === "header" ? (
      <>
        {" · "}
        {rich("settings.secrets.formHeaderNamed", {
          header: <Data>{secret.form.header}</Data>,
        })}
      </>
    ) : null;
  return (
    <ItemRow
      data-secret-name={secret.name}
      logo={<Logo label={preset?.label ?? secret.name} />}
      title={<span style={mono}>{secret.name}</span>}
      detail={
        <>
          {where}
          {form}
          {readBy}
        </>
      }
      actions={
        editable && mode.kind === "idle" ? (
          <>
            {secret.form &&
              hasSecretTest({ form: secret.form, hosts: secret.hosts }) && (
                <TestButton test={test} run={() => void run()} />
              )}
            <Btn small onClick={() => open("replace")} data-secret-replace>
              {t("settings.secrets.rotate")}
            </Btn>
            <Btn small onClick={() => open("edit")} data-secret-edit>
              {t("common.edit")}
            </Btn>
            <Btn
              small
              kind="danger"
              onClick={() => open("remove")}
              data-secret-remove
            >
              {t("integrations.remove")}
            </Btn>
          </>
        ) : null
      }
    >
      <NoteLine note={secret.note} />
      {showable && <SecretValue path={path} />}
      <TestResult test={test} />
      {here && mode.kind === "replace" && (
        <ReplaceValue
          path={path}
          heading={whoseHeading("integrations.secrets.replaceHeading", target, {
            name: secret.name,
          })}
          onCancel={() => setMode({ kind: "idle" })}
          onSaved={onChanged}
        />
      )}
      {here && mode.kind === "edit" && secret.form && (
        <EditSecret
          path={path}
          target={target}
          ownerUserId={ownerUserId}
          secret={{ ...secret, form: secret.form }}
          heading={whoseHeading("integrations.dialog.edit", target, {
            name: secret.name,
          })}
          onCancel={() => setMode({ kind: "idle" })}
          onReissue={() => open("reissue")}
          onSaved={onChanged}
        />
      )}
      {here && mode.kind === "reissue" && (
        <Confirm
          data-secret-reissue-panel=""
          heading={whoseHeading("integrations.secrets.reissueHeading", target, {
            name: secret.name,
          })}
          text={t("settings.secrets.reissueConfirm", { name: secret.name })}
          action={t("settings.secrets.reissue")}
          request={() => apiFetch("POST", `${path}/reissue`)}
          errorFor={errorFor}
          onCancel={() => setMode({ kind: "idle" })}
          onDone={onChanged}
        />
      )}
      {here && mode.kind === "remove" && (
        <Confirm
          data-secret-remove-panel=""
          heading={whoseHeading("integrations.dialog.remove", target, {
            name: secret.name,
          })}
          action={t("integrations.remove")}
          danger
          request={() => apiFetch("DELETE", path)}
          errorFor={errorFor}
          onCancel={() => setMode({ kind: "idle" })}
          onDone={onChanged}
        />
      )}
    </ItemRow>
  );
}

// The masked value with Show. The value lives in this state only: Hide drops
// it, and so does the row unmounting (a picker switch, a tab change, leaving
// the page). A failed read says so in fixed words, never with the answer.
function SecretValue({ path }: { path: string }) {
  const { t } = useI18n();
  const alive = useAlive();
  const [value, setValue] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // Each read gets a number; Hide moves it on, so a read still in flight
  // when the member hides the value never shows it.
  const request = useRef(0);

  async function show() {
    const mine = ++request.current;
    setLoading(true);
    setFailed(false);
    try {
      const result = await apiFetch<SecretValueRes>("GET", `${path}/value`);
      if (!alive.current || request.current !== mine) return;
      if (typeof result?.value === "string") setValue(result.value);
      else setFailed(true);
    } catch {
      if (alive.current && request.current === mine) setFailed(true);
    } finally {
      if (alive.current && request.current === mine) setLoading(false);
    }
  }

  function hide() {
    request.current++;
    setValue(null);
    setLoading(false);
  }

  return (
    <div
      data-secret-value
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginTop: 6,
        minWidth: 0,
      }}
    >
      <code
        data-secret-value-text
        style={{
          ...mono,
          fontSize: 11.5,
          padding: "2px 7px",
          borderRadius: 5,
          background: "var(--bg-code)",
          color: "var(--text-secondary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          minWidth: 0,
        }}
      >
        {value ?? "••••••••••••••••"}
      </code>
      <Btn
        kind="link"
        disabled={loading}
        onClick={value === null ? () => void show() : hide}
        data-secret-show
      >
        {value === null ? t("integrations.show") : t("integrations.hide")}
      </Btn>
      {failed && (
        <span role="alert" style={{ ...errorText, margin: 0 }}>
          {t("integrations.secrets.showFailed")}
        </span>
      )}
    </div>
  );
}

// A yes/no panel: remove, new stand-in.
export function Confirm({
  heading,
  text,
  action,
  danger,
  request,
  onCancel,
  onDone,
  errorFor,
  ...data
}: {
  heading: Heading;
  text?: string;
  action: string;
  danger?: boolean;
  request: () => Promise<unknown>;
  onCancel: () => void;
  onDone: () => Promise<void>;
  errorFor?: (caught: unknown) => string;
  [data: `data-${string}`]: string | undefined;
}) {
  const { t } = useI18n();
  const alive = useAlive();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Panel heading={heading} {...data}>
      {text && <p style={{ ...hintText, margin: "6px 0 0" }}>{text}</p>}
      <FormButtons
        ready
        busy={busy}
        danger={danger}
        saveLabel={action}
        onCancel={onCancel}
        onSave={async () => {
          setBusy(true);
          setError(null);
          try {
            await request();
            if (alive.current) await onDone();
          } catch (caught) {
            if (alive.current)
              setError(
                errorFor ? errorFor(caught) : t("integrations.actionFailed"),
              );
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

function ReplaceValue({
  path,
  heading,
  onCancel,
  onSaved,
}: {
  path: string;
  heading: Heading;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useI18n();
  const alive = useAlive();
  const errorFor = useSecretErrorText();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Panel heading={heading} data-secret-replace-panel="">
      <Field label={t("integrations.secrets.value")}>
        <MaskedInput
          style={{ ...input, ...mono }}
          value={value}
          placeholder={t("integrations.secrets.newValuePlaceholder")}
          onChange={(e) => setValue(e.target.value)}
        />
      </Field>
      <FormButtons
        ready={value.trim().length > 0}
        busy={busy}
        saveLabel={t("settings.secrets.saveValue")}
        onCancel={onCancel}
        onSave={async () => {
          setBusy(true);
          setError(null);
          try {
            await apiFetch("PUT", `${path}/value`, { value: value.trim() });
            if (alive.current) await onSaved();
          } catch (caught) {
            if (alive.current) setError(errorFor(caught));
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

// How the service expects the value: the Authorization header (Bearer, token
// or Basic), or the whole value of another header.
function HowSent({
  form,
  header,
  onForm,
  onHeader,
}: {
  form: SecretForm["kind"];
  header: string;
  onForm: (form: SecretForm["kind"]) => void;
  onHeader: (header: string) => void;
}) {
  const { t } = useI18n();
  return (
    <Field label={t("integrations.secrets.howSent")}>
      <Choice
        label={t("integrations.secrets.howSent")}
        value={form}
        onChange={onForm}
        options={[
          { value: "authorization", label: t("integrations.secrets.bearer") },
          { value: "header", label: t("integrations.secrets.customHeader") },
        ]}
      />
      {form === "header" && (
        <input
          aria-label={t("settings.secrets.headerName")}
          style={{ ...input, ...mono, marginTop: 6 }}
          value={header}
          spellCheck={false}
          placeholder={t("integrations.secrets.headerPlaceholder")}
          onChange={(e) => onHeader(e.target.value)}
        />
      )}
    </Field>
  );
}

function AddressesField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  return (
    <Field
      label={t("integrations.secrets.addresses")}
      hint={t("integrations.secrets.addressesHint")}
    >
      <textarea
        data-secret-hosts
        rows={3}
        spellCheck={false}
        style={{ ...input, ...mono, minHeight: 54, resize: "vertical" }}
        value={value}
        placeholder="api.example.com"
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

// The apps whose environment gets the value (task c7007f8b): the target
// member's own apps for a member secret, every app for an office secret.
// The server checks the same rule; the list only offers what it accepts.
function AppsField({
  target,
  ownerUserId,
  value,
  onChange,
}: {
  target: Target;
  ownerUserId: string | null;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const { t } = useI18n();
  const alive = useAlive();
  const [apps, setApps] = useState<string[] | null>(null);
  useEffect(() => {
    apiFetch<AppListWire[]>("GET", "/api/apps")
      .then((list) => {
        if (!alive.current || !Array.isArray(list)) return;
        setApps(
          list
            .filter(
              (app) =>
                target.kind === "office" ||
                (ownerUserId !== null && app.userId === ownerUserId),
            )
            .map((app) => app.name)
            .sort(),
        );
      })
      .catch(() => {
        if (alive.current) setApps([]);
      });
    // The field is keyed by its form; the target never changes in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // An app the secret already has stays on the list, so it can be removed.
  const names = [...new Set([...(apps ?? []), ...value])].sort();
  return (
    <div data-secret-apps style={{ marginTop: 12 }}>
      <span
        style={{
          display: "block",
          fontSize: 12,
          fontWeight: 600,
          color: "var(--text-dim)",
          marginBottom: 5,
        }}
      >
        {t("integrations.secrets.apps")}
      </span>
      {apps === null ? (
        <span style={hintText}>{t("common.loading")}</span>
      ) : names.length === 0 ? (
        <span style={hintText}>{t("integrations.secrets.noApps")}</span>
      ) : (
        names.map((name) => (
          <label
            key={name}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12.5,
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              data-secret-app={name}
              checked={value.includes(name)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...value, name].sort()
                    : value.filter((v) => v !== name),
                )
              }
              style={{ cursor: "pointer", margin: 0 }}
            />
            <span style={mono}>{name}</span>
          </label>
        ))
      )}
      <span style={{ ...hintText, display: "block", marginTop: 4 }}>
        {t("integrations.secrets.appsHint")}
      </span>
    </div>
  );
}

function MoreOptions({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <div style={{ marginTop: 10 }}>
        <Btn
          kind="link"
          onClick={() => setOpen(!open)}
          data-more-options
          style={{ fontSize: 12 }}
        >
          {open ? "▾" : "▸"} {t("integrations.moreOptions")}
        </Btn>
      </div>
      {open && children}
    </>
  );
}

export { MoreOptions, HowSent };

const OTHER = "other";

function AddSecret({
  path,
  target,
  ownerUserId,
  onCancel,
  onSaved,
}: {
  path: string;
  target: Target;
  ownerUserId: string | null;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useI18n();
  const whoseHeading = useWhose();
  const alive = useAlive();
  const errorFor = useSecretErrorText();
  const first = SECRET_PRESETS[0];
  const [service, setService] = useState<string>(first?.id ?? OTHER);
  const preset = SECRET_PRESETS.find((p) => p.id === service);
  const [name, setName] = useState(preset?.name ?? "");
  const [hosts, setHosts] = useState(preset?.hosts.join("\n") ?? "");
  const [form, setForm] = useState<SecretForm["kind"]>(
    preset?.form.kind ?? "authorization",
  );
  const [header, setHeader] = useState(
    preset?.form.kind === "header" ? preset.form.header : "",
  );
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [apps, setApps] = useState<string[]>([]);
  const [showHosts, setShowHosts] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A preset fills its fields; Other clears what a preset filled (Nil,
  // 2026-10-13).
  function pick(next: string) {
    setService(next);
    const p = SECRET_PRESETS.find((x) => x.id === next);
    setName(p?.name ?? "");
    setHosts(p?.hosts.join("\n") ?? "");
    setForm(p?.form.kind ?? "authorization");
    setHeader(p?.form.kind === "header" ? p.form.header : "");
    setShowHosts(false);
  }

  const hostList = hostsOf(hosts);
  // A secret goes to an address, an app, or both.
  const ready =
    name.trim().length > 0 &&
    value.trim().length > 0 &&
    (hostList.length > 0 || apps.length > 0);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch("POST", path, {
        name: name.trim(),
        value: value.trim(),
        hosts: hostList,
        form:
          form === "header"
            ? { kind: "header", header: header.trim() }
            : { kind: "authorization" },
        ...(note.trim() ? { note } : {}),
        ...(apps.length > 0 ? { apps } : {}),
      });
      if (alive.current) await onSaved();
    } catch (caught) {
      // The value stays out of the error; the field keeps it only so the
      // member can fix another field and save again.
      if (alive.current) setError(errorFor(caught));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <Panel
      heading={whoseHeading("integrations.secrets.addHeading", target)}
      data-secret-add=""
    >
      <Field label={t("settings.secrets.preset")}>
        <Choice
          label={t("settings.secrets.preset")}
          value={service}
          onChange={pick}
          options={[
            ...SECRET_PRESETS.map((p) => ({ value: p.id, label: p.label })),
            { value: OTHER, label: t("settings.secrets.presetCustom") },
          ]}
        />
      </Field>
      {!preset && (
        <Field
          label={t("settings.secrets.name")}
          hint={t("integrations.secrets.nameHint")}
        >
          <input
            data-secret-name-input
            style={{ ...input, ...mono }}
            value={name}
            spellCheck={false}
            autoComplete="off"
            placeholder="MY_API_KEY"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
      )}
      <Field label={t("integrations.secrets.value")}>
        <MaskedInput
          data-secret-value-input
          style={{ ...input, ...mono }}
          value={value}
          placeholder={t("integrations.secrets.valuePlaceholder")}
          onChange={(e) => setValue(e.target.value)}
        />
      </Field>
      {preset ? (
        <div style={{ ...hintText, marginTop: 8 }}>
          {t("integrations.secrets.presetGoesTo", { service: preset.label })}{" "}
          <Btn
            kind="link"
            onClick={() => setShowHosts(!showHosts)}
            data-show-addresses
          >
            {showHosts
              ? t("integrations.secrets.hideAddresses")
              : t("integrations.secrets.showAddresses")}
          </Btn>
          {showHosts && (
            <div
              data-preset-hosts
              style={{ ...mono, fontSize: 11.5, marginTop: 4 }}
            >
              {preset.hosts.join(", ")} · {preset.name}
            </div>
          )}
        </div>
      ) : (
        <>
          <AddressesField value={hosts} onChange={setHosts} />
          <MoreOptions>
            <HowSent
              form={form}
              header={header}
              onForm={setForm}
              onHeader={setHeader}
            />
          </MoreOptions>
        </>
      )}
      <AppsField
        target={target}
        ownerUserId={ownerUserId}
        value={apps}
        onChange={setApps}
      />
      <div style={{ marginTop: 4 }}>
        <ConnectionNoteField value={note} onChange={setNote} />
      </div>
      <FormButtons
        ready={ready}
        busy={busy}
        saveLabel={t("common.save")}
        onCancel={onCancel}
        onSave={() => void save()}
      />
      {error && (
        <p role="alert" style={errorText}>
          {error}
        </p>
      )}
    </Panel>
  );
}

function EditSecret({
  path,
  target,
  ownerUserId,
  secret,
  heading,
  onCancel,
  onReissue,
  onSaved,
}: {
  path: string;
  target: Target;
  ownerUserId: string | null;
  secret: SecretRow & { form: SecretForm };
  heading: Heading;
  onCancel: () => void;
  onReissue: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useI18n();
  const alive = useAlive();
  const errorFor = useSecretErrorText();
  const [hosts, setHosts] = useState(secret.hosts.join("\n"));
  const [form, setForm] = useState<SecretForm["kind"]>(secret.form.kind);
  const [header, setHeader] = useState(
    secret.form.kind === "header" ? secret.form.header : "",
  );
  const [note, setNote] = useState(secret.note ?? "");
  const [apps, setApps] = useState<string[]>(secret.apps);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Panel heading={heading} data-secret-edit-panel="">
      <AddressesField value={hosts} onChange={setHosts} />
      <HowSent
        form={form}
        header={header}
        onForm={setForm}
        onHeader={setHeader}
      />
      <AppsField
        target={target}
        ownerUserId={ownerUserId}
        value={apps}
        onChange={setApps}
      />
      <div style={{ marginTop: 4 }}>
        <ConnectionNoteField value={note} onChange={setNote} />
      </div>
      <div style={{ ...hintText, marginTop: 4 }}>
        <Btn kind="link" onClick={onReissue} data-secret-reissue>
          {t("settings.secrets.reissue")}
        </Btn>
        {" · "}
        {t("integrations.secrets.reissueHint")}
      </div>
      <FormButtons
        ready={hostsOf(hosts).length > 0 || apps.length > 0}
        busy={busy}
        saveLabel={t("common.save")}
        onCancel={onCancel}
        onSave={async () => {
          setBusy(true);
          setError(null);
          try {
            await apiFetch("PATCH", path, {
              hosts: hostsOf(hosts),
              form:
                form === "header"
                  ? { kind: "header", header: header.trim() }
                  : { kind: "authorization" },
              note,
              // Only a change: the list the secret has goes unsent.
              ...(sameList(apps, secret.apps) ? {} : { apps }),
            });
            if (alive.current) await onSaved();
          } catch (caught) {
            if (alive.current) setError(errorFor(caught));
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

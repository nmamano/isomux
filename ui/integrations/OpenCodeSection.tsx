// OpenCode on the Model providers tab, laid out like the Claude and Codex
// cards: rows that are always drawn (free models, paid models and the key,
// your own model server), their content held while it loads. On another
// member's card (an owner) it is one row beside Claude and Codex.
//
// `keySet`: whether the card's own OPENCODE_API_KEY variable is set, from the
// variable names the page already reads; null while they are not read. The key
// is a variable, never a secret: opencode.ai is on the secrets never-list.
//
// GET /api/me/opencode gives the office's free-limit state (the limit is per
// network) and where the viewer's agents get the key. The model listing runs
// on the viewer's own card only: on the office card it would mix in the
// viewer's personal key. Both are read again on Refresh and after a saved
// variable.

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { OpenCodeStatusRes } from "../../shared/contract-shapes.ts";
import type { EnvVariableSource } from "../../shared/types.ts";
import type { MessageKey } from "../../shared/i18n/translate.ts";
import { timeSince } from "../../shared/i18n/time.ts";
import { apiFetch } from "../api.ts";
import { fetchBackendModels } from "../backend-model-selection.ts";
import { useAppState } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { useCan } from "../hooks/useCan.ts";
import { MaskedInput } from "../components/MaskedInput.tsx";
import { ProviderMark } from "../components/ProviderMark.tsx";
import { Reserved } from "../components/Reserved.tsx";
import {
  notifyManagedEnvSaved,
  onManagedEnvSaved,
} from "../connections-events.ts";
import {
  Btn,
  Field,
  FormButtons,
  ItemRow,
  Panel,
  Pill,
  errorText,
  input,
  mono,
  useWhose,
  type Heading,
} from "./kit.tsx";
import { Confirm } from "./SecretsSection.tsx";
import {
  deleteEnvVariable,
  envErrorText,
  putEnvVariable,
} from "./env-write.ts";
import { useAlive } from "./use-alive.ts";
import { canEdit, type Role, type Target } from "./target.ts";

const KEY = "OPENCODE_API_KEY";
const OWN_SERVER_DOCS =
  "https://isomux.com/docs/llm-providers#opencode-on-your-own-model-server";

// OpenCode's house providers: "opencode" (Zen, pay as you go) and
// "opencode-go" (the Go subscription). Their free models are the "opencode/"
// ones: Go refuses its "-free" models without a subscription
// (shared/opencode-model.ts). Every other provider is a server of your own.
const isHouse = (id: string) =>
  id.startsWith("opencode/") || id.startsWith("opencode-go/");

// Where the viewer's agents get the key, one sentence per source, so a new
// source fails tsc.
const KEY_SOURCE_LINE = {
  member_variable: "integrations.providers.opencode.key.member",
  member_secret: "integrations.providers.opencode.key.member",
  office_variable: "integrations.providers.opencode.key.officeVariable",
  office_secret: "integrations.providers.opencode.key.office",
  server: "integrations.providers.opencode.key.server",
} as const satisfies Record<EnvVariableSource, MessageKey>;

// The section flat inside the page's card, as the sign-in cards are.
const flat: CSSProperties = {
  borderTop: "1px solid var(--border-subtle)",
  padding: "12px 2px 4px",
  marginTop: 14,
};

export function OpenCodeSection({
  target,
  role,
  keySet,
  refreshes,
}: {
  target: Target;
  role: Role;
  keySet: boolean | null;
  // Counts the tab's Refresh clicks: each one reads again.
  refreshes: number;
}) {
  if (target.kind === "member")
    return <MemberOpenCodeRow target={target} role={role} keySet={keySet} />;
  return (
    <OpenCodeCard
      target={target}
      role={role}
      keySet={keySet}
      refreshes={refreshes}
    />
  );
}

// A read of `load` on mount, on each Refresh and after a saved variable. The
// last answer stays while a new read is out, so nothing flickers. A failed
// read answers `failed` and drops the last answer.
function useReread<T>(
  enabled: boolean,
  refreshes: number,
  load: () => Promise<T>,
): { value: T | null; failed: boolean } {
  const alive = useAlive();
  const [value, setValue] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const [saves, setSaves] = useState(0);
  // Only the latest read's answer counts: a Refresh and a save can overlap.
  const latest = useRef(0);
  useEffect(
    () =>
      enabled ? onManagedEnvSaved(() => setSaves((n) => n + 1)) : undefined,
    [enabled],
  );
  useEffect(() => {
    if (!enabled) return;
    const read = ++latest.current;
    load()
      .then((next) => {
        if (!alive.current || read !== latest.current) return;
        setValue(next);
        setFailed(false);
      })
      .catch(() => {
        if (!alive.current || read !== latest.current) return;
        // A failed read keeps no answer it could be mistaken for.
        setValue(null);
        setFailed(true);
      });
    // The load is the same for the life of the section.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, refreshes, saves]);
  return { value, failed };
}

function OpenCodeCard({
  target,
  role,
  keySet,
  refreshes,
}: {
  target: Target & { kind: "office" | "self" };
  role: Role;
  keySet: boolean | null;
  refreshes: number;
}) {
  const { t, rich, tn, language } = useI18n();
  const { unavailableEngines } = useAppState();
  const office = target.kind === "office";
  const status = useReread(true, refreshes, () =>
    apiFetch<OpenCodeStatusRes>("GET", "/api/me/opencode"),
  );
  // The route answers a failed listing with 200 and an error: that is no
  // answer, not an empty list.
  const listing = useReread(!office, refreshes, () =>
    fetchBackendModels("/api/backends/opencode/models", { cwd: "~" }).then(
      (result) => {
        if (result.error || !Array.isArray(result.models))
          throw new Error(result.error ?? "No models listed.");
        return result.models;
      },
    ),
  );
  const statusIn = status.value !== null || status.failed;
  const modelsIn = office || listing.value !== null || listing.failed;
  const models = listing.value ?? [];
  const keySource = status.value?.keySource ?? null;
  // The key this card's agents use: the office variable on the office card,
  // whatever source the viewer's agents read on their own card.
  const usesKey: boolean | null = office
    ? keySet
    : status.value
      ? keySource !== null
      : null;
  const freeLimitAt = status.value?.freeLimitAt ?? null;

  const freeLabels = models
    .filter((model) => model.isFree && model.id.startsWith("opencode/"))
    .map((model) => model.label);
  const paidCount = models.filter(
    (model) => isHouse(model.id) && !model.isFree,
  ).length;
  const ownLabels = models
    .filter((model) => !isHouse(model.id))
    .map((model) => model.label);

  const since = freeLimitAt === null ? null : timeSince(language, freeLimitAt);
  const ago =
    since === null
      ? ""
      : since.kind === "now"
        ? t("common.justNow")
        : since.text;

  const freeIn = statusIn && modelsIn;
  // A failed status read still draws the row, with its controls (they act on
  // the card's own variable) and no key state.
  const paidIn = freeIn && keySet !== null;

  // Each line of a row is one line at any width (ellipsis, the whole text in
  // its title), so an answer takes exactly the place its held line kept.
  const limitText =
    freeLimitAt === null
      ? null
      : t(
          usesKey
            ? "integrations.providers.opencode.freeLimit.keyed"
            : "integrations.providers.opencode.freeLimit.keyless",
          { time: ago },
        );
  const freeText =
    !office && freeLabels.length > 0
      ? freeLabels.join(", ")
      : t("integrations.providers.opencode.free.bundled");
  // While the free limit stands, it takes the line of the free models.
  const freeContent =
    limitText === null ? (
      <OneLine text={freeText} />
    ) : (
      <OneLine
        text={limitText}
        data-opencode-free-limit={usesKey ? "keyed" : "keyless"}
        color="var(--orange-text)"
      />
    );

  let keyLine: string;
  if (status.failed && !office) keyLine = t("settings.connections.checkFailed");
  else if (office)
    keyLine = keySet
      ? t("integrations.providers.opencode.key.officeCard")
      : t("integrations.providers.opencode.key.none");
  else
    keyLine = keySource
      ? t(KEY_SOURCE_LINE[keySource])
      : t("integrations.providers.opencode.key.none");
  const paidContent = <OneLine text={keyLine} />;
  // The count sits beside the title, so it adds no line.
  const paidCountPill =
    paidIn && usesKey && !office && listing.value !== null ? (
      <Pill tone="neutral">
        {tn("integrations.providers.opencode.paidCount", paidCount)}
      </Pill>
    ) : undefined;
  // Your own server's models, on the viewer's card: a line always drawn,
  // held until the listing answers.
  const ownLine = (
    <OneLine
      text={
        ownLabels.length > 0
          ? t("integrations.providers.opencode.ownServer.listed", {
              models: ownLabels.join(", "),
            })
          : t("integrations.providers.opencode.ownServer.none")
      }
    />
  );

  const headerPill =
    freeLimitAt !== null ? (
      <Pill tone="orange">
        {t("integrations.providers.opencode.pill.freeLimit")}
      </Pill>
    ) : usesKey ? (
      <Pill tone="green">
        {t("integrations.providers.opencode.pill.keySet")}
      </Pill>
    ) : usesKey === false ? (
      <Pill tone="neutral">
        {t("integrations.providers.opencode.pill.freeOnly")}
      </Pill>
    ) : null;

  return (
    <section data-provider-block="opencode" style={flat}>
      <h5
        style={{
          margin: "0 0 4px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <ProviderMark provider="opencode" />
        OpenCode
        {statusIn && (
          <span
            title={
              freeLimitAt === null
                ? undefined
                : t("integrations.providers.opencode.freeLimit.about")
            }
          >
            {headerPill}
          </span>
        )}
        {unavailableEngines.opencode !== undefined && (
          <Pill tone="orange" data-opencode-unavailable="">
            {t("dialogs.agent.engineNeedsLinux")}
          </Pill>
        )}
      </h5>
      <ItemRow
        data-opencode-row="free"
        title={t("integrations.providers.opencode.free.title")}
        detail={freeIn ? freeContent : <Reserved>{freeContent}</Reserved>}
      />
      <KeyRow
        target={target}
        role={role}
        ownKeySet={keySet}
        attrs={{
          "data-opencode-row": "paid",
          "data-opencode-key":
            paidIn && usesKey !== null ? (usesKey ? "set" : "none") : undefined,
          "data-opencode-key-source":
            paidIn && !office && keySource ? keySource : undefined,
          "data-opencode-paid-count":
            paidIn && usesKey && !office && listing.value !== null
              ? String(paidCount)
              : undefined,
        }}
        title={t("integrations.providers.opencode.paid.title")}
        detail={paidIn ? paidContent : <Reserved>{paidContent}</Reserved>}
        status={paidCountPill}
        ready={paidIn}
      />
      <ItemRow
        data-opencode-row="own-server"
        title={t("integrations.providers.opencode.ownServer.title")}
        detail={
          <>
            <span>
              {rich("integrations.providers.opencode.ownServer.text", {
                link: (chunk: ReactNode) => (
                  <a href={OWN_SERVER_DOCS} target="_blank" rel="noreferrer">
                    {chunk}
                  </a>
                ),
              })}
            </span>
            {!office && (modelsIn ? ownLine : <Reserved>{ownLine}</Reserved>)}
          </>
        }
      />
    </section>
  );
}

// An owner on another member's card: whether the member has their own key
// (from the member's variable names), and the same Add, Replace and Remove.
// The row keeps what a save here did, as the names are read once.
function MemberOpenCodeRow({
  target,
  role,
  keySet,
}: {
  target: Target & { kind: "member" };
  role: Role;
  keySet: boolean | null;
}) {
  const { t } = useI18n();
  const [saved, setSaved] = useState<boolean | null>(null);
  const set = saved ?? keySet;
  const pill = (
    <Pill tone={set ? "green" : "neutral"}>
      {t(
        set
          ? "integrations.providers.opencode.pill.keySet"
          : "integrations.providers.opencode.pill.noKey",
      )}
    </Pill>
  );
  return (
    <KeyRow
      target={target}
      role={role}
      ownKeySet={set}
      onSaved={setSaved}
      attrs={{ "data-member-provider": "opencode" }}
      logo={<ProviderMark provider="opencode" size={28} />}
      title="OpenCode"
      status={
        <span
          data-opencode-key={set === null ? undefined : set ? "set" : "none"}
        >
          {set === null ? <Reserved>{pill}</Reserved> : pill}
        </span>
      }
      ready={set !== null}
    />
  );
}

// A row with the card's own key controls: Add or Replace opens a credential
// field, Remove a confirm. Shown to whoever may edit the card's variables.
function KeyRow({
  target,
  role,
  ownKeySet,
  onSaved,
  attrs,
  logo,
  title,
  detail,
  status,
  ready,
}: {
  target: Target;
  role: Role;
  // The card's own variable: Replace and Remove act on it.
  ownKeySet: boolean | null;
  onSaved?: (set: boolean) => void;
  attrs: Record<`data-${string}`, string | undefined>;
  logo?: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  status?: ReactNode;
  ready: boolean;
}) {
  const { t } = useI18n();
  const whoseHeading = useWhose();
  const environmentWrite = useCan("environment", "write");
  const editable = canEdit(target, role) && environmentWrite;
  const [mode, setMode] = useState<"idle" | "edit" | "remove">("idle");
  const close = () => setMode("idle");
  const done = (set: boolean) => {
    close();
    onSaved?.(set);
    notifyManagedEnvSaved();
  };
  // Drawn, disabled, while the row waits for its answer: the actions line
  // is there before the answer (on a phone it is a line of its own).
  const actions =
    editable && mode === "idle" ? (
      <>
        <Btn
          small
          disabled={!ready}
          onClick={() => setMode("edit")}
          data-opencode-key-edit
        >
          {t(
            ownKeySet
              ? "integrations.providers.opencode.replaceKey"
              : "integrations.providers.opencode.addKey",
          )}
        </Btn>
        {ready && ownKeySet && (
          <Btn
            small
            kind="danger"
            onClick={() => setMode("remove")}
            data-opencode-key-remove
          >
            {t("integrations.remove")}
          </Btn>
        )}
      </>
    ) : undefined;
  return (
    <ItemRow
      {...attrs}
      logo={logo}
      title={title}
      detail={detail}
      status={status}
      actions={actions}
    >
      {mode === "edit" && (
        <KeyEditor
          heading={whoseHeading(
            "integrations.providers.opencode.keyHeading",
            target,
          )}
          onCancel={close}
          onSave={async (value) => {
            await putEnvVariable(target, KEY, { value });
            done(true);
          }}
        />
      )}
      {mode === "remove" && (
        <Confirm
          data-opencode-remove-panel=""
          heading={whoseHeading("integrations.dialog.remove", target, {
            name: KEY,
          })}
          action={t("integrations.remove")}
          danger
          request={() => deleteEnvVariable(target, KEY)}
          errorFor={(caught) =>
            envErrorText(caught, t("settings.env.saveFailed"))
          }
          onCancel={close}
          onDone={async () => done(false)}
        />
      )}
    </ItemRow>
  );
}

function KeyEditor({
  heading,
  onCancel,
  onSave,
}: {
  heading: Heading;
  onCancel: () => void;
  onSave: (value: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const alive = useAlive();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Panel heading={heading} data-opencode-key-panel="">
      <Field label={t("integrations.providers.opencode.keyLabel")}>
        <MaskedInput
          style={{ ...input, ...mono }}
          value={value}
          placeholder="sk-..."
          onChange={(e) => setValue(e.target.value)}
        />
      </Field>
      <FormButtons
        ready={value.trim().length > 0}
        busy={busy}
        saveLabel={t("common.save")}
        onCancel={onCancel}
        onSave={async () => {
          setBusy(true);
          setError(null);
          try {
            await onSave(value.trim());
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

// One line of a row's detail: never wraps, so its height is known before
// the answer; a longer text ends in an ellipsis and shows whole in its title.
function OneLine({
  text,
  color,
  ...data
}: {
  text: string;
  color?: string;
  [data: `data-${string}`]: string | undefined;
}) {
  return (
    <span
      {...data}
      title={text}
      style={{
        display: "block",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        color,
      }}
    >
      {text}
    </span>
  );
}

// The Voice tab of Integrations (task 4481e64b): what the member's mic and
// read aloud use, saved on each change, and which variable holds the OpenAI
// key. The status names the variable and its source, never a value. On
// another member's card (an owner, task 7a3b4114) it reads and saves that
// member's choices on their route.

import { useEffect, useState, type ReactNode } from "react";
import { apiFetch } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { useSelfUser } from "../hooks/useSelfUser.ts";
import { canUse } from "../hooks/useCan.ts";
import type {
  MemberVoiceReq,
  MemberVoiceRes,
  PreferencesReq,
} from "../../shared/contract-shapes.ts";
import type { EnvVariableSource } from "../../shared/types.ts";
import {
  DEFAULT_VOICE_NAME,
  VOICE_KEY_NAME,
  VOICE_NAMES,
  type VoiceInput,
  type VoiceName,
  type VoiceOutput,
  type VoiceStatusRes,
} from "../../shared/voice.ts";
import { errorText, hintText, input } from "./kit.tsx";
import { basePath, isGone, type Target } from "./target.ts";

type UsableKey =
  | "integrations.voice.key.member"
  | "integrations.voice.key.office"
  | "integrations.voice.key.server";

const USABLE: Partial<Record<EnvVariableSource, UsableKey>> = {
  member_variable: "integrations.voice.key.member",
  office_variable: "integrations.voice.key.office",
  server: "integrations.voice.key.server",
};

type Prefs = {
  voiceInput: VoiceInput;
  voiceOutput: VoiceOutput;
  voiceName: VoiceName;
};

// onVariables switches the page to the Variables tab; without it the link
// opens that tab's address. `target` is whose choices: the viewer's own (the
// default) or, for an owner, another member's; onGone runs when that member
// is no longer in the office.
export function VoiceSection({
  onVariables,
  target,
  onGone,
}: {
  onVariables?: () => void;
  target?: Target;
  onGone?: () => void;
} = {}) {
  const { t } = useI18n();
  const self = useSelfUser();
  const member = target?.kind === "member" ? target : null;
  const path = member ? `${basePath(member)}/voice` : null;
  // Another member's choices and key line, read from their route.
  const [theirs, setTheirs] = useState<MemberVoiceRes | null>(null);
  const record = member ? theirs : self;
  const saved: Prefs = {
    voiceInput: record?.voiceInput ?? "browser",
    voiceOutput: record?.voiceOutput ?? "browser",
    voiceName: record?.voiceName ?? DEFAULT_VOICE_NAME,
  };
  // A change shows at once; the self record catches up over the socket.
  const [pending, setPending] = useState<Partial<Prefs>>({});
  const prefs = { ...saved, ...pending };
  const [saveFailed, setSaveFailed] = useState(false);
  // When the self record changes (this save landing, or a change from
  // another device), the keys it changed leave pending, so it shows here.
  const [seen, setSeen] = useState(saved);
  const changedKeys = (Object.keys(saved) as (keyof Prefs)[]).filter(
    (key) => saved[key] !== seen[key],
  );
  if (changedKeys.length > 0) {
    setSeen(saved);
    setPending((prev) => {
      const next = { ...prev };
      for (const key of changedKeys) delete next[key];
      return next;
    });
  }
  const [status, setStatus] = useState<VoiceStatusRes | null>(null);

  useEffect(() => {
    let live = true;
    if (path) {
      apiFetch<MemberVoiceRes>("GET", path)
        .then((res) => {
          if (!live) return;
          setTheirs(res);
          setStatus({ keySource: res.keySource, keyName: res.keyName });
        })
        .catch((caught) => {
          if (live && member && isGone(caught, member)) onGone?.();
        });
    } else {
      apiFetch<VoiceStatusRes>("GET", "/api/voice")
        .then((res) => {
          if (live) setStatus(res);
        })
        .catch(() => {});
    }
    return () => {
      live = false;
    };
    // The member's route is the whole input; onGone and member follow it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  function save(change: Partial<Prefs>) {
    setPending((prev) => ({ ...prev, ...change }));
    setSaveFailed(false);
    const write = path
      ? apiFetch("PATCH", path, change satisfies MemberVoiceReq).then(() => {
          // No socket event carries another member's record to this card:
          // the saved choice is what this card just sent.
          setTheirs((prev) => (prev ? { ...prev, ...change } : prev));
        })
      : apiFetch(
          "PATCH",
          "/api/me/preferences",
          change satisfies PreferencesReq,
        );
    write.catch((caught) => {
      setPending((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(change) as (keyof Prefs)[]) {
          delete next[key];
        }
        return next;
      });
      if (member && isGone(caught, member)) onGone?.();
      else setSaveFailed(true);
    });
  }

  const source = status?.keySource ?? null;
  const name = status?.keyName ?? VOICE_KEY_NAME;
  const usable = source ? USABLE[source] : undefined;
  const keyLine =
    member && source === "member_variable"
      ? t("integrations.voice.key.theirs", { name, member: member.username })
      : usable
        ? t(usable, { name })
        : source
          ? t("integrations.voice.key.secret", { name })
          : member
            ? t("integrations.voice.key.noneTheirs", {
                member: member.username,
              })
            : canUse(self, "environment", "write")
              ? t("integrations.voice.key.none")
              : t("voice.keyMissing.askOwner");
  // A member whose permission pack hides the Variables tab gets no link to it
  // (task 93191798). An owner on another member's card has no pack.
  const variablesShown = canUse(self, "environment", "read");
  // Another member's choices show once read, so nothing is set on a guess.
  const loading = !!member && !theirs;

  return (
    <section data-integrations-card="voice" inert={loading} aria-busy={loading}>
      <Row label={t("integrations.voice.mic")}>
        <Radios
          name="voiceInput"
          value={prefs.voiceInput}
          onChange={(voiceInput) => save({ voiceInput })}
        />
      </Row>
      <Row label={t("integrations.voice.readAloud")}>
        <Radios
          name="voiceOutput"
          value={prefs.voiceOutput}
          onChange={(voiceOutput) => save({ voiceOutput })}
        />
        {prefs.voiceOutput === "openai" && (
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={hintText}>{t("integrations.voice.voiceName")}</span>
            <select
              name="voiceName"
              value={prefs.voiceName}
              onChange={(e) => save({ voiceName: e.target.value as VoiceName })}
              style={{ ...input, width: "auto", padding: "4px 8px" }}
            >
              {VOICE_NAMES.map((voice) => (
                <option key={voice} value={voice}>
                  {voice}
                </option>
              ))}
            </select>
          </label>
        )}
      </Row>
      {saveFailed && (
        <p role="alert" style={{ ...errorText, margin: "10px 0 0" }}>
          {t("integrations.voice.saveFailed")}
        </p>
      )}
      <p
        data-key-source={source ?? "none"}
        style={{ ...hintText, margin: "14px 0 0" }}
      >
        {keyLine}
        {variablesShown && (
          <>
            {" "}
            <a
              href="/integrations/variables"
              onClick={(e) => {
                if (!onVariables) return;
                e.preventDefault();
                onVariables();
              }}
              style={{ color: "var(--accent-text)" }}
            >
              {t("voice.openVariables")}
            </a>
          </>
        )}
      </p>
      <p style={{ ...hintText, margin: "6px 0 0" }}>
        {member
          ? t("integrations.voice.whereTheirs", { member: member.username })
          : t("integrations.voice.where")}
      </p>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label={label}
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: "8px 16px",
        marginTop: 10,
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 600, minWidth: 90 }}>
        {label}
      </span>
      {children}
    </div>
  );
}

function Radios<T extends VoiceInput>({
  name,
  value,
  onChange,
}: {
  name: string;
  value: T;
  onChange: (value: T) => void;
}) {
  const { t } = useI18n();
  const options = [
    ["browser", t("integrations.voice.browser")],
    ["openai", t("integrations.voice.openai")],
  ] as const;
  return (
    <span style={{ display: "inline-flex", gap: 14 }}>
      {options.map(([option, label]) => (
        <label
          key={option}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 12.5,
            cursor: "pointer",
          }}
        >
          <input
            type="radio"
            name={name}
            value={option}
            checked={value === option}
            onChange={() => onChange(option as T)}
          />
          {label}
        </label>
      ))}
    </span>
  );
}

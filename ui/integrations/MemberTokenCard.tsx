import { useEffect, useState, type CSSProperties } from "react";
import type {
  MemberTokenSetReq,
  MemberTokenViewRes,
} from "../../shared/contract-shapes.ts";
import { apiFetch, ApiError } from "../api.ts";
import { useConfirmStep } from "../hooks/useConfirmStep.ts";
import { useI18n } from "../i18n.tsx";
import {
  Btn,
  Data,
  Field,
  FormButtons,
  errorText,
  hintText,
  input,
} from "./kit.tsx";
import { useAlive } from "./use-alive.ts";

const ROUTE = "/api/office/claude-member-token";

const today = () => new Date().toISOString().slice(0, 10);

// The owner's Claude token for members with their own OS user
// (server/claude-member-token.ts), on the Model providers tab: their agents
// continue on it when the fallback to the office sign-in applies. Shows only
// while such a member exists or a token is set. The token is never read back.
export function MemberTokenCard({ style }: { style?: CSSProperties }) {
  const { t, rich, language } = useI18n();
  const alive = useAlive();
  // A removed token cannot come back: Remove asks "Confirm?" first.
  const removeStep = useConfirmStep();
  const [view, setView] = useState<MemberTokenViewRes | null>(null);
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState("");
  const [madeOn, setMadeOn] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<MemberTokenViewRes>("GET", ROUTE)
      .then((next) => {
        if (alive.current) setView(next);
      })
      .catch(() => {});
    // Read once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!view || (!view.inUse && !view.set)) return null;

  async function run(method: "PUT" | "DELETE", body?: MemberTokenSetReq) {
    setBusy(true);
    setError(null);
    try {
      const next = await apiFetch<MemberTokenViewRes>(method, ROUTE, body);
      if (!alive.current) return;
      setView(next);
      setEditing(false);
      setToken("");
      setMadeOn(today());
    } catch (caught) {
      if (!alive.current) return;
      setError(
        caught instanceof ApiError && caught.message
          ? caught.message
          : t("integrations.memberToken.failed"),
      );
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const date = (at: number) =>
    new Date(at).toLocaleDateString(language, { dateStyle: "medium" });
  const showForm = editing || !view.set;

  return (
    <section style={style} data-member-token>
      <h3 style={{ margin: 0, fontSize: 14 }}>
        {t("integrations.memberToken.title")}
      </h3>
      <p style={{ ...hintText, margin: "6px 0 0" }}>
        {rich("integrations.memberToken.hint", {
          code: (chunk) => <Data>{chunk}</Data>,
        })}
      </p>
      {view.set && !editing && view.expiresAt !== null && (
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
            marginTop: 10,
          }}
        >
          <span data-member-token-expires>
            {t("integrations.memberToken.expires", {
              date: date(view.expiresAt),
            })}
          </span>
          <Btn small onClick={() => setEditing(true)} disabled={busy}>
            {t("integrations.memberToken.replace")}
          </Btn>
          <Btn
            small
            kind="danger"
            onClick={() =>
              removeStep.confirm("remove", () => void run("DELETE"))
            }
            confirmProps={removeStep.bind("remove")}
            disabled={busy}
          >
            {t(
              removeStep.armed === "remove"
                ? "common.confirmQuestion"
                : "integrations.memberToken.remove",
            )}
          </Btn>
        </div>
      )}
      {showForm && (
        <>
          <Field
            label={t("integrations.memberToken.token")}
            hint={t("integrations.memberToken.tokenHint")}
          >
            <input
              type="password"
              autoComplete="off"
              style={input}
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </Field>
          <Field label={t("integrations.memberToken.madeOn")}>
            <input
              type="date"
              style={input}
              value={madeOn}
              max={today()}
              onChange={(event) => setMadeOn(event.target.value)}
            />
          </Field>
          <FormButtons
            ready={token.trim() !== ""}
            busy={busy}
            onCancel={() => {
              setEditing(false);
              setToken("");
              setError(null);
            }}
            onSave={() =>
              run("PUT", { token: token.trim(), ...(madeOn ? { madeOn } : {}) })
            }
            saveLabel={t("common.save")}
          />
        </>
      )}
      {error && (
        <p role="alert" style={errorText}>
          {error}
        </p>
      )}
    </section>
  );
}

// The Skills page: every skill an agent in the office can run, per engine,
// with where each one comes from and its full SKILL.md. User and project
// skills are editable; built-in and plugin skills are read-only. Everything
// here goes through the /api/skills routes, which agents can call too.
//
// A save carries the revision the page read. When the file changed on disk in
// between, the server refuses the save (409 stale) and the page says so and
// keeps the member's text, instead of overwriting the other edit.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppState } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { apiFetch, ApiError } from "../api.ts";
import type {
  SkillCatalogEntry,
  SkillCatalogRes,
  SkillCreateReq,
  SkillEngine,
  SkillFileRes,
  SkillSaveReq,
  SkillSaveRes,
} from "../../shared/contract-shapes.ts";
import type { PlainMessageKey } from "../../shared/i18n/translate.ts";
import { ENGINE_ACCENT, ENGINE_OPTIONS } from "../engine-options.ts";
import { Markdown } from "../log-view/Markdown.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { Portal } from "./Portal.tsx";
import { SkillSourceEditor } from "./SkillSourceEditor.tsx";
import {
  UnsavedChangesPrompt,
  useUnsavedChangesPrompt,
} from "./UnsavedChangesPrompt.tsx";
import {
  dialogCancelBtn,
  dialogInput,
  dialogLabel,
  dialogSaveBtn,
  disabledLook,
} from "./dialog-styles.ts";
import {
  entryKey,
  groupSkills,
  skillBody,
  SOURCE_BADGE_KEYS,
  SOURCE_GROUP_KEYS,
  tildePath,
  validSkillName,
} from "./skills-page.ts";

const ENGINE_KEY = "isomux:skills:engine";

// A path wraps after a slash, never inside a folder or file name. A segment
// wider than the line still wraps (overflowWrap: anywhere on the element).
function breakAfterSlashes(path: string) {
  return path.split("/").map((part, i, parts) => (
    <span key={i}>
      {part}
      {i < parts.length - 1 && (
        <>
          /<wbr />
        </>
      )}
    </span>
  ));
}

function readEngine(): SkillEngine {
  try {
    const v = localStorage.getItem(ENGINE_KEY);
    if (v === "claude" || v === "codex" || v === "opencode") return v;
  } catch {}
  return "claude";
}

type PageError = { key: PlainMessageKey } | { message: string };

type SaveProblem = "stale" | "deleted" | { message: string } | null;

const SOURCE_TONE: Record<
  SkillCatalogEntry["source"],
  { bg: string; fg: string; border: string }
> = {
  user: {
    bg: "var(--green-bg)",
    fg: "var(--green-text)",
    border: "var(--green-border)",
  },
  project: {
    bg: "var(--accent-bg)",
    fg: "var(--accent-text)",
    border: "var(--accent)",
  },
  plugin: {
    bg: "var(--orange-bg)",
    fg: "var(--orange-text)",
    border: "var(--orange-border)",
  },
  isomux: {
    bg: "var(--bg-tag)",
    fg: "var(--text-secondary)",
    border: "var(--border-medium)",
  },
};

function SourceBadge({ entry }: { entry: SkillCatalogEntry }) {
  const { t } = useI18n();
  const tone = SOURCE_TONE[entry.source];
  return (
    <span
      data-skill-source-badge={entry.source}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "1px 7px",
        borderRadius: 999,
        border: `1px solid ${tone.border}`,
        background: tone.bg,
        color: tone.fg,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.02em",
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      {t(SOURCE_BADGE_KEYS[entry.source])}
    </span>
  );
}

function LockIcon() {
  return (
    <svg
      aria-hidden="true"
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block", flexShrink: 0 }}
    >
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      style={{ display: "block" }}
    >
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      aria-hidden="true"
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      style={{ display: "block" }}
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" />
    </svg>
  );
}

const pillBtn = (active: boolean): React.CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "5px 11px",
  borderRadius: 7,
  border: "none",
  background: active ? "var(--bg-surface-solid)" : "transparent",
  boxShadow: active ? "0 1px 3px var(--shadow)" : undefined,
  color: active ? "var(--text-primary)" : "var(--text-muted)",
  fontSize: 12,
  fontWeight: active ? 600 : 500,
  cursor: "pointer",
  whiteSpace: "nowrap",
});

export function SkillsView({ onClose }: { onClose: () => void }) {
  const { isMobile, hydrationEpoch } = useAppState();
  const { t, tn } = useI18n();
  const [catalog, setCatalog] = useState<SkillCatalogRes | null>(null);
  const [loadError, setLoadError] = useState<PageError | null>(null);
  const [engine, setEngineState] = useState<SkillEngine>(readEngine);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<SkillFileRes | null>(null);
  const [fileError, setFileError] = useState<PageError | null>(null);
  const [view, setView] = useState<"source" | "preview">("source");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveProblem, setSaveProblem] = useState<SaveProblem>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [creating, setCreating] = useState(false);
  // Moves on every selection, so a slow read cannot land under another skill.
  const readGenRef = useRef(0);
  // The selection as of now, for the desktop auto-open: its effect can run
  // after a click that its render did not see yet.
  const selectedRef = useRef<string | null>(null);

  const dirty = editing && file !== null && draft !== file.content;
  // The editor text as of now, for a save answer that lands after more typing.
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  const guardRef = useRef<((after?: () => void) => void) | null>(null);
  const prompt = useUnsavedChangesPrompt(dirty, guardRef);
  // Run `action` now, or after the member agrees to drop unsaved text.
  const guarded = useCallback((action: () => void) => {
    if (guardRef.current) guardRef.current(action);
    else action();
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch<SkillCatalogRes>("GET", "/api/skills");
      setCatalog(res);
      setLoadError(null);
    } catch (err) {
      setLoadError(
        err instanceof ApiError && err.message
          ? { message: err.message }
          : { key: "skills.loadFailed" },
      );
    }
  }, []);

  useEffect(() => {
    // The fetch's setState lands after an await, never during this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, hydrationEpoch]);

  const engineSkills = useMemo(
    () => catalog?.engines.find((e) => e.engine === engine)?.skills ?? [],
    [catalog, engine],
  );
  const groups = useMemo(
    () => groupSkills(engineSkills, query),
    [engineSkills, query],
  );
  const shownCount = groups.reduce((n, g) => n + g.skills.length, 0);
  const entry = useMemo(
    () => engineSkills.find((s) => entryKey(s) === selected) ?? null,
    [engineSkills, selected],
  );
  const home = catalog?.home ?? "";

  const openEntry = useCallback(async (next: SkillCatalogEntry) => {
    const gen = ++readGenRef.current;
    selectedRef.current = entryKey(next);
    setSelected(entryKey(next));
    setFile(null);
    setFileError(null);
    setEditing(false);
    setSaveProblem(null);
    setJustSaved(false);
    try {
      const res = await apiFetch<SkillFileRes>(
        "GET",
        `/api/skills/file?path=${encodeURIComponent(next.path)}`,
      );
      if (gen !== readGenRef.current) return;
      setFile(res);
      setDraft(res.content);
    } catch (err) {
      if (gen !== readGenRef.current) return;
      setFileError(
        err instanceof ApiError && err.message
          ? { message: err.message }
          : { key: "skills.readFailed" },
      );
    }
  }, []);

  const closeEntry = useCallback(() => {
    readGenRef.current++;
    selectedRef.current = null;
    setSelected(null);
    setFile(null);
    setFileError(null);
    setEditing(false);
    setSaveProblem(null);
  }, []);

  // Desktop opens the first skill so the page never shows an empty pane on
  // arrival; on a phone the list is the first screen.
  useEffect(() => {
    if (isMobile || selected !== null || selectedRef.current !== null) return;
    const first = groups[0]?.skills[0];
    // Opening reads the file; its state changes land after the fetch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (first) void openEntry(first);
  }, [isMobile, selected, groups, openEntry]);

  function setEngine(next: SkillEngine) {
    guarded(() => {
      setEngineState(next);
      try {
        localStorage.setItem(ENGINE_KEY, next);
      } catch {}
      // Keep the open skill when the new engine lists the same file.
      const same = catalog?.engines
        .find((e) => e.engine === next)
        ?.skills.find((s) => entryKey(s) === selected);
      if (!same) closeEntry();
    });
  }

  // A save belongs to the file it was sent for and the text it sent. Its
  // answer is dropped when the member has opened another skill since (the
  // read generation moved), and text typed after Save stays in the editor.
  async function save() {
    if (!file || !entry || saving) return;
    const gen = readGenRef.current;
    const sent = draft;
    const target = file;
    setSaving(true);
    setSaveProblem(null);
    try {
      const body: SkillSaveReq = {
        path: target.path,
        content: sent,
        expectedRev: target.rev,
      };
      const res = await apiFetch<SkillSaveRes>("PUT", "/api/skills/file", body);
      if (gen !== readGenRef.current) return;
      setFile({ ...target, content: sent, rev: res.rev, mtime: res.mtime });
      if (draftRef.current === sent) setEditing(false);
      setJustSaved(true);
      void load();
    } catch (err) {
      if (gen !== readGenRef.current) return;
      const code = err instanceof ApiError ? err.code : "";
      if (code === "stale") setSaveProblem("stale");
      // A file deleted on disk drops out of the catalog, so the server
      // answers skill_not_found before it can answer deleted.
      else if (code === "deleted" || code === "skill_not_found")
        setSaveProblem("deleted");
      else
        setSaveProblem({
          message:
            err instanceof ApiError ? err.message : t("common.saveFailed"),
        });
    } finally {
      setSaving(false);
    }
  }

  // Escape leaves the page through App's handler; with unsaved text, ask
  // first. The capture listener runs before App's.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (creating) {
        e.stopPropagation();
        setCreating(false);
        return;
      }
      if (dirty) {
        e.stopPropagation();
        guarded(onClose);
      } else if (editing) {
        e.stopPropagation();
        setEditing(false);
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [creating, dirty, editing, guarded, onClose]);

  const showList = !isMobile || selected === null;
  const showDetail = !isMobile || selected !== null;

  const errorText = (e: PageError) => ("key" in e ? t(e.key) : e.message);

  function renderRow(s: SkillCatalogEntry) {
    const key = entryKey(s);
    const active = key === selected;
    return (
      <button
        key={key}
        data-skill-row={s.name}
        onClick={() => guarded(() => void openEntry(s))}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          width: "100%",
          textAlign: "left",
          padding: isMobile ? "11px 12px" : "9px 12px",
          margin: "1px 0",
          borderRadius: 8,
          border: `1px solid ${active ? "var(--border-medium)" : "transparent"}`,
          background: active ? "var(--bg-hover)" : "transparent",
          color: "var(--text-primary)",
          cursor: "pointer",
          opacity: s.shadowedBy ? 0.62 : 1,
          minWidth: 0,
        }}
      >
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minWidth: 0,
            width: "100%",
          }}
        >
          <span
            style={{
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 12.5,
              fontWeight: 600,
              color: active ? "var(--accent-text)" : "var(--text-primary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              textDecoration: s.shadowedBy ? "line-through" : undefined,
            }}
          >
            /{s.name}
          </span>
          {!s.editable && (
            <span
              title={t("skills.readOnly")}
              style={{ color: "var(--text-hint)", display: "flex" }}
            >
              <LockIcon />
            </span>
          )}
          <span style={{ flex: 1 }} />
          {s.uses > 0 && (
            <span
              title={tn("skills.uses", s.uses)}
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: "var(--text-muted)",
                fontFamily: "'JetBrains Mono',monospace",
                flexShrink: 0,
              }}
            >
              ×{s.uses}
            </span>
          )}
        </span>
        <span
          style={{
            fontSize: 11.5,
            lineHeight: 1.45,
            color: s.description ? "var(--text-secondary)" : "var(--text-hint)",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            wordBreak: "break-word",
          }}
        >
          {s.description || t("skills.noDescription")}
        </span>
        {(s.project || s.shadowedBy) && (
          <span
            style={{
              display: "flex",
              gap: 8,
              fontSize: 10.5,
              color: "var(--text-muted)",
              minWidth: 0,
            }}
          >
            {s.project && (
              <span
                style={{
                  fontFamily: "'JetBrains Mono',monospace",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {tildePath(s.project, home)}
              </span>
            )}
            {s.shadowedBy && (
              <span style={{ color: "var(--orange-text)", flexShrink: 0 }}>
                {t("skills.notUsed")}
              </span>
            )}
          </span>
        )}
      </button>
    );
  }

  const list = (
    <div
      data-skills-list=""
      style={{
        width: isMobile ? "100%" : 360,
        flexShrink: 0,
        borderRight: isMobile ? "none" : "1px solid var(--border-subtle)",
        overflowY: "auto",
        padding: isMobile ? "4px 8px 24px" : "6px 10px 24px",
        boxSizing: "border-box",
      }}
    >
      {catalog && groups.length === 0 && (
        <div
          style={{
            color: "var(--text-muted)",
            fontSize: 13,
            padding: "24px 6px",
          }}
        >
          {t("skills.empty")}
        </div>
      )}
      {groups.map((g) => (
        <section key={g.source} data-skill-group={g.source}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "14px 6px 6px",
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--text-muted)",
            }}
          >
            {t(SOURCE_GROUP_KEYS[g.source])}
            <span
              style={{
                fontWeight: 600,
                color: "var(--text-hint)",
                letterSpacing: 0,
              }}
            >
              {g.skills.length}
            </span>
          </div>
          {g.skills.map(renderRow)}
        </section>
      ))}
    </div>
  );

  const engineLabel =
    ENGINE_OPTIONS.find((o) => o.agentType === engine)?.label ?? engine;

  function renderDetail() {
    if (!entry) {
      return (
        <div
          style={{
            margin: "auto",
            color: "var(--text-muted)",
            fontSize: 13,
            padding: 24,
            textAlign: "center",
          }}
        >
          {catalog && shownCount > 0 ? t("skills.select") : null}
        </div>
      );
    }
    const readOnlyNote =
      entry.source === "isomux"
        ? t("skills.readOnly.isomux")
        : entry.source === "plugin"
          ? t("skills.readOnly.plugin", { plugin: entry.plugin ?? "" })
          : null;
    return (
      <div
        data-skill-detail={entry.name}
        style={{
          width: "100%",
          maxWidth: 960,
          padding: isMobile ? "12px 12px 32px" : "22px 28px 40px",
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        {isMobile && (
          <button
            onClick={() => guarded(closeEntry)}
            style={{
              alignSelf: "flex-start",
              background: "none",
              border: "none",
              color: "var(--accent-text)",
              fontSize: 13,
              padding: "2px 0",
              cursor: "pointer",
            }}
          >
            ← {t("skills.backToList")}
          </button>
        )}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div
            style={{
              flex: isMobile ? "1 1 100%" : 1,
              minWidth: 0,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
              }}
            >
              <h2
                style={{
                  margin: 0,
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: isMobile ? 18 : 21,
                  fontWeight: 700,
                  letterSpacing: "-0.01em",
                  overflowWrap: "anywhere",
                }}
              >
                /{entry.name}
              </h2>
              <SourceBadge entry={entry} />
              {!entry.editable && (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    fontSize: 10.5,
                    color: "var(--text-muted)",
                  }}
                >
                  <LockIcon />
                  {t("skills.readOnly")}
                </span>
              )}
            </div>
            <p
              style={{
                margin: "8px 0 0",
                fontSize: 13.5,
                lineHeight: 1.55,
                color: entry.description
                  ? "var(--text-secondary)"
                  : "var(--text-hint)",
              }}
            >
              {entry.description || t("skills.noDescription")}
            </p>
          </div>
          {entry.editable && file && (
            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              {editing ? (
                <>
                  <button
                    onClick={() =>
                      guarded(() => {
                        setEditing(false);
                        setDraft(file.content);
                        setSaveProblem(null);
                      })
                    }
                    style={dialogCancelBtn}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    data-skill-save=""
                    onClick={() => void save()}
                    disabled={!dirty || saving}
                    style={{
                      ...dialogSaveBtn,
                      ...(!dirty || saving ? disabledLook : {}),
                    }}
                  >
                    {t("common.save")}
                  </button>
                </>
              ) : (
                <button
                  data-skill-edit=""
                  onClick={() => {
                    setDraft(file.content);
                    setEditing(true);
                    setView("source");
                    setJustSaved(false);
                  }}
                  style={{
                    ...dialogCancelBtn,
                    color: "var(--text-primary)",
                    border: "1px solid var(--border-medium)",
                  }}
                >
                  {t("common.edit")}
                </button>
              )}
            </div>
          )}
        </div>

        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "auto minmax(0, 1fr)",
            columnGap: 14,
            rowGap: 6,
            margin: 0,
            padding: "10px 12px",
            borderRadius: 8,
            background: "var(--bg-subtle)",
            border: "1px solid var(--border-subtle)",
            fontSize: 12,
          }}
        >
          <dt style={{ color: "var(--text-muted)" }}>
            {t("skills.field.file")}
          </dt>
          <dd
            style={{
              margin: 0,
              display: "flex",
              alignItems: "center",
              gap: 8,
              minWidth: 0,
            }}
          >
            <code
              data-skill-path=""
              style={{
                fontFamily: "'JetBrains Mono',monospace",
                fontSize: 11.5,
                color: "var(--text-primary)",
                overflowWrap: "anywhere",
              }}
            >
              {breakAfterSlashes(tildePath(entry.path, home))}
            </code>
            <CopyButton getText={() => entry.path} size={22} />
          </dd>
          {entry.project && (
            <>
              <dt style={{ color: "var(--text-muted)" }}>
                {t("skills.field.project")}
              </dt>
              <dd
                style={{
                  margin: 0,
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: 11.5,
                  overflowWrap: "anywhere",
                }}
              >
                {breakAfterSlashes(tildePath(entry.project, home))}
              </dd>
            </>
          )}
          {entry.aliasFor && (
            <>
              <dt style={{ color: "var(--text-muted)" }}>
                {t("skills.field.alias")}
              </dt>
              <dd
                style={{
                  margin: 0,
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: 11.5,
                }}
              >
                /{entry.aliasFor}
              </dd>
            </>
          )}
          <dt style={{ color: "var(--text-muted)" }}>
            {t("skills.field.uses")}
          </dt>
          <dd style={{ margin: 0, color: "var(--text-secondary)" }}>
            {tn("skills.uses", entry.uses)}
          </dd>
        </dl>

        {entry.shadowedBy && (
          <div
            role="note"
            style={{
              padding: "9px 12px",
              borderRadius: 8,
              border: "1px solid var(--orange-border)",
              background: "var(--orange-bg)",
              color: "var(--orange-text)",
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            {t("skills.shadowed", { engine: engineLabel })}{" "}
            <code
              style={{
                fontFamily: "'JetBrains Mono',monospace",
                fontSize: 11.5,
                overflowWrap: "anywhere",
              }}
            >
              {breakAfterSlashes(tildePath(entry.shadowedBy, home))}
            </code>
          </div>
        )}
        {readOnlyNote && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
              color: "var(--text-muted)",
            }}
          >
            <LockIcon />
            {readOnlyNote}
          </div>
        )}

        {saveProblem && (
          <div
            role="alert"
            data-skill-save-problem={
              typeof saveProblem === "string" ? saveProblem : "error"
            }
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
              padding: "9px 12px",
              borderRadius: 8,
              border: "1px solid var(--red)",
              background: "var(--red-bg)",
              color: "var(--red-text)",
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            <span style={{ flex: 1, minWidth: 200 }}>
              {saveProblem === "stale"
                ? t("skills.saveStale")
                : saveProblem === "deleted"
                  ? t("skills.saveDeleted")
                  : saveProblem.message}
            </span>
            {saveProblem === "stale" && (
              <button
                onClick={() => void openEntry(entry)}
                style={{
                  ...dialogCancelBtn,
                  color: "var(--red-text)",
                  border: "1px solid var(--red)",
                }}
              >
                {t("skills.reload")}
              </button>
            )}
          </div>
        )}
        {justSaved && !editing && (
          <div
            role="status"
            style={{ fontSize: 12, color: "var(--green-text)" }}
          >
            {t("common.saved")}
          </div>
        )}
        {prompt.open && (
          <UnsavedChangesPrompt
            onDiscard={prompt.discard}
            onCancel={prompt.cancel}
          />
        )}

        {fileError && (
          <div style={{ color: "var(--red-text)", fontSize: 12 }}>
            {errorText(fileError)}
          </div>
        )}
        {file && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {!editing && (
              <div
                role="tablist"
                style={{
                  display: "inline-flex",
                  alignSelf: "flex-start",
                  padding: 3,
                  borderRadius: 9,
                  background: "var(--bg-subtle)",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                {(["source", "preview"] as const).map((v) => (
                  <button
                    key={v}
                    role="tab"
                    aria-selected={view === v}
                    onClick={() => setView(v)}
                    style={pillBtn(view === v)}
                  >
                    {v === "source"
                      ? t("skills.view.source")
                      : t("skills.view.preview")}
                  </button>
                ))}
              </div>
            )}
            {view === "preview" && !editing ? (
              <div
                data-skill-preview=""
                style={{
                  padding: isMobile ? "4px 2px" : "6px 4px",
                  fontSize: 13.5,
                  lineHeight: 1.6,
                }}
              >
                <Markdown content={skillBody(file.content)} />
              </div>
            ) : (
              <SkillSourceEditor
                // A fresh editor per file: its undo history belongs to one file.
                key={file.path}
                value={editing ? draft : file.content}
                editable={editing}
                onChange={setDraft}
                onSave={() => void save()}
                mobile={isMobile}
              />
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      data-skills-page=""
      style={{
        height: isMobile
          ? "calc(100dvh - var(--banner-h, 0px))"
          : "calc(100vh - var(--banner-h, 0px))",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-base)",
        color: "var(--text-primary)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: isMobile ? "0 12px" : "0 20px",
          paddingTop: isMobile ? "env(safe-area-inset-top, 0px)" : undefined,
          minHeight: 44,
          background: "var(--bg-hud)",
          backdropFilter: "blur(16px)",
          borderBottom: "1px solid var(--border-subtle)",
          flexShrink: 0,
          zIndex: 500,
        }}
      >
        <button
          onClick={() => guarded(onClose)}
          aria-label={t("common.back")}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            fontSize: 18,
            cursor: "pointer",
            padding: "2px 8px",
          }}
        >
          ←
        </button>
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          {t("common.skills")}
        </div>
        <div style={{ marginLeft: "auto", display: "flex" }}>
          <button
            data-skill-new=""
            onClick={() => guarded(() => setCreating(true))}
            disabled={!catalog}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 11px",
              borderRadius: 6,
              border: "1px solid var(--green-border)",
              background: "var(--green-bg)",
              color: "var(--green-text)",
              fontSize: 11.5,
              fontWeight: 600,
              cursor: catalog ? "pointer" : "not-allowed",
            }}
          >
            <PlusIcon />
            {t("skills.new")}
          </button>
        </div>
      </div>

      {loadError && (
        <div
          style={{
            padding: "8px 16px",
            background: "var(--bg-subtle)",
            borderBottom: "1px solid var(--border-subtle)",
            color: "var(--red-text)",
            fontSize: 12,
            flexShrink: 0,
          }}
        >
          {errorText(loadError)}
        </div>
      )}

      {showList && (
        <div
          data-skills-toolbar=""
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            padding: isMobile ? "8px 12px" : "10px 20px",
            borderBottom: "1px solid var(--border-subtle)",
            flexShrink: 0,
          }}
        >
          <div
            role="tablist"
            aria-label={t("skills.engine")}
            style={{
              display: "inline-flex",
              padding: 3,
              borderRadius: 9,
              background: "var(--bg-subtle)",
              border: "1px solid var(--border-subtle)",
              maxWidth: "100%",
              overflowX: "auto",
            }}
          >
            {ENGINE_OPTIONS.map((o) => {
              const n =
                catalog?.engines.find((e) => e.engine === o.agentType)?.skills
                  .length ?? 0;
              const active = engine === o.agentType;
              return (
                <button
                  key={o.agentType}
                  role="tab"
                  aria-selected={active}
                  data-skill-engine={o.agentType}
                  onClick={() => setEngine(o.agentType)}
                  style={pillBtn(active)}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: ENGINE_ACCENT[o.agentType],
                      opacity: active ? 1 : 0.55,
                    }}
                  />
                  {o.label}
                  {catalog && (
                    <span
                      style={{
                        fontSize: 10.5,
                        color: "var(--text-hint)",
                        fontWeight: 600,
                      }}
                    >
                      {n}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <label
            style={{
              flex: isMobile ? "1 1 100%" : "0 1 280px",
              marginLeft: isMobile ? 0 : "auto",
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--bg-input)",
              color: "var(--text-muted)",
            }}
          >
            <SearchIcon />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder={t("skills.search")}
              aria-label={t("skills.search")}
              style={{
                flex: 1,
                minWidth: 0,
                border: "none",
                outline: "none",
                background: "transparent",
                color: "var(--text-primary)",
                fontSize: isMobile ? 16 : 12.5,
              }}
            />
          </label>
        </div>
      )}

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {showList && list}
        {showDetail && (
          <div
            style={{
              flex: 1,
              minWidth: 0,
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
            }}
          >
            {renderDetail()}
          </div>
        )}
      </div>

      {creating && catalog && (
        <NewSkillDialog
          dir={tildePath(catalog.newSkillDir, home)}
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            void load().then(() => {
              const fresh: SkillCatalogEntry = {
                name: created.name,
                source: "user",
                kind: "skill",
                path: created.file.path,
                dir: catalog.newSkillDir,
                editable: true,
                uses: 0,
              };
              setQuery("");
              void openEntry(fresh);
            });
          }}
        />
      )}
    </div>
  );
}

function NewSkillDialog({
  dir,
  onClose,
  onCreated,
}: {
  dir: string;
  onClose: () => void;
  onCreated: (created: { name: string; file: SkillFileRes }) => void;
}) {
  const { t } = useI18n();
  const { isMobile } = useAppState();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PlainMessageKey | null>(null);
  const nameOk = validSkillName(name);
  const descriptionOk =
    description.trim().length > 0 && description.length <= 1024;
  const canCreate = nameOk && descriptionOk && !busy;

  async function create() {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const body: SkillCreateReq = {
        name,
        description: description.trim(),
        instructions,
      };
      const file = await apiFetch<SkillFileRes>("POST", "/api/skills", body);
      onCreated({ name, file });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setError(
        code === "skill_exists"
          ? "skills.create.exists"
          : code === "invalid_name"
            ? "skills.create.invalidName"
            : code === "invalid_description"
              ? "skills.create.invalidDescription"
              : "skills.create.failed",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Portal>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "var(--bg-overlay)",
          display: "flex",
          alignItems: isMobile ? "flex-end" : "center",
          justifyContent: "center",
          padding: isMobile ? 0 : 16,
          zIndex: 3000,
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("skills.create.title")}
          data-skill-create=""
          onClick={(e) => e.stopPropagation()}
          style={{
            width: "100%",
            maxWidth: 560,
            maxHeight: isMobile ? "92dvh" : "86vh",
            overflowY: "auto",
            background: "var(--bg-surface-solid)",
            border: "1px solid var(--border)",
            borderRadius: isMobile ? "14px 14px 0 0" : 14,
            boxShadow: "0 18px 48px var(--shadow-heavy)",
            padding: isMobile ? "18px 16px 24px" : "22px 24px",
            boxSizing: "border-box",
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 700 }}>
            {t("skills.create.title")}
          </div>
          <div>
            <label style={dialogLabel} htmlFor="new-skill-name">
              {t("common.name")}
            </label>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                ...dialogInput,
                padding: 0,
              }}
            >
              <span
                style={{
                  padding: "0 0 0 12px",
                  color: "var(--text-muted)",
                  fontFamily: "'JetBrains Mono',monospace",
                }}
              >
                /
              </span>
              <input
                id="new-skill-name"
                autoFocus
                value={name}
                onChange={(e) =>
                  setName(e.currentTarget.value.toLowerCase().trim())
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") void create();
                }}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                style={{
                  ...dialogInput,
                  border: "none",
                  background: "transparent",
                  paddingLeft: 2,
                  fontSize: isMobile ? 16 : 12,
                }}
              />
            </div>
            <div
              style={{
                fontSize: 11,
                marginTop: 5,
                color:
                  name && !nameOk ? "var(--red-text)" : "var(--text-muted)",
              }}
            >
              {name && !nameOk
                ? t("skills.create.invalidName")
                : t("skills.create.nameHint")}
            </div>
          </div>
          <div>
            <label style={dialogLabel} htmlFor="new-skill-description">
              {t("skills.create.description")}
            </label>
            <input
              id="new-skill-description"
              value={description}
              maxLength={1024}
              onChange={(e) =>
                setDescription(e.currentTarget.value.replace(/[\r\n]/g, " "))
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") void create();
              }}
              style={{
                ...dialogInput,
                fontFamily: "inherit",
                fontSize: isMobile ? 16 : 13,
              }}
            />
            <div
              style={{ fontSize: 11, marginTop: 5, color: "var(--text-muted)" }}
            >
              {t("skills.create.descriptionHint")}
            </div>
          </div>
          <div>
            <label style={dialogLabel} htmlFor="new-skill-instructions">
              {t("skills.create.instructions")}
            </label>
            <textarea
              id="new-skill-instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.currentTarget.value)}
              placeholder={t("skills.create.instructionsPlaceholder")}
              rows={isMobile ? 7 : 9}
              style={{
                ...dialogInput,
                resize: "vertical",
                lineHeight: 1.5,
                fontSize: isMobile ? 16 : 12,
              }}
            />
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              fontFamily: "'JetBrains Mono',monospace",
              overflowWrap: "anywhere",
            }}
          >
            {breakAfterSlashes(
              t("skills.create.where", {
                path: `${dir}/${name || "…"}/SKILL.md`,
              }),
            )}
          </div>
          {error && (
            <div
              role="alert"
              style={{ color: "var(--red-text)", fontSize: 12 }}
            >
              {t(error)}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button onClick={onClose} style={dialogCancelBtn}>
              {t("common.cancel")}
            </button>
            <button
              data-skill-create-submit=""
              onClick={() => void create()}
              disabled={!canCreate}
              style={{
                ...dialogSaveBtn,
                ...(!canCreate ? disabledLook : {}),
              }}
            >
              {t("skills.create.submit")}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

// One-off layout editor for the lobby (Nil, 2026-09-05): drag props around,
// add and remove them, and export the placement list for layouts.ts. Not
// user-facing; mounted by preview-entry.tsx with ?edit=1 and served by
// scripts/lobby-editor-server.ts. Not polished on purpose.
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { THEMES } from "../../themes.ts";
import { Character } from "../Character.tsx";
import { SCENE_W, SCENE_H, VB_X, VB_Y } from "../grid.ts";
import { floorXY, COL, ROW } from "./geometry.ts";
import { LOBBY_LAYOUTS, LOBBY_LAYOUT_IDS, type LobbyLayoutId, type Placement } from "./layouts.ts";
import { LobbyScene, type LobbyRoomRef } from "./LobbyScene.tsx";
import { LOBBY_PROPS, variantFacings, type PropStar } from "./props.tsx";

interface Item extends Placement {
  key: number;
}

const RECEP_OUTFIT = {
  color: "#c96a4b",
  hair: "#3b2a1e",
  hairStyle: "short" as const,
  skin: "#f1c9a5",
  beard: "none" as const,
  accessory: null,
  hat: "none" as const,
};

function round(n: number) {
  return Math.round(n * 100) / 100;
}

function anchorPx(p: Placement): { left: number; top: number } {
  const { x, y } = floorXY(p.b, p.a);
  return { left: x - VB_X, top: y - VB_Y - (p.wall ? (p.h ?? 60) : 0) };
}

function exportTs(items: Item[], recep: { a: number; b: number }): string {
  const lines = items.map((p) => {
    const parts = [`family: "${p.family}"`, `variant: "${p.variant}"`, `a: ${round(p.a)}`, `b: ${round(p.b)}`];
    if (p.wall) parts.push(`wall: "${p.wall}"`, `h: ${round(p.h ?? 60)}`);
    if (p.facing) parts.push(`facing: "${p.facing}"`);
    if (p.flip) parts.push("flip: true");
    if (p.z) parts.push(`z: ${round(p.z)}`);
    if (p.scale && p.scale !== 1) parts.push(`scale: ${round(p.scale)}`);
    return `      { ${parts.join(", ")} },`;
  });
  return `    receptionist: { a: ${round(recep.a)}, b: ${round(recep.b)} },\n    placements: [\n${lines.join("\n")}\n    ],`;
}

const panelStyle: CSSProperties = {
  width: 360,
  fontFamily: "DM Sans, sans-serif",
  fontSize: 12,
  color: "var(--text-primary)",
  padding: 12,
  overflowY: "auto",
  maxHeight: "100vh",
};
const inputStyle: CSSProperties = { width: 52, fontSize: 11 };

export function LobbyEditor({
  initialLayout,
  themeId,
  rooms,
  officeName,
  star,
}: {
  initialLayout: LobbyLayoutId;
  themeId: string;
  rooms: LobbyRoomRef[];
  officeName: string;
  star: PropStar | null;
}) {
  const [layout, setLayout] = useState<LobbyLayoutId>(initialLayout);
  // The room is warm wood in every theme; the theme still colours everything
  // around it, so the editor switches the whole registry, not just dark/light.
  const [theme, setTheme] = useState(() => THEMES.find((t) => t.id === themeId) ?? THEMES[0]);
  const mode = theme.mode;
  const [items, setItems] = useState<Item[]>(() =>
    LOBBY_LAYOUTS[initialLayout].placements.map((p, i) => ({ ...p, key: i })),
  );
  const [recep, setRecep] = useState(LOBBY_LAYOUTS[initialLayout].receptionist);
  const [selected, setSelected] = useState<number | null>(null);
  const [addFamily, setAddFamily] = useState(LOBBY_PROPS[0].id);
  const [addVariant, setAddVariant] = useState(LOBBY_PROPS[0].variants[0].id);
  const [status, setStatus] = useState("");
  const [saved, setSaved] = useState<string[]>([]);
  const [pick, setPick] = useState("");
  const [draft, setDraft] = useState<string | null>(null);
  const [saveName, setSaveName] = useState<string>(initialLayout);
  const nextKey = useRef(1000);
  const rowRefs = useRef(new Map<number, HTMLTableRowElement>());
  const sceneRef = useRef<HTMLDivElement>(null);

  // Grabbing a dot selects the prop, so bring its row into view: the list is
  // longer than the panel once a layout has a dozen props.
  useEffect(() => {
    if (selected === null) return;
    rowRefs.current.get(selected)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme.id);
    document.documentElement.setAttribute("data-theme-mode", theme.mode);
  }, [theme]);

  // What "save on the box" wrote, so a saved layout can be opened again.
  const refreshSaved = useCallback(async () => {
    try {
      const res = await fetch("/saved");
      setSaved((await res.json()) as string[]);
    } catch {
      setSaved([]);
    }
  }, []);
  useEffect(() => {
    void refreshSaved();
  }, [refreshSaved]);

  async function loadSaved(name: string) {
    if (!name) return;
    setStatus(`loading ${name}...`);
    try {
      const res = await fetch(`/saved/${encodeURIComponent(name)}`);
      // Read the body as text first: a stale server process answers this route
      // with plain "not found", and JSON.parse on that reports a syntax error
      // that says nothing about the real cause.
      const body = await res.text();
      let j: {
        layout?: LobbyLayoutId;
        placements?: Placement[];
        receptionist?: { a: number; b: number };
      };
      try {
        j = JSON.parse(body) as typeof j;
      } catch {
        setStatus(
          res.ok
            ? `${name} is not JSON: ${body.slice(0, 60)}`
            : `server said ${res.status}: ${body.slice(0, 60)} (restart the lobby-editor app if it was just updated)`,
        );
        return;
      }
      if (!res.ok || !j.placements) {
        setStatus(`no saved layout called ${name}`);
        return;
      }
      if (j.layout && j.layout in LOBBY_LAYOUTS) setLayout(j.layout);
      setItems(j.placements.map((p, i) => ({ ...p, key: i })));
      if (j.receptionist) setRecep(j.receptionist);
      setSelected(null);
      setSaveName(name);
      setStatus(`loaded ${name}`);
    } catch (e) {
      setStatus(`load failed: ${String(e)}`);
    }
  }

  function loadLayout(id: LobbyLayoutId) {
    setLayout(id);
    setItems(LOBBY_LAYOUTS[id].placements.map((p, i) => ({ ...p, key: i })));
    setRecep(LOBBY_LAYOUTS[id].receptionist);
    setSelected(null);
    setSaveName(id);
  }

  function update(key: number, patch: Partial<Placement>) {
    setItems((list) => list.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  }

  // Drag: floor props move on the floor plane; wall props slide along their
  // wall and up or down. Pixel deltas are in scene units (the box is 1:1).
  function startDrag(e: React.PointerEvent, target: { kind: "item"; key: number } | { kind: "recep" }) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX,
      startY = e.clientY;
    const item = target.kind === "item" ? items.find((it) => it.key === target.key) : null;
    const start = target.kind === "item" ? { a: item!.a, b: item!.b, h: item!.h ?? 60 } : { a: recep.a, b: recep.b, h: 0 };
    if (target.kind === "item") setSelected(target.key);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (target.kind === "recep") {
        setRecep({ a: start.a + (dx / COL.dx + dy / COL.dy) / 2, b: start.b + (dy / ROW.dy - dx / COL.dx) / 2 });
        return;
      }
      const wall = item!.wall;
      if (wall === "right") update(target.key, { a: start.a + dx / COL.dx, h: start.h - (dy - dx * 0.5) });
      else if (wall === "left") update(target.key, { b: start.b - dx / COL.dx, h: start.h - (dy + dx * 0.5) });
      else update(target.key, { a: start.a + (dx / COL.dx + dy / COL.dy) / 2, b: start.b + (dy / ROW.dy - dx / COL.dx) / 2 });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (selected === null) return;
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "TEXTAREA") return;
      const step = e.shiftKey ? 0.5 : 0.1;
      const it = items.find((x) => x.key === selected);
      if (!it) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        setItems((l) => l.filter((x) => x.key !== selected));
        setSelected(null);
      } else if (e.key === "ArrowLeft") update(selected, it.wall === "right" ? { a: it.a - step } : it.wall === "left" ? { b: it.b + step } : { a: it.a - step });
      else if (e.key === "ArrowRight") update(selected, it.wall === "right" ? { a: it.a + step } : it.wall === "left" ? { b: it.b - step } : { a: it.a + step });
      else if (e.key === "ArrowUp") update(selected, it.wall ? { h: (it.h ?? 60) + step * 10 } : { b: it.b - step });
      else if (e.key === "ArrowDown") update(selected, it.wall ? { h: (it.h ?? 60) - step * 10 } : { b: it.b + step });
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, items]);

  function add() {
    const fam = LOBBY_PROPS.find((f) => f.id === addFamily)!;
    const v = fam.variants.find((x) => x.id === addVariant) ?? fam.variants[0];
    const key = nextKey.current++;
    const p: Item = v.wall
      ? { key, family: fam.id, variant: v.id, a: 5, b: 0, wall: "right", h: 80 }
      : { key, family: fam.id, variant: v.id, a: 5, b: 5 };
    setItems((l) => [...l, p]);
    setSelected(key);
  }

  const exportedTs = exportTs(items, recep);
  // The text box round-trips: it shows the same JSON that "save on the box"
  // writes, and anything of that shape pasted back into it loads (Marc,
  // 2026-09-06). `draft` holds what the user typed until they apply or reset.
  const exportedJson = JSON.stringify(
    { receptionist: recep, placements: items.map(({ key: _k, ...p }) => p) },
    null,
    2,
  );
  const boxText = draft ?? exportedJson;

  function applyText() {
    if (draft === null) return;
    try {
      const j = JSON.parse(draft) as {
        layout?: LobbyLayoutId;
        placements?: Placement[];
        receptionist?: { a: number; b: number };
      };
      const list = Array.isArray(j) ? (j as Placement[]) : j.placements;
      if (!Array.isArray(list)) {
        setStatus("that JSON has no placements array");
        return;
      }
      if (j.layout && j.layout in LOBBY_LAYOUTS) setLayout(j.layout);
      setItems(list.map((p, i) => ({ ...p, key: i })));
      if (j.receptionist) setRecep(j.receptionist);
      setSelected(null);
      setDraft(null);
      setStatus(`loaded ${list.length} props from the text box`);
    } catch (e) {
      setStatus(`not valid JSON: ${String(e)}`);
    }
  }

  async function save() {
    setStatus("saving...");
    try {
      const res = await fetch("/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: saveName, layout, mode, receptionist: recep, placements: items.map(({ key: _k, ...p }) => p), ts: exportedTs }),
      });
      const j = (await res.json()) as { path?: string };
      setStatus(res.ok ? `saved as ${saveName}` : `save failed: ${JSON.stringify(j)}`);
      if (res.ok) void refreshSaved();
    } catch (e) {
      setStatus(`save failed: ${String(e)}`);
    }
  }

  const recepPx = anchorPx({ family: "", variant: "", a: recep.a, b: recep.b });

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
      <div
        ref={sceneRef}
        // The walls rise about 100 units above the scene box (the viewBox starts at
        // y -100 and the apex sits at -200), and the SVGs draw outside it, so the
        // top corner needs room above the box or the window cuts it off.
        style={{ width: SCENE_W, height: SCENE_H, position: "relative", margin: "130px 0 40px 24px", flex: "none", userSelect: "none" }}
        onPointerDown={() => setSelected(null)}
      >
        <LobbyScene
          rooms={rooms}
          officeName={officeName}
          mode={mode}
          layout={layout}
          star={star}
          placements={items}
          receptionistAt={recep}
          rightDoor={{ label: rooms[0]?.name ?? "Room 1", onClick: () => {} }}
          receptionist={
            <g transform="translate(-26 -68)">
              <Character state="idle" outfit={RECEP_OUTFIT} />
            </g>
          }
        />
        {/* Drag handles */}
        {items.map((it) => {
          const px = anchorPx(it);
          const sel = it.key === selected;
          return (
            <div
              key={it.key}
              onPointerDown={(e) => startDrag(e, { kind: "item", key: it.key })}
              title={`${it.family}:${it.variant}`}
              style={{
                position: "absolute",
                left: px.left - 7,
                top: px.top - 7,
                width: 14,
                height: 14,
                borderRadius: "50%",
                background: sel ? "#ff4d4d" : it.wall ? "#4da3ff" : "#ffd23f",
                border: "2px solid #222",
                cursor: "grab",
                zIndex: 10,
              }}
            >
              <div style={{ position: "absolute", left: 16, top: -2, fontSize: 10, whiteSpace: "nowrap", color: "#fff", background: "rgba(0,0,0,.6)", padding: "0 4px", borderRadius: 3, pointerEvents: "none", opacity: sel ? 1 : 0.7 }}>
                {it.family}:{it.variant}
              </div>
            </div>
          );
        })}
        <div
          onPointerDown={(e) => startDrag(e, { kind: "recep" })}
          title="receptionist"
          style={{ position: "absolute", left: recepPx.left - 7, top: recepPx.top - 7, width: 14, height: 14, borderRadius: 3, background: "#7bc47f", border: "2px solid #222", cursor: "grab", zIndex: 10 }}
        >
          <div style={{ position: "absolute", left: 16, top: -2, fontSize: 10, whiteSpace: "nowrap", color: "#fff", background: "rgba(0,0,0,.6)", padding: "0 4px", borderRadius: 3, pointerEvents: "none" }}>receptionist</div>
        </div>
      </div>

      <div style={panelStyle}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
          <select value={layout} onChange={(e) => loadLayout(e.target.value as LobbyLayoutId)}>
            {LOBBY_LAYOUT_IDS.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <button onClick={() => loadLayout(layout)}>reset</button>
          <select
            value={pick}
            onChange={(e) => {
              setPick(e.target.value);
              void loadSaved(e.target.value);
            }}
            title="open a layout you saved on the box"
          >
            <option value="">saved…</option>
            {saved.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <select value={theme.id} onChange={(e) => setTheme(THEMES.find((t) => t.id === e.target.value) ?? THEMES[0])}>
            {THEMES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.displayName}
              </option>
            ))}
          </select>
        </div>
        <div style={{ color: "var(--text-dim)", marginBottom: 8 }}>
          Drag the dots. Click one, then arrows nudge (shift: bigger), Delete removes. Wall props slide along their wall and up/down. Yellow: floor, blue: wall, green: receptionist. Row boxes are wall, height, scale, z (draw order: raise it to pass in front of a neighbour) and facing. NE and NW turn a piece around, so you see its back.
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 8 }}>
          <select
            value={addFamily}
            onChange={(e) => {
              setAddFamily(e.target.value);
              setAddVariant(LOBBY_PROPS.find((f) => f.id === e.target.value)!.variants[0].id);
            }}
          >
            {LOBBY_PROPS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
          <select value={addVariant} onChange={(e) => setAddVariant(e.target.value)}>
            {LOBBY_PROPS.find((f) => f.id === addFamily)!.variants.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
          <button onClick={add}>add</button>
        </div>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <tbody>
            {items.map((it) => {
              const fam = LOBBY_PROPS.find((f) => f.id === it.family)!;
              const sel = it.key === selected;
              return (
                <tr
                  key={it.key}
                  ref={(el) => {
                    if (el) rowRefs.current.set(it.key, el);
                    else rowRefs.current.delete(it.key);
                  }}
                  onClick={() => setSelected(it.key)}
                  style={{
                    background: sel ? "var(--accent)" : undefined,
                    color: sel ? "#fff" : undefined,
                    outline: sel ? "2px solid #ff4d4d" : undefined,
                    cursor: "pointer",
                  }}
                >
                  <td style={{ padding: 2 }}>
                    <select
                      value={it.family}
                      onChange={(e) => {
                        const f = LOBBY_PROPS.find((x) => x.id === e.target.value)!;
                        update(it.key, { family: f.id, variant: f.variants[0].id });
                      }}
                    >
                      {LOBBY_PROPS.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.id}
                        </option>
                      ))}
                    </select>
                    <select value={it.variant} onChange={(e) => update(it.key, { variant: e.target.value })}>
                      {fam.variants.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.id}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td style={{ padding: 2, whiteSpace: "nowrap" }}>
                    <select value={it.wall ?? ""} onChange={(e) => update(it.key, { wall: (e.target.value || undefined) as Placement["wall"], h: e.target.value ? (it.h ?? 80) : undefined, a: e.target.value === "left" ? 0 : it.a, b: e.target.value === "right" ? 0 : it.b })}>
                      <option value="">floor</option>
                      <option value="left">left</option>
                      <option value="right">right</option>
                    </select>
                    {it.wall && <input style={inputStyle} type="number" step="5" value={round(it.h ?? 60)} onChange={(e) => update(it.key, { h: Number(e.target.value) })} title="height" />}
                    <input style={inputStyle} type="number" step="0.05" value={it.scale ?? 1} onChange={(e) => update(it.key, { scale: Number(e.target.value) })} title="scale" />
                    {!it.wall && (
                      <input style={inputStyle} type="number" step="0.5" value={it.z ?? 0} onChange={(e) => update(it.key, { z: Number(e.target.value) })} title="draw order: higher is drawn later, in front" />
                    )}
                    {it.wall ? (
                      <label title="flip">
                        <input type="checkbox" checked={!!it.flip} onChange={(e) => update(it.key, { flip: e.target.checked })} />f
                      </label>
                    ) : (
                      (() => {
                        // Only offer the facings this prop actually has: every
                        // prop showed four, and the ones with no drawn back
                        // simply ignored two of them (Marc, 2026-09-06).
                        const n = variantFacings(fam.variants.find((v) => v.id === it.variant) ?? fam.variants[0]);
                        if (n === 1) return null;
                        const options = n === 4 ? ["SE", "SW", "NE", "NW"] : ["SE", "SW"];
                        return (
                          <select
                            value={it.facing ?? (it.flip ? "SW" : "SE")}
                            onChange={(e) => update(it.key, { facing: e.target.value as Placement["facing"], flip: undefined })}
                            title={n === 4 ? "which way it faces; NE and NW show it from behind" : "which way it faces"}
                          >
                            {options.map((o) => (
                              <option key={o} value={o}>
                                {o}
                              </option>
                            ))}
                          </select>
                        );
                      })()
                    )}
                    <button onClick={() => setItems((l) => l.filter((x) => x.key !== it.key))}>x</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div style={{ margin: "8px 0 4px", display: "flex", gap: 4, alignItems: "center" }}>
          <input value={saveName} onChange={(e) => setSaveName(e.target.value)} style={{ width: 120 }} title="save name" />
          <button onClick={() => void save()}>save on the box</button>
          <span style={{ color: "var(--text-dim)" }}>{status}</span>
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center", margin: "4px 0" }}>
          <button onClick={applyText} disabled={draft === null}>
            apply pasted JSON
          </button>
          <button onClick={() => setDraft(null)} disabled={draft === null}>
            revert box
          </button>
          <button onClick={() => setDraft(exportedTs)} title="the same layout as a layouts.ts block, to copy">
            show as TS
          </button>
        </div>
        <textarea
          value={boxText}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          style={{ width: "100%", height: 260, fontFamily: "JetBrains Mono, monospace", fontSize: 10 }}
        />
      </div>
    </div>
  );
}

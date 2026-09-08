# Lobby scene loop - standing orders + slice handoffs

Re-read this file at the start of every iteration. Conversations compact; this file does not.

Task: 684b072f "Lobby scene" (board, room Isomux). Owner: Nil. Runner: Nil's Direct Helper.
Worktree: ~/nil/isomux-worktrees/lobby (branch `lobby`, from main 101414e, 2026-09-05).
Nil sleeps from ~10:00 box time (01:00 PT) and reads the report in the morning PT.

## North star

A lobby scene, agent-free and cozy, drawn at the office room's level of polish, presented to Nil in the morning as galleries of alternatives (props and room layouts, light and dark) so he can pick his favourites. Scope is UI only. Everything else (server projection, tab wiring, ghosts) is wasted work if the drawing does not land, so the drawing comes first.

Nil's rulings (2026-09-05):
- Ghosts in normal rooms keep floating past the SE wall: it shows which room a boss is looking at. Only bosses on the Lobby tab would appear in the lobby. Out of scope for this loop.
- Multiple alternatives for assets and room layouts, he chooses in the morning.
- Worktrees only, never main.

## Process per slice

plan (in this file's PICKUP block) -> implement -> gates -> self-review checklist -> ONE focused commit -> tick the checkbox in that commit -> author the next PICKUP.

Self-review checklist (no reviewer in this loop; a reviewer pass before merge is parked for Nil):
1. Every gate log opens with the committed hash and ends with exit=0.
2. Screenshots exist for both themes and were LOOKED AT (Read the PNG). Nothing pasted-on: every floor prop has a contact shadow, nothing overlaps a wall edge, text is legible at 1x.
3. Pixel-diff check when a prop looks wrong (internal-docs/ui-verification.md, "Isolating what paints an artifact"): pause SMIL, toggle the group, diff.
4. SVG ids are prefixed `lobby-` so they never collide with office ids (window-clip, pet-volume, ...).
5. No import of ui/store.tsx from lobby scene files: the scene takes props, so the preview harness can render it without the app.
6. No file outside ui/office/lobby/, scripts/lobby-preview.sh, plans/ was touched, unless the PICKUP names it.

## Gates per slice (always-run, all offline, nothing costs money)

Run in the worktree AFTER the commit, on the committed hash:

    H=$(git rev-parse HEAD)
    (echo $H; bun run build:ui; echo exit=$?) > /tmp/lobby-build.log 2>&1
    (echo $H; systemd-run --user --scope -q -p MemoryMax=2G bun test ui/office; echo exit=$?) > /tmp/lobby-test.log 2>&1
    (echo $H; bunx eslint <touched files>; echo exit=$?) > /tmp/lobby-eslint.log 2>&1
    (echo $H; bash scripts/lobby-preview.sh slice-N; echo exit=$?) > /tmp/lobby-shots.log 2>&1   # writes PNGs to /tmp/lobby-preview/out/slice-N/

Read the exit= line of each log; never a pipeline status. A gate failure is fixed in the slice (amend before the hash is used for a log) or queued; gates are never weakened.
Once, before the final report: `(echo $H; systemd-run --user --scope -q -p MemoryMax=2G bunx tsc --noEmit; echo exit=$?) > /tmp/lobby-tsc.log 2>&1` (about 54 s).
Baseline (2026-09-05, 101414e): tsc exit=0, ui/office 37 pass, eslint clean, Chrome 151.0.7922.137, playwright-core 1.62.1 at ~/nil/wallgame/node_modules (not needed: plain `google-chrome --headless --screenshot` works).
Safety hook: every write target in a shell command must be an ABSOLUTE path (relative `mkdir -p plans` was blocked).

## Standing rails (prohibitions)

- Never edit files in ~/nil/isomux (main) or in the cute-visuals / unified-settings worktrees.
- Never restart the isomux server. Never push. Never merge. Never run prettier.
- Never store a lobby in officeState or in any user's allowedRooms (locked from the prior review; out of scope anyway).
- Never make the scene depend on ui/store.tsx.
- Never start slice N+1 with slice N uncommitted. One commit per slice.
- Never message Isomux PM or the reviewers. No agent traffic in this loop.
- Keep chat quiet until the final report; interim messages only as "(orchestration chatter: ...)".
- Never pkill by name; keep the static server's PID and kill that.
- Never delete or overwrite /tmp/lobby-preview/out/ from an earlier slice: each slice writes into its own subfolder `out/slice-N/`.

## Slice plan

- [x] 1 Harness: `ui/office/lobby/LobbyScene.tsx` skeleton (floor + walls, two palettes: `warm` fixed wood/cream and `theme` from CSS vars), `ui/office/lobby/preview-entry.tsx` standalone entry that reads URL params, `scripts/lobby-preview.sh` build+serve+screenshot, `LobbyScene.test.tsx` static-markup test. Screens: warm/theme x light/dark.
- [x] 2 Prop library with variants, on a contact sheet (`?sheet=props`): sofa x3, armchair x2, coffee table x2, fireplace x2, bookshelf x2, fish tank x2, floor lamp x2, rug x3, plant x2 (one reuses ui/office/plants.tsx CornerPlant), wall piece x2 (WELCOME bunting with office name, framed poster), cat x2, directory board x2, reception counter with bell x1. Each variant drawn at its in-scene scale, with its contact shadow.
- [x] 3 Three room layouts (`?layout=fireside|lounge|nook`) composed from default variants, both palettes, both themes. Reuse the office window (day/night) and clock on the walls.
- [x] 4 Polish on all three layouts: animations (flame, fish, cat tail, steam), lamp light pools, wall glow, welcome banner text with office name, directory board listing mock rooms. Final gallery PNGs plus one composite per layout.
- [x] 5 (optional, redefined after slice 4) In-situ parity: no app wiring (a client-only tab would touch OfficeView, RoomTabBar and the store, which a reviewer must vet after the pick, and the harness already renders at the exact scene size). Instead: (a) two mock boss ghosts in the lobby preview for scale, (b) a screenshot of the real office room from the demo bundle, (c) a side-by-side composite office-vs-lobby per layout. Wiring the tab is parked for after the pick.

## Deferred / parked (do not pick up)

- Server-side synthetic lobby room, allowedRooms rejection, tab-cycle skip, mobile list view, ghosts in the lobby: all out of scope. Old design in branch `lobby-scene` commit ca34965 (reference only, do not rebase it).
- Human-only queue (parked-for-Nil): pick of layout, palette and prop variants; reviewer pass before merge; whether Ctrl+Tab skips the lobby; docs copy (features.md line); merge and restart.

## Resources

- Scene coordinate system: ui/office/grid.ts (SCENE_W 950, SCENE_H 700, viewBox -355 -100 950 700). Floor diamond: back (120,40), left (-355,277.5), right (595,277.5), front (120,515). Wall tops at y -200 over x 120.
- Office walls/window/clock/neon: ui/office/Floor.tsx `Walls` (window pane parallelogram TL(-295,30) TR(-155,-40) BL(-295,120) BR(-155,50); clock on right wall). Floor tiles/slab: `Floor`. Contact shadows: ui/office/GroundShadows.tsx (centred, faint, "grounded" falloff; clipped to the floor diamond).
- Pets: ui/office/RoomProps.tsx (Cat at ~32x18 units, tail SMIL). Plants: ui/office/plants.tsx (CornerPlant, Pot, Leaf, BlossomJar).
- Theme vars: ui/themes.ts (--wall-left/right, --floor-light/dark, --wall-decor...). Mode CSS: ui/styles.ts (`[data-theme-mode="light"] .window-day` etc). The harness must inject `CSS` from ui/styles.ts and set data-theme + data-theme-mode on <html>.
- Headless Chrome recipes: internal-docs/ui-verification.md. Screenshot: `google-chrome --headless --no-sandbox --disable-gpu --hide-scrollbars --window-size=1100,820 --screenshot=<png> --virtual-time-budget=6000 <url>`. Serve over HTTP (file:// blocks modules).
- Static-markup tests pattern: ui/office/Character.test.tsx (renderToStaticMarkup, bun:test).
- Show a PNG to Nil: POST localhost:4000/api/agents/agent-1788050459316-x79w/read-file {"path": "..."} (only in the final report).

## SLICE-1 PICKUP (authored 2026-09-05 10:10 box time)

Baseline: 101414e (main) + the commit that adds this file.
Goal: a repeatable screenshot pipeline for a lobby scene rendered in isolation, at the office's exact scene size, in both themes.
Mechanics:
- `ui/office/lobby/LobbyScene.tsx` exports `LobbyScene({ rooms, officeName, palette, layout, variants })`. Slice 1 draws floor + walls only, in the same diamond as the office, with the palette switch. `palette: "warm"` uses fixed warm colours; `palette: "theme"` uses the office CSS vars.
- `ui/office/lobby/preview-entry.tsx`: sets `data-theme` and `data-theme-mode` from `?mode=` (check ui/themes.ts for the default theme ids), injects `CSS` from ui/styles.ts into a <style>, mounts a 950x700 box, reads `?palette=`, `?layout=`, `?sheet=`.
- `scripts/lobby-preview.sh <out-subdir>`: `bun build ui/office/lobby/preview-entry.tsx --outdir /tmp/lobby-preview --production`, writes /tmp/lobby-preview/preview.html (`<div id="root">` + script), serves /tmp/lobby-preview with `python3 -m http.server 9877` (PID kept, killed at exit via trap), screenshots a list of URL suffixes into /tmp/lobby-preview/out/<subdir>/<name>.png. Port 9877 is reserved for this gate.
- Test: renders LobbyScene for both palettes with renderToStaticMarkup; asserts `<svg`, no "NaN", no "undefined" in the markup, all `id="` values start with `lobby-`.
Acceptance: four PNGs (warm-dark, warm-light, theme-dark, theme-light) that show a clean empty iso room. Gates green on the committed hash.
Locked: coordinates match the office (so a later in-situ swap needs no viewport change).

## SLICE-2 PICKUP (authored after slice 1 committed at 07ecb40)

What slice 1 taught: the harness works end to end (build 1 s, four shots in ~10 s). The safety hook blocks `chmod +x` and any relative write path; invoke the script with `bash`. `bun test ui/office` now runs 42 tests. The warm palette reads as a real wood room; the theme palette reads as an empty office, which is the point of offering both.

Goal: a prop library with variants, each drawn at its in-scene scale in the office's iso space, shown on a contact sheet (`?sheet=props&mode=..&palette=..`) so Nil can pick per prop.
Mechanics:
- `ui/office/lobby/props.tsx`: every prop is a function component drawn with its FLOOR CONTACT CENTRE at local (0,0), plus a `LOBBY_PROPS` registry: `{ id, label, variants: [{ id, label, Component, shadow: { rx, ry } }] }`. Wall pieces have their anchor at the wall contact point instead and declare `wall: "left" | "right"`.
- Iso convention: a box with footprint (w along COL, d along ROW) and height h draws three faces: top (parallelogram), left face (towards the viewer-left, along ROW), right face (along COL). Light comes from the left window like the office: top brightest, right face mid, left face darkest.
- Contact shadow: a single ellipse at (0,0), fill black at 0.16 opacity (dark mode 0.28), `grounded` falloff via a radial gradient defined once (`lobby-shadow`).
- Contact sheet: one 210x170 cell per variant, each an SVG with its own viewBox centred on the prop, a small plank-floor diamond behind it (so the shadow has a surface), and a caption `<div>` below with `label / variant`. Grid of 5 columns. Both palettes and both modes are shot: `sheet-warm-dark`, `sheet-warm-light`, `sheet-theme-dark`, `sheet-theme-light`.
- Reuse: plant variant 1 wraps `CornerPlant` from ui/office/plants.tsx. Cat variant 1 is a NEW sleeping curled cat (the office Cat is not exported; do not export it, draw fresh).
- Test: every registry variant renders via renderToStaticMarkup without NaN/undefined, and every id starts with `lobby-`.
Acceptance: four sheet PNGs, looked at; nothing cropped by its cell; every floor prop shows a shadow. Gates green on the committed hash. Commit message lists the variant ids.
Locked: anchor convention above (layouts in slice 3 depend on it).

## SLICE-3 PICKUP (authored after slice 2 committed at e6c428f)

What slice 2 taught: the iso kit (iso.tsx) makes boxes and cylinders cheap; hand-drawn paths are where the time goes. Text on the floor plane needs `matrix(0.9 0.45 -0.9 0.45)`, on a wall the wallTransform skew. Drawn arrows, never dingbats. Multiple SVGs on one page may repeat ids harmlessly if the defs are identical. `bun test ui/office` is 70 tests now.

Goal: three complete room layouts a boss could pick from, each rendered in both palettes and both modes.
Mechanics:
- `ui/office/lobby/layouts.ts`: `LOBBY_LAYOUTS: Record<LayoutId, LayoutSpec>`; a spec is a list of placements `{ family, variant, a, b, wall?, x?, y? }` in FLOOR TILE units (0..10 along COL and ROW, origin at the back corner) for floor props, or wall-plane coordinates for wall props. Painter's order: sort floor props by (a + b) ascending (back to front) before drawing; rugs first regardless.
- `LobbyScene` gains a props layer: a third SVG that draws ShadowDefs + PropDefs, then each placement translated to `floorXY(r=b, c=a)`. The layout's variants can be overridden per family through the `variants` prop (`?v=sofa:loveseat,rug:round`) so Nil's picks can be previewed without code changes.
- Walls: copy the office window (night/day scenes, frame, sill) and the clock into `LobbyWalls` with `lobby-` ids, positioned as in the office (window on the left wall, clock on the right). Do NOT edit ui/office/Floor.tsx (another worktree is touching it). Park "extract a shared WallWindow" for merge time.
- Layouts:
  - fireside: brick fireplace centred on the right wall, chesterfield facing it across a round table on the striped rug, club armchair, tall bookcase on the left wall, arc lamp behind the sofa, curled cat on the rug, bunting on the left wall over the bookcase, directory board on the right wall by the door side, corner plant in the back corner.
  - lounge: reception counter along the right wall with the A-frame sign in front, boxy sofa and egg chair around a glass table on the round rug, fish tank on stand against the left wall, credenza under a framed poster, tripod lamp, monstera, sitting cat on the counter side.
  - nook: loveseat under the window with the fish bowl side table, two egg chairs facing it over the oval welcome rug, modern fireplace on the right wall, tall bookcase and credenza side by side on the left wall, bunting on the right wall, monstera and corner plant, curled cat by the fire.
- Shots: `<layout>-<palette>-<mode>` for all three layouts = 12 PNGs, window 1100x820.
- Test: every layout resolves every placement to a registered variant; rendering each layout in each palette has no NaN/undefined and only `lobby-` ids.
Acceptance: 12 PNGs looked at; no prop clips a wall or floats off the slab; nothing hides another prop's face by painter's-order mistakes. Gates green on the committed hash.
Locked: floor tile units for placements; variants overridable by URL.

## SLICE-4 PICKUP (authored after slice 3 committed at 26dfbfb)

What slice 3 taught: sheet-size props are doll furniture in a ten-tile room; PROP_SCALE 1.5 in the props layer fixed it without touching the drawings. Wall pieces near a = 2..3 on the right wall collide with the clock (centre a ≈ 2.5, 184 above the floor). Two props at the same a - b share a screen x and stack; spread them in a - b, not only in a + b. Flipping a sofa (faces +a) is how it "faces" the right wall; the fireplace opening faces +b, so the pair reads as an L, which is fine in iso.

Goal: the three layouts at the office room's level of finish, so any of them could ship after Nil's pick.
Mechanics (each item is small; do them in this order and shoot after each group):
1. Light and warmth: a lamp light pool on the floor under each floor lamp (ellipse, radial gradient, `.lamp-glow` class so light mode hides it like the office); a warm wall glow behind each fireplace (radial gradient on the wall plane, dark mode only); the fireplace's fire flickers already.
2. Ambient life: fish drift and bubbles exist; add a slow steam animation on the mug (exists) and a cat tail sway (exists); add a gentle breathing to the curled cat (exists). Verify all SMIL survives `renderToStaticMarkup` (it does; the test checks for `<animate`).
3. Welcome text: the bunting reads WELCOME; add the office name to the directory boards (done) and to the A-frame (done). Add a small doormat by the front corner? No: the front floor stays clear for ghosts (Nil: ghosts show where a boss is looking).
4. Ground: every floor prop already has a contact shadow; check the flipped ones still sit on their shadow (mirroring is about the anchor, so they do).
5. Contact-sheet and layout composites: `scripts/lobby-gallery.sh` stitches the 12 layout PNGs into three per-layout composites (light+dark side by side, warm over theme) with ImageMagick `montage` if present, else python PIL; check `which montage; python3 -c "import PIL"` first and fall back to leaving the 12 singles.
6. Wire-readiness: export a `LobbyScene` entry from `ui/office/lobby/index.ts` and keep `onToggleTheme` as the only callback, so slice 5 (optional) can mount it in OfficeView.
Shots: the 12 layout PNGs again (out/slice-4) plus the composites.
Test: light mode markup contains no `lamp-glow` visible-by-default element? No: CSS hides it; assert the class is present instead. Fireplace glow group carries class `lobby-dark-only`, and the preview CSS hides it in light mode via a rule appended in preview-entry (the real app would add the same rule to ui/styles.ts at wiring time; park that).
Acceptance: 12 PNGs looked at in both modes; dark mode shows lamp pools and fire glow; light mode shows neither. Gates green on the committed hash.

## SLICE-5 PICKUP (authored after slice 4 committed at db4d8a1)

What slice 4 taught: no ImageMagick or PIL on the box; headless Chrome renders an HTML grid of file:// images with --allow-file-access-from-files and that is the composite tool. tsc is clean (about 60 s).

Goal: let Nil judge the lobby next to a real office room, with humans in it.
Mechanics:
- Ghosts: if ui/office/Ghost.tsx is store-free, the preview entry renders two ghosts (different variants and colours, name tags "Nil" and "Nil (Phone)") hovering in the front third of the lobby at the office's GHOST_SIZE (40 px), `?ghosts=1`. The scene itself stays ghost-free: ghost placement belongs to useGhostTransitions when the tab is wired.
- Office reference: `bun run build:demo`, copy site/demo to /tmp/lobby-demo/demo, serve /tmp/lobby-demo on port 9878, screenshot /demo/ at 1100x820 in both modes (theme toggles by clicking the window; simpler: screenshot the default, then one with `localStorage` theme preset if the demo supports it, else dark only).
- Composite: `scripts/lobby-gallery.sh` gains a `parity` mode: office shot on the left, lobby layout on the right, one row per layout, dark mode.
Acceptance: parity PNG looked at; ghosts sit on the floor plane at office scale. Gates green on the committed hash (build:ui, scoped tests, eslint; shots to out/slice-5).

## COMPLETION NOTE (2026-09-05, about 10:45 box time)

All five slices committed on branch `lobby` (07ecb40, e6c428f, 26dfbfb, db4d8a1, 18c796c); every gate green on each hash, tsc clean on the final one. Evidence in /tmp/lobby-preview/out/slice-N/ and copied to ~/nil/lobby-gallery/. Not merged, not pushed, server untouched.

Parked for Nil: pick a layout (fireside / lounge / nook), a palette (warm / theme), a floor (planks / checker) and per-prop variants by id from the contact sheet; then the wiring work (server-side synthetic lobby room, tab bar entry, OfficeView mount, ghost placement in the lobby, the light-mode CSS rule for `.lobby-dark-only` in ui/styles.ts, extracting a shared window component from Floor.tsx, docs line in features.md) and a reviewer pass before merge.

## SLICE-6 (Nil's morning feedback, 2026-09-05)

Nil's rulings: Employee of the Minute plaque (task fbf4bad6) goes in the lobby, framed-portrait design only, office-wide winner; the isomux icon cube sits on the reception counter; the fireplaces were 90 degrees off (the firebox drawing used the left-wall shear on a face that runs along the right wall); the slab sides must continue the top view's lines and colours.
Landed: ui/office/lobby/props-plaque.tsx + employee.ts (+ tests), plaque family `plaque:framed` hung on the right wall by the directory in all three layouts, cube on the counter, fireboxes re-sheared with matrix(1 0.5 0 1), Slabs rewritten (planks: end grain per board on the front-left edge, the last board's long side on the front-right edge with its seams; checker: tile parity as the office). Task fbf4bad6 retargeted on the board.
Still parked: wiring the real winner (employeeOfTheMinute over the store's agents and stateChangedAt) with the rest of the lobby wiring; Nil's layout and prop picks.
- Nil, 2026-09-05: on the Lobby tab the browser tab title shows the Office Name setting (OfficePane "optional, shown in browser tab"), not "Lobby". Today's rule in ui/App.tsx (the document.title effect) is focused agent, else current room name, else office name; the wiring must make the lobby fall through to the office name instead of naming the room.

## Nil's rulings, 2026-09-05 (evening)

- The theme-coloured palette is gutted. The lobby is warm wood in every theme; only dark/light changes, and each theme already declares its mode in ui/themes.ts. The checker floor went with it (it existed for the theme palette).
- The window's light-mode sun, clouds and rays are the office's drawing, shared not copied: ui/office/Floor.tsx exports `Cloud` and a `SunRays` component that both floors draw. (The cute-visuals worktree is obsolete, Nil 2026-09-05, so its uncommitted Floor.tsx is ignored.) The lobby's own SVG ids stay `lobby-` prefixed; ids coming from those shared components are listed in LobbyScene.test.tsx.
- The lobby has a door on its right wall to the first room (LobbyScene `rightDoor`, drawn with the office's WallDoors). The first room needs the matching door back to the lobby: that one falls out of the existing left-door rule once the lobby is room index 0, so it belongs to the wiring, not the scene.
- Ghosts stand on named spots per layout (`ghostSpots` in layouts.ts), not in a line. The mount picks a spot per connection id and stacks sideways past the last one.
- The backdrop around the room follows all six themes (the page background is the theme's own), while the room stays warm wood. The preview takes ?theme=<id> and the editor has a theme picker.
- Nil, 2026-09-05: OPEN, leaning yes - allow an office with zero rooms, with the lobby as the default room. The lobby's right door still appears, and clicking it creates a room. Decide the label and whether the created room is named or prompted for.

# Agent costumes

Task a6122e1d. Implementation and visual review: 2026-09-09.

The optional `AgentOutfit.costume` field accepts `none`, `doctor`, `police`,
`firefighter`, `chef`, `construction` and `astronaut`. Missing or unknown values
draw the old appearance. `shared/outfit-options.ts` owns the valid choices and
render fallback. The existing full outfit object carries the selection through
spawn, PATCH, persisted agent/history records and office-state events.

PM's corrected ruling keeps the compact `GET /agents` manifest unchanged.
There is no new route, prompt text or curl route label. The config modal puts
the picker with the other appearance controls. The demo sets six sample
costumes and uses the same draw and update paths.

`ui/office/Costume.tsx` draws torso details for the seated ellipse or standing
rectangle. Each detail group is clipped to that torso silhouette. `Character.tsx` draws those details above the torso, below the head,
hair and accessories. Costume headgear has fixed colors. Police, firefighter,
chef, construction and astronaut headgear replaces the saved hat while the
costume is selected. The Hat control still saves a choice; that choice appears
again under None or Doctor. The saved shirt color also returns under None.
Accessories, skin, hair, beard and pose animations keep their current behavior.

All three random appearance generators (`server/outfit.ts`,
`shared/office-state.ts`, and the dialog's `makeRandomOutfit`) still omit the
costume key. Randomize therefore resets the costume to None. The receptionist
profile, welcome outfits, LobbyEditor and lobby preview fixtures
are unchanged and omit the key. Health Navigator uses `costume: "doctor"`.
The other templates omit the key. Construction for Side Project Builder and
Personal Site Builder remains a proposal for Nil; neither is applied.

The shared Character reaches office desks, the lobby receptionist, the log
portrait, the dialog preview and template portraits, and the real Employee of
the Minute plaque. The plaque passes an agent's outfit to a 40-pixel portrait.
Human ghosts use `GhostGraphic`, so this change does not alter them.

## Visual evidence

Artifacts: `/home/nil/nil/isomux-worktrees/sub-api-outfits-artifacts/`.
The Chrome harness follows `internal-docs/ui-verification.md`, uses the real
Character and EmployeePlaque with global styles, and pauses animation. The
demo screenshots use the built demo and its real EditAgentDialog.

- `costumes-desktop.png`: every choice, idle/working/waiting/error, plus the
  40-pixel portrait and actual wall plaque at 1280×900.
- `costumes-mobile.png`: the same set at 390×844, full page.
- `office-desktop.png`, `office-mobile.png`: costumes on the demo desks.
- `config-desktop.png`, `config-mobile.png`: the real config modal with the
  Firefighter choice and live preview.

All six costumes remain in the set after visual inspection. The first modal
capture timed out on an animated sprite; disabling CSS animation in the
capture harness allowed the click. No product change was needed for capture.

## Copy and checks

New English UI strings: `Costume`, `None`, `Doctor`, `Police officer`,
`Firefighter`, `Chef`, `Construction worker`, `Astronaut`. The same keys have
Spanish and Catalan translations in `shared/i18n/`.

Added to the feature inventory and site chatbot: "Choose a doctor, police
officer, firefighter, chef, construction worker or astronaut costume."
The remaining surfaces in `internal-docs/documentation.md` do not need a
headline, architecture, setup or access change.

Tests add unknown/missing/None rendering parity, headgear replacement, costume visibility in every
pose and the small portrait, a translated picker/preview interaction, and a
PATCH round trip. The existing persistence fixture gains `costume: astronaut`
to exercise lossless storage. No test assertion was removed or replaced.
Gate results and their commit hash travel in the lane hand-off logs.

After merge, build the UI to serve the feature. The subscription proposal is
design only. No server restart is needed for these runtime changes.

## Drawing pass, 2026-09-10

Hair uses curved silhouettes and small highlights. Beards follow the jaw;
glasses have a bridge and side arms; ties sit below the chin. Hats have curved
brims, seams and bands. The six uniforms use clipped shading and finer seams;
headgear sits closer to the head. Outfit choices and saved fields are unchanged.

Before/after contact sheets are under `/tmp/agent-look/`, one pair each for
`hairStyle`, `beard`, `hat`, `accessory` and `costume`. Each sheet uses the same
base character, seated and standing, at 68px office size, 44px portrait size
and 136px for detail. Chrome renders the shared Character with the global
stylesheet and paused animation. Office and template-picker captures use the
built demo with `ui/demo-server.ts`. No capture harness ships in the product.

The template catalog test checks valid costume ids and pins Health Navigator
as the only template with a costume. Character tests remain unchanged.

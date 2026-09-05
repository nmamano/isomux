// Picks the room's pet. Opened by clicking the pet in the scene.
//
// Follows WallPanelMenu: a Portal at fixed client coordinates, dismissed by a
// pointerdown outside or Escape. It reads no capability, because there is none
// to read - room:manage is held by every human role (server/identity/index.ts
// says owner and member hold the same set), so a browser user always has it.
// The route enforces it regardless; a plain agent gets 403 there.

import { useEffect, useRef } from "react";
import { Portal } from "../components/Portal.tsx";
import {
  PET_PALETTES,
  PET_SPECIES,
  type PetSpecies,
  type RoomPet,
} from "../../shared/pets.ts";
import { PETS, PetDefs } from "./RoomProps.tsx";

const SPECIES_LABEL: Record<PetSpecies, string> = {
  cat: "Cat",
  dog: "Dog",
  rabbit: "Rabbit",
  tortoise: "Tortoise",
};

/** One animal at picker size. The drawings sit on the floor at y 0 with ears
 *  and tails above them, so the box is taller than it is wide about the origin. */
function SpeciesThumb({ species }: { species: PetSpecies }) {
  const Species = PETS[species].Species;
  return (
    <svg width={40} height={30} viewBox="-27 -26 54 40" aria-hidden="true">
      <PetDefs />
      <Species p={PET_PALETTES[species][0]} />
    </svg>
  );
}

export function PetPicker({
  x,
  y,
  pet,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  pet: RoomPet | null;
  onPick: (next: RoomPet | null) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleDismiss(e: Event) {
      const target = (e as TouchEvent).touches?.[0]?.target ?? e.target;
      if (ref.current && !ref.current.contains(target as Node)) onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    // pointerdown, not mousedown: the office viewport preventDefaults
    // pointerdown on the pannable background, which suppresses the
    // compatibility mousedown - same reason as WallPanelMenu.
    document.addEventListener("pointerdown", handleDismiss);
    document.addEventListener("touchstart", handleDismiss);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handleDismiss);
      document.removeEventListener("touchstart", handleDismiss);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  const MENU_W = 232;
  const MENU_H_EST = PET_SPECIES.length * 58 + 78;
  const left = Math.min(x, window.innerWidth - MENU_W - 8);
  const top = Math.min(y, window.innerHeight - MENU_H_EST - 8);

  return (
    <Portal>
      <div
        ref={ref}
        role="dialog"
        aria-label="Room pet"
        style={{
          position: "fixed",
          left: Math.max(8, left),
          top: Math.max(8, top),
          zIndex: 1000,
          width: MENU_W,
          background: "var(--bg-overlay)",
          backdropFilter: "blur(16px)",
          border: "1px solid var(--border-light)",
          borderRadius: 12,
          padding: 10,
          boxShadow: "0 8px 32px rgba(0,0,0,0.32)",
        }}
      >
        <div
          style={{
            font: "600 12px var(--font-ui, sans-serif)",
            color: "var(--text-secondary)",
            padding: "0 2px 8px",
          }}
        >
          Room pet
        </div>
        <button
          type="button"
          aria-pressed={pet === null}
          onClick={() => onPick(null)}
          style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            font: "12px var(--font-ui, sans-serif)",
            color: "var(--text-primary)",
            background: pet === null ? "var(--bg-subtle)" : "transparent",
            border: "1px solid",
            borderColor: pet === null ? "var(--accent)" : "var(--border)",
            borderRadius: 8,
            padding: "6px 8px",
            marginBottom: 8,
            cursor: "pointer",
          }}
        >
          Default
        </button>
        {PET_SPECIES.map((species) => (
          <div
            key={species}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "4px 2px",
            }}
          >
            <SpeciesThumb species={species} />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {PET_PALETTES[species].map((palette, coat) => {
                const chosen =
                  pet !== null && pet.species === species && pet.coat === coat;
                return (
                  <button
                    key={coat}
                    type="button"
                    // The selected coat is marked by its border colour, which
                    // is no help to a screen reader or to anyone who cannot
                    // separate the accent from the coat's own outline.
                    aria-pressed={chosen}
                    title={`${SPECIES_LABEL[species]} ${coat + 1}`}
                    aria-label={`${SPECIES_LABEL[species]} coat ${coat + 1}`}
                    onClick={() => onPick({ species, coat })}
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: "50%",
                      background: palette.coat,
                      border: "2px solid",
                      borderColor: chosen ? "var(--accent)" : palette.mark,
                      cursor: "pointer",
                      padding: 0,
                    }}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Portal>
  );
}

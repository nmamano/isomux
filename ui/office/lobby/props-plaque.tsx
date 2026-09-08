import { useI18n } from "../../i18n.tsx";
import type { AgentOutfit } from "../../../shared/types.ts";
import { Character } from "../Character.tsx";
import { wallTransform } from "./iso.tsx";

// The Employee of the Minute plaque, framed-portrait design (Nil's pick,
// 2026-09-05; the gold cameo alternative stays at git tag eotm-plaque). Drawn
// flat, 52 by 68, bottom centre at the origin, then sheared onto its wall.

const PLAQUE_NAME_MAX = 13;
function plaqueName(name: string): string {
  return name.length > PLAQUE_NAME_MAX
    ? `${name.slice(0, PLAQUE_NAME_MAX - 1)}…`
    : name;
}

export function EmployeePlaque({
  wall,
  name,
  outfit,
}: {
  wall: "left" | "right";
  name: string;
  outfit: AgentOutfit;
}) {
  const { t } = useI18n();
  return (
    <g transform={`${wallTransform(wall, 0, 0)} translate(0 -34)`}>
      <defs>
        <clipPath id="lobby-eotm-mat">
          <rect x="-21" y="-29" width="42" height="58" rx="1" />
        </clipPath>
      </defs>
      {/* Shadow cast on the wall */}
      <rect x="-24" y="-31" width="52" height="68" rx="2" fill="#000" opacity="0.3" />
      {/* Walnut frame, lit from the window side */}
      <rect x="-26" y="-34" width="52" height="68" rx="2" fill="#4A3826" stroke="#2C2016" strokeWidth="1" />
      <path d="M-26 -32 Q-26 -34 -24 -34 L24 -34 Q26 -34 26 -32 L23 -29 L-23 -29 Z" fill="#6A5238" />
      <path d="M-26 32 Q-26 34 -24 34 L24 34 Q26 34 26 32 L23 29 L-23 29 Z" fill="#2E2317" />
      {/* Brass inset */}
      <rect x="-23" y="-31" width="46" height="62" rx="1" fill="none" stroke="#B69A5E" strokeWidth="0.6" />
      {/* Mat, shaded under the top rail */}
      <rect x="-21" y="-29" width="42" height="58" rx="1" fill="#F1E9D6" />
      <rect x="-21" y="-29" width="42" height="5" fill="#B7A87F" opacity="0.4" />
      <g fill="#6B4E28" fontFamily="monospace" fontWeight="bold" fontSize="5.8" textAnchor="middle">
        <text y="-21">{t("lobby.employeeLine1")}</text>
        <text y="-14.5">{t("lobby.employeeLine2")}</text>
      </g>
      <line x1="-13" y1="-11" x2="13" y2="-11" stroke="#C2A365" strokeWidth="0.6" />
      {/* The winner, drawn by the same Character sprite that sits at the desks.
          The portrait pose leaves the top third of its box empty, so the offset
          lifts the bust into the mat rather than shrinking it. */}
      <g clipPath="url(#lobby-eotm-mat)">
        <g transform="translate(-15.3, -19)">
          <Character state="idle" outfit={outfit} portrait height={40} />
        </g>
      </g>
      {/* Engraved brass name strip */}
      <rect x="-19" y="18" width="38" height="8.5" rx="1" fill="#C2A365" stroke="#8E7440" strokeWidth="0.4" />
      <text y="24.2" fill="#2E2417" fontFamily="monospace" fontWeight="bold" fontSize="5.6" textAnchor="middle">
        {plaqueName(name)}
      </text>
    </g>
  );
}

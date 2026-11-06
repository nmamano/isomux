import { useContext, useId } from "react";
import { LobbyLiveCtx } from "./live.ts";
import { useI18n } from "../../i18n.tsx";
import { iso, shade } from "./iso.tsx";
import { REPO_URL } from "../../repo.ts";

// A glass tip jar of gold stars on the reception counter, with a kraft tag
// that links to the repo. Only the words go on the tag: GitHub's brand rules
// forbid adapting its logo or mascot.

// Where the jar stands on the counter (counter-local units) and the box that
// holds the jar and its tag around that spot.
const JAR_AT = iso(-34, 5, 32);
// The tag's top left corner, relative to the jar: on the counter's front face
// (b = 14 with the top's overhang), just under the top.
const TAG_AT = (() => {
  const [x, y] = iso(-41, 14, 27);
  return [x - JAR_AT[0], y - JAR_AT[1]];
})();
const LOCAL_BOX = { x: -17, y: -25, width: 44, height: 63 };
export const STAR_JAR_BOX = {
  x: JAR_AT[0] + LOCAL_BOX.x,
  y: JAR_AT[1] + LOCAL_BOX.y,
  width: LOCAL_BOX.width,
  height: LOCAL_BOX.height,
};

// A five-pointed star centred on (0,0), outer radius r.
function starPath(r: number, inner = 0.45): string {
  const out: string[] = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * inner;
    const t = -Math.PI / 2 + (i * Math.PI) / 5;
    out.push(
      `${(Math.cos(t) * rad).toFixed(2)} ${(Math.sin(t) * rad).toFixed(2)}`,
    );
  }
  return `M${out.join(" L")} Z`;
}

// The stars in the jar, back rows first: x, y, colour, turn.
const PILE: Array<[number, number, string, number]> = [
  [-5, -3, "#f5b942", 10],
  [0, -2.5, "#f5c542", -15],
  [5, -3, "#ffd76a", 25],
  [-3, -6.5, "#ffd23f", 35],
  [2.5, -7, "#f5b942", 0],
  [6, -8, "#f5c542", -30],
  [-6, -9.5, "#ffe08a", -10],
  [-1, -11, "#f5c542", 20],
  [4, -12.5, "#ffd76a", 40],
  [-4.5, -14, "#f5b942", 5],
  [1, -15.5, "#ffd23f", -20],
];

const GLASS =
  "M-8 -1 L-8 -18 Q-8 -21 -6.5 -21.5 L6.5 -21.5 Q8 -21 8 -18 L8 -1 Q0 2.5 -8 -1 Z";
const CYCLE = "9s";

// The tag grows with its words, which differ by language.
function textWidth(text: string, size: number): number {
  let w = 0;
  for (const ch of text)
    w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.56;
  return w * size;
}

export function StarJar() {
  const { t } = useI18n();
  const live = useContext(LobbyLiveCtx);
  const clip = `star-jar-${useId().replace(/:/g, "")}`;
  const label = t("lobby.starJar.tag");
  const size = 3.6;
  const tagW = Math.max(26, textWidth(label, size) + 14);
  const jar = (
    <g transform={`translate(${JAR_AT.join(" ")})`}>
      <defs>
        <clipPath id={clip}>
          <path d={GLASS} />
        </clipPath>
      </defs>
      <ellipse cx="0" cy="0.5" rx="9" ry="3" fill="#000" opacity="0.18" />
      {/* The back of the glass, then the pile seen through it. */}
      <path d={GLASS} fill="#cfeaf3" fillOpacity="0.3" />
      <g clipPath={`url(#${clip})`}>
        {PILE.map(([x, y, col, rot], i) => (
          <path
            key={i}
            d={starPath(3.2)}
            transform={`translate(${x} ${y}) rotate(${rot})`}
            fill={col}
            stroke={shade(col, 0.72)}
            strokeWidth="0.4"
            strokeLinejoin="round"
          />
        ))}
      </g>
      {/* A glint now and then on two of the stars. */}
      {[
        [-1, -12, "3.1s"],
        [5, -4, "4.3s"],
      ].map(([x, y, dur], i) => (
        <path
          key={i}
          d="M0 -2 L0.4 -0.4 L2 0 L0.4 0.4 L0 2 L-0.4 0.4 L-2 0 L-0.4 -0.4 Z"
          transform={`translate(${x} ${y})`}
          fill="#fff"
          opacity="0"
        >
          <animate
            attributeName="opacity"
            values="0;0;1;0;0"
            keyTimes="0;0.7;0.78;0.86;1"
            dur={dur}
            repeatCount="indefinite"
          />
        </path>
      ))}
      {/* The front of the glass: an outline, a highlight and the rim. */}
      <path
        d={GLASS}
        fill="none"
        stroke="#eef9fd"
        strokeWidth="0.7"
        strokeOpacity="0.9"
      />
      <path
        d="M-5.8 -4 L-5.8 -17"
        stroke="#fff"
        strokeWidth="1.1"
        opacity="0.55"
        strokeLinecap="round"
      />
      <ellipse
        cx="0"
        cy="-21.5"
        rx="6.5"
        ry="1.8"
        fill="#e6f6fb"
        fillOpacity="0.35"
        stroke="#f4fbfd"
        strokeWidth="0.6"
      />
      {/* A star drops in now and then and joins the pile. */}
      <path
        d={starPath(2.8)}
        fill="#ffe08a"
        stroke="#d9a83a"
        strokeWidth="0.4"
        strokeLinejoin="round"
        opacity="0"
      >
        <animateTransform
          attributeName="transform"
          type="translate"
          values="1 -40;1 -17;1 -17"
          keyTimes="0;0.08;1"
          calcMode="spline"
          keySplines="0.5 0 1 1;0 0 1 1"
          dur={CYCLE}
          repeatCount="indefinite"
        />
        <animate
          attributeName="opacity"
          values="0;1;1;0;0"
          keyTimes="0;0.02;0.08;0.13;1"
          dur={CYCLE}
          repeatCount="indefinite"
        />
      </path>
      {/* A kraft tag on a string from the neck, hung over the counter's
          front edge, in the plane of the front face. */}
      <path
        d={`M-6.5 -20 Q-14 -12 ${TAG_AT[0] + 2.8} ${TAG_AT[1] + 3.5}`}
        stroke="#8a6a40"
        strokeWidth="0.5"
        fill="none"
      />
      <g transform={`translate(${TAG_AT.join(" ")}) skewY(26.565)`}>
        <g>
          <animateTransform
            attributeName="transform"
            type="rotate"
            values="-2 2.8 5;2 2.8 5;-2 2.8 5"
            dur="5s"
            repeatCount="indefinite"
          />
          <path
            d={`M3 0 L${tagW} 0 L${tagW} 10 L3 10 L0 7 L0 3 Z`}
            fill="#e3c9a0"
            stroke="#a8875a"
            strokeWidth="0.5"
            strokeLinejoin="round"
          />
          <circle cx="2.8" cy="5" r="0.9" fill="#8a6a40" />
          <path d={starPath(1.8)} transform="translate(7 5.1)" fill="#e0a92e" />
          <text
            x={(tagW + 9) / 2}
            y={5 + size * 0.36}
            textAnchor="middle"
            fontSize={size}
            fontWeight="700"
            fontFamily="ui-rounded, 'Nunito', system-ui, sans-serif"
            fill="#4a3510"
          >
            {label}
          </text>
        </g>
      </g>
    </g>
  );
  if (!live) return jar;
  // The props layer is hidden from screen readers, so the keyboard link is in
  // LobbyControls.
  return (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      tabIndex={-1}
      data-no-pan
      onMouseDown={(event) => event.preventDefault()}
      style={{ cursor: "pointer", pointerEvents: "auto" }}
    >
      <title>{t("lobby.starJar.open")}</title>
      {jar}
    </a>
  );
}

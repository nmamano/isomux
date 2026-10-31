// The mark on an ask's recommended option, on the ask card and in an
// expanded ask link. An SVG, not a glyph: iOS Safari draws shape glyphs
// through the emoji font and ignores CSS color. It has no text child, so the
// word reaches screen readers through aria-label only and stays out of the
// visible text. Keep it outside noTranslate: the label is ours, not the
// agent's.

import { useI18n } from "../i18n.tsx";

export function RecommendedStar({
  size,
  color = "currentColor",
}: {
  size: number;
  color?: string;
}) {
  const { t } = useI18n();
  return (
    <svg
      role="img"
      aria-label={t("asks.recommended")}
      data-ask-recommended-mark=""
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={color}
      style={{
        display: "inline-block",
        verticalAlign: "-0.1em",
        marginRight: 4,
        flexShrink: 0,
      }}
    >
      <path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z" />
    </svg>
  );
}

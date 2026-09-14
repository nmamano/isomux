// Names and other identity data must survive browser page translation. Keep
// the HTML attribute for current translators and the class for older ones.
export function noTranslate(className?: string) {
  return {
    translate: "no" as const,
    className: [className, "notranslate"].filter(Boolean).join(" "),
  };
}

import { useMemo } from "react";
import { html as diff2htmlRender } from "diff2html";

export type DiffOutputFormat = "line-by-line" | "side-by-side";

// Thin wrapper around diff2html. The replaceable boundary that a future Tier A
// rewrite (hand-rolled React on Shiki tokens) would target without touching
// <DiffCard> consumers.
export function DiffRenderer({
  patchText,
  outputFormat,
  drawFileList = false,
}: {
  patchText: string;
  outputFormat: DiffOutputFormat;
  drawFileList?: boolean;
}) {
  const rendered = useMemo(
    () =>
      diff2htmlRender(patchText, {
        outputFormat,
        drawFileList,
        matching: "lines",
        diffStyle: "word",
        renderNothingWhenEmpty: true,
      }),
    [patchText, outputFormat, drawFileList],
  );
  return (
    <div
      className="d2h-isomux-host"
      dangerouslySetInnerHTML={{ __html: rendered }}
    />
  );
}

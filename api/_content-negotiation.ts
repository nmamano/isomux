export type Representation = "text/html" | "text/markdown";

function quality(
  accept: string,
  representation: Representation,
): { q: number; order: number } {
  let best = -1;
  let bestSpecificity = -1;
  let bestOrder = Number.MAX_SAFE_INTEGER;
  for (const [order, entry] of accept.split(",").entries()) {
    const [rawType, ...parameters] = entry.trim().toLowerCase().split(";");
    const specificity =
      rawType === representation
        ? 2
        : rawType === "text/*"
          ? 1
          : rawType === "*/*"
            ? 0
            : -1;
    if (specificity < 0) continue;
    const qParameter = parameters.find((parameter) =>
      parameter.trim().startsWith("q="),
    );
    const q = qParameter ? Number(qParameter.trim().slice(2)) : 1;
    if (!Number.isFinite(q) || q < 0 || q > 1) continue;
    if (
      specificity > bestSpecificity ||
      (specificity === bestSpecificity &&
        (q > best || (q === best && order < bestOrder)))
    ) {
      best = q;
      bestSpecificity = specificity;
      bestOrder = order;
    }
  }
  return { q: best, order: bestOrder };
}

export function negotiate(accept: string | null): Representation | null {
  if (!accept) return "text/html";
  const markdown = quality(accept, "text/markdown");
  const html = quality(accept, "text/html");
  if (markdown.q <= 0 && html.q <= 0) return null;
  if (markdown.q !== html.q)
    return markdown.q > html.q ? "text/markdown" : "text/html";
  return markdown.order < html.order ? "text/markdown" : "text/html";
}

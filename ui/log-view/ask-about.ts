// The start of an ask's question, for the "about this ask" prefix the ask
// card puts in front of the chat draft (AskAboutButton): one line, at most
// EXCERPT_POINTS code points, cut at a word where the language has spaces.

const EXCERPT_POINTS = 40;
// A cut backs off to a space only past this point; a hard cut is better than
// an excerpt of one short word.
const MIN_WORD_CUT = 20;

export function askExcerpt(prompt: string): string {
  const points = Array.from(prompt.replace(/\s+/g, " ").trim());
  if (points.length <= EXCERPT_POINTS) return points.join("");
  let head = points.slice(0, EXCERPT_POINTS);
  // When the next point is a space, the head already ends at a word.
  if (points[EXCERPT_POINTS] !== " ") {
    const space = head.lastIndexOf(" ");
    if (space > MIN_WORD_CUT) head = head.slice(0, space);
  }
  return head.join("").trimEnd() + "…";
}

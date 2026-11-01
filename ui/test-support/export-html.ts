// Checks on a chat HTML export (ui/log-view/chat-export.ts): the file must not
// run code, hold an input, or point at the office it came from.

const URL_ATTRS = [
  "href",
  "xlink:href",
  "src",
  "srcset",
  "poster",
  "action",
  "formaction",
  "data",
  "background",
  "cite",
];
const FORBIDDEN_TAGS = [
  "script",
  "iframe",
  "frame",
  "object",
  "embed",
  "input",
  "textarea",
  "select",
  "form",
  "base",
  "link",
  "meta[http-equiv]",
];

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

// Why `value`, found on `tag`, may not be in the file, or null when it may.
function badUrl(value: string, tag: string, origin: string): string | null {
  const v = value.trim();
  if (v.startsWith("data:")) return null;
  // A fragment points inside the file (SVG markers and icons), except on a
  // link, where it was a control of the chat.
  if (v.startsWith("#")) return tag === "a" ? "fragment link" : null;
  let url: URL;
  try {
    url = new URL(v, origin);
  } catch {
    return "unparsable";
  }
  if (url.protocol === "mailto:") return null;
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return url.protocol;
  return url.origin === new URL(origin).origin ? "office" : null;
}

function cssUrls(css: string): string[] {
  return [...css.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/g)].map((m) => m[2]);
}

// Each URL in the file that points at `origin`, at a script, or at a chat
// control, as "<tag> <attr>=<value> (<why>)". Empty when the file is clean.
export function officeUrlsIn(html: string, origin: string): string[] {
  const doc = parse(html);
  const found: string[] = [];
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    const tag = el.tagName.toLowerCase();
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const values: string[] = [];
      if (URL_ATTRS.includes(name))
        values.push(
          ...(name === "srcset"
            ? attr.value.split(",").map((part) => part.trim().split(/\s+/)[0])
            : [attr.value]),
        );
      if (name === "style") values.push(...cssUrls(attr.value));
      for (const value of values) {
        const why = badUrl(value, tag, origin);
        if (why) found.push(`${tag} ${name}=${value} (${why})`);
      }
    }
    if (tag === "style")
      for (const value of cssUrls(el.textContent ?? "")) {
        const why = badUrl(value, tag, origin);
        if (why) found.push(`style url(${value}) (${why})`);
      }
  }
  return found;
}

// Each element or attribute that could run code or take input in the file.
export function activeContentIn(html: string): string[] {
  const doc = parse(html);
  const found: string[] = [];
  // happy-dom's parser drops a <script> inside <svg> and all that follows it,
  // so the parsed page alone cannot show one. Text in the page has its "<"
  // escaped, so a raw "<script" is a tag.
  if (/<script\b/i.test(html) && doc.querySelectorAll("script").length === 0)
    found.push("<script> (raw)");
  for (const selector of FORBIDDEN_TAGS)
    for (const el of Array.from(doc.querySelectorAll(selector)))
      found.push(`<${el.tagName.toLowerCase()}>`);
  for (const el of Array.from(doc.querySelectorAll("*")))
    for (const attr of Array.from(el.attributes))
      if (attr.name.toLowerCase().startsWith("on"))
        found.push(`${el.tagName.toLowerCase()} ${attr.name}`);
  return found;
}

export function parseExport(html: string): Document {
  return parse(html);
}

// The Discord bot steps hint links the Discord Developer Portal, where the
// member makes the bot (task eca94ddd). One check for both places that show
// the hint: the Integrations connect form and the discord-bot secret ask.

import { expect } from "bun:test";
import { en } from "../../shared/i18n/en.ts";

// A protocol value: the portal's page that lists the member's applications.
const PORTAL = "https://discord.com/developers/applications";

// Inside root: one anchor to the portal that opens in a new tab, its text the
// <link> span of the English entry, and the whole hint around it as text.
export function expectPortalLink(root: Element) {
  const links = [...root.querySelectorAll("a")].filter(
    (a) => a.getAttribute("href") === PORTAL,
  );
  expect(links.length).toBe(1);
  const link = links[0];
  expect({
    target: link.getAttribute("target"),
    noreferrer: (link.getAttribute("rel") ?? "")
      .split(/\s+/)
      .includes("noreferrer"),
  }).toEqual({ target: "_blank", noreferrer: true });
  const template: string = en["integrations.discord.steps"];
  const span = /<link>(.+?)<\/link>/.exec(template)?.[1];
  expect(span).toBeDefined();
  expect(link.textContent).toBe(span!);
  expect(link.parentElement?.textContent).toBe(
    template.replace(/<\/?link>/g, ""),
  );
}

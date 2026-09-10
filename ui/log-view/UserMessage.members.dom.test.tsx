import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { UserMessage } = await import("./LogEntryCard.tsx");

it("keeps default user messages literal and puts an injected accessory alongside content", () => {
  const view = render(createElement(UserMessage, { content: '**literal**', footer: createElement('span', null, 'footer') }));
  expect(view.container.querySelector('strong') === null).toBe(true);
  expect(view.getByText('**literal**').textContent).toBe('**literal**');
  expect(view.getByText('footer').parentElement?.getAttribute('data-members-chat-message')).toBeNull();
  view.rerender(createElement(UserMessage, {
    variant: 'members-chat', content: '**rendered**',
    beforeContent: createElement('span', null, 'quote'),
    renderedContent: createElement('strong', null, 'rendered'),
    inlineAccessory: createElement('button', null, 'reaction'),
  }));
  expect(view.container.querySelector('strong')?.textContent).toBe('rendered');
  const row = view.getByRole('button', { name: 'reaction' }).parentElement!;
  expect(row.contains(view.getByText('rendered'))).toBe(true);
  expect(row.style.display).toBe('flex');
  expect(row.previousElementSibling?.textContent).toBe('quote');
});

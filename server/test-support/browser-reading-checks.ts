import { expect } from "bun:test";
import type { Page } from "playwright-core";

type Action = (body: Record<string, unknown>) => Promise<{
  status: number;
  body: { snapshot?: string; text?: string; error?: { code: string; message: string } };
}>;

// Only fake content in an isolated Chrome profile. Requests use the production
// agent HTTP route and extension; setup is through the fixture's own CDP client.
export async function checkBrowserReading(page: Page, action: Action) {
  const draft = "Fixture nested draft alpha";
  const hidden = "Fixture private hidden beta";
  const textarea = "Fixture textarea gamma";
  const namedValue = "Fixture matching name delta";
  const inherited = "Fixture inherited editable epsilon";
  await page.setContent(`<div role="dialog" id="compose">
    <div role="textbox" contenteditable="true" aria-label="Quote" aria-multiline="true"><div><span data-text="true">${draft}</span></div></div>
    <div role="textbox" contenteditable="true" hidden>${hidden}</div>
    <div aria-hidden="true"><div role="textbox" contenteditable="true">${hidden}</div></div>
    <div role="textbox" contenteditable="true" style="visibility:hidden">${hidden}</div>
    <div role="textbox" contenteditable="true" aria-label="Empty"></div>
    <div contenteditable="true"><div role="textbox" aria-label="Inherited">${inherited}</div></div>
    <div role="textbox" contenteditable="true" aria-label="${namedValue}">${namedValue}</div>
    <textarea aria-label="Textarea">${textarea}</textarea>
    <button onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1)">Post</button>
  </div><iframe src="/frame"></iframe>`);
  await page.frameLocator("iframe").frameLocator("iframe").locator("#nested").waitFor();
  const snapshot = await action({ action: "snapshot" });
  const text = await action({ action: "text" });
  console.log("Reading fixture:", JSON.stringify({ snapshot, text }));
  expect(snapshot.status).toBe(200);
  expect(text.body.text).toContain(draft);
  // This fails on the original implementation: role=textbox hides child spans.
  expect(snapshot.body.snapshot).toContain(draft);
  expect(snapshot.body.snapshot).toContain(inherited);
  expect(snapshot.body.snapshot).not.toContain(hidden);
  expect(snapshot.body.snapshot?.split(textarea)).toHaveLength(2);
  expect(snapshot.body.snapshot?.split(namedValue)).toHaveLength(2);
  expect(snapshot.body.snapshot).toContain("framePath=[0]");
  expect(snapshot.body.snapshot).toContain("framePath=[0,0]");
  expect(snapshot.body.snapshot).toContain("Nested frame content");
  for (const kind of ["snapshot", "text"] as const) {
    const scope = await action({ action: kind, selector: "#compose" });
    expect(scope.status).toBe(200);
    expect(scope.body[kind]).toContain(draft);
    expect(scope.body[kind]).not.toContain("Nested frame content");
    const nested = await action({ action: kind, framePath: [0, 0], selector: "p" });
    expect(nested.status).toBe(200);
    expect(nested.body[kind]).toContain("Nested frame content");
    expect(nested.body[kind]).not.toContain(draft);
    const frameBody = await action({ action: kind, framePath: [0] });
    expect(frameBody.status).toBe(200);
    expect(frameBody.body[kind]).toContain("Frame contents");
    expect(frameBody.body[kind]).not.toContain("Nested frame content");
    expect((await action({ action: kind, framePath: [9] })).body.error?.code).toBe("action_failed");
    expect((await action({ action: kind, selector: "div" })).body.error?.code).toBe("action_failed");
  }
  const own = await action({ action: "snapshot", selector: 'role=textbox[name="Quote"]' });
  expect(own.body.snapshot).toContain(draft);
  for (const selector of ['role=button[name="Post"][exact=true]', 'css=[', 'bogus=private-selector-sentinel', 'role=button[name=/[/]']) {
    const bad = await action({ action: "click", selector });
    console.log("Selector fixture:", JSON.stringify(bad));
    expect(bad.status).toBe(400);
    expect(bad.body.error?.code).toBe("invalid_request");
    expect(JSON.stringify(bad.body)).not.toContain(draft);
    expect(JSON.stringify(bad.body)).not.toContain(hidden);
    expect(JSON.stringify(bad.body)).not.toContain("private-selector-sentinel");
    expect(await page.locator("button").getAttribute("data-clicks")).toBeNull();
    const badRead = await action({ action: "snapshot", selector });
    expect(badRead.status).toBe(400);
    expect(badRead.body.error).toEqual(bad.body.error);
  }
  expect((await action({ action: "click", selector: 'role=dialog >> role=button[name=/^Post$/]' })).status).toBe(200);
  expect(await page.locator("button").getAttribute("data-clicks")).toBe("1");
  expect((await action({ action: "snapshot", selector: "#compose" })).body.snapshot).toContain(draft);
  await page.setContent(`<div role="textbox" contenteditable="true" aria-label="Large">${"z".repeat(25_000)}</div>`);
  const large = await action({ action: "snapshot" });
  expect(large.body.snapshot?.length).toBe(20_000);
  expect(large.body.snapshot).toContain("z".repeat(100));
  expect(large.body.snapshot).not.toContain("z".repeat(25_000));
  await page.setContent(`<main>${Array.from({ length: 700 }, (_, i) => `<article>Earlier feed entry ${i} ${"x".repeat(40)}</article>`).join("")}<article id="late">Late fixture entry omega</article></main>`);
  for (const kind of ["snapshot", "text"] as const) {
    const whole = await action({ action: kind });
    expect(whole.body[kind]?.length).toBeLessThanOrEqual(20_000);
    expect(whole.body[kind]).not.toContain("Late fixture entry omega");
    const late = await action({ action: kind, selector: "#late" });
    console.log("Late feed fixture:", JSON.stringify(late));
    expect(late.body[kind]).toContain("Late fixture entry omega");
    expect(late.body[kind]).not.toContain("Earlier feed entry");
  }
}

// A disabled button looks disabled wherever it is (task 5ea0e610; Nil,
// 2026-11-14: "make sure these applies to every button that does nothing").
// The look comes from one rule in the CSS every page mounts, not from each
// button's own style: a button that styles itself inline, or lights itself up
// on hover, still shows disabledLook while disabled. A control that draws its
// own disabled state opts out with OWN_DISABLED_LOOK_ATTR.
import { afterEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { CSS } = await import("./styles.ts");
const { disabledLook, OWN_DISABLED_LOOK_ATTR } =
  await import("./components/dialog-styles.ts");

// The look's variables get distinct values, so a property that misses the
// rule cannot match it by an empty value.
const VARS = `:root { --btn-surface: rgb(11, 22, 33); --border: rgb(44, 55, 66); --text-hint: rgb(77, 88, 99); }`;

// An enabled button's own look: every property disabledLook sets, each
// different from it. As a button's inline style would set it.
const OWN: Record<string, string> = {
  background: "rgb(200, 10, 10)",
  boxShadow: "rgb(0, 0, 255) 0px 0px 0px 3px",
  color: "rgb(250, 250, 250)",
  cursor: "pointer",
};

const PROPS = Object.keys(disabledLook);

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

function mount() {
  const style = document.createElement("style");
  style.textContent = CSS + "\n" + VARS;
  document.head.appendChild(style);
}

function styled(tag: string, look: Record<string, unknown>): HTMLElement {
  const el = document.createElement(tag);
  Object.assign(el.style, look);
  document.body.appendChild(el);
  return el;
}

function computed(el: HTMLElement): Record<string, string> {
  const style = getComputedStyle(el) as unknown as Record<string, string>;
  return Object.fromEntries(PROPS.map((p) => [p, style[p]]));
}

// What disabledLook computes to, and what the button's own look computes to.
// Each test's verdict rests on the two differing in every property, so that
// is checked on every call.
function expected() {
  const disabled = computed(styled("span", { ...disabledLook }));
  const own = computed(styled("span", OWN));
  expect(PROPS.length).toBeGreaterThan(0);
  for (const p of PROPS) {
    expect({ p, differ: disabled[p] !== own[p] && disabled[p] !== "" }).toEqual(
      { p, differ: true },
    );
  }
  return { disabled, own };
}

it("a disabled button that styles itself shows disabledLook, also after a hover writes its style", () => {
  mount();
  const { disabled } = expected();
  const button = styled("button", OWN) as HTMLButtonElement;
  button.disabled = true;
  expect(computed(button)).toEqual(disabled);
  // An onMouseEnter handler that lights the button up.
  button.style.background = "rgb(0, 200, 0)";
  button.style.color = "rgb(1, 1, 1)";
  expect(computed(button)).toEqual(disabled);
});

it("an enabled button keeps its own look, and takes disabledLook once disabled", () => {
  mount();
  const { disabled, own } = expected();
  const button = styled("button", OWN) as HTMLButtonElement;
  expect(computed(button)).toEqual(own);
  button.disabled = true;
  expect(computed(button)).toEqual(disabled);
  button.disabled = false;
  expect(computed(button)).toEqual(own);
});

it("a disabled button with the opt-out attribute keeps its own look", () => {
  mount();
  const { disabled, own } = expected();
  const button = styled("button", OWN) as HTMLButtonElement;
  button.disabled = true;
  // The same button without the attribute takes the look, so the attribute
  // is what keeps its own.
  expect(computed(button)).toEqual(disabled);
  button.setAttribute(OWN_DISABLED_LOOK_ATTR, "");
  expect(computed(button)).toEqual(own);
});

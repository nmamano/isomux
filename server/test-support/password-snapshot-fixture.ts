// A login-like page with filled password fields, shared by the fake-frame
// tests in browser-frames.test.ts and the real-Chrome check in
// browser-frames.live.test.ts. SNAPSHOT is what Playwright's ariaSnapshot
// renders for PAGE after FILLS: the live test asserts that it still does, so a
// Playwright upgrade that changes the format makes the fixture fail there.
export const PASSWORD_PAGE = `<label>Password <input type=password id=plain></label>
<input type=password aria-label="Quoted" id=quoted>
<input type=password aria-label="Spaces" id=spaces>
<input type=password aria-label="Hint" placeholder="Enter it" id=hint>
<input type=password id=named><button aria-labelledby="named">Go</button>
<input type=password id=colon><button aria-labelledby="colon">Go</button>
<input type=password id=escaped><button aria-labelledby="escaped">Go</button>
<input type=password aria-label="PIN" id=pin><p>Step 3 of 4</p><a href="#">Page 3</a>
<input type=password id=four><button aria-labelledby="four">Go</button>
<input type=PASSWORD aria-label="Upper" id=upper>
<input type=password id=short><button aria-labelledby="short">Go</button>`;

// Field id -> the value the field holds, in document order.
export const PASSWORD_FILLS: [string, string][] = [
  ["plain", "s3cret-typed"],
  // Needs YAML quotes and escapes.
  ["quoted", '-a\\b"c'],
  // Playwright removes U+200B and U+00AD, trims and collapses whitespace.
  ["spaces", "  two   spaces\tand\u200btab\u00ad "],
  // Rendered as a child line under the placeholder prop.
  ["hint", "placeholder-secret"],
  // The next three also become the accessible name of a button.
  ["named", "labelled-secret"],
  // The key needs single quotes, so ' is doubled in the name.
  ["colon", "it's: open"],
  ["escaped", 'back\\slash"q'],
  // Short: page text "Step 3 of 4" and "Page 3" must survive.
  ["pin", "3"],
  // The shortest value that is masked inside another node's name.
  ["four", "abcd"],
  ["upper", "upper-secret"],
  ["short", "xyz"],
];

export const PASSWORD_VALUES = PASSWORD_FILLS.map(([, value]) => value);

export const PASSWORD_SNAPSHOT = [
  "- text: Password",
  '- textbox "Password": s3cret-typed',
  '- textbox "Quoted": "-a\\\\b\\"c"',
  '- textbox "Spaces": two spaces andtab',
  '- textbox "Hint":',
  "  - /placeholder: Enter it",
  "  - text: placeholder-secret",
  "- textbox: labelled-secret",
  '- button "labelled-secret": Go',
  '- textbox: "it\'s: open"',
  "- 'button \"it''s: open\"': Go",
  '- textbox: back\\slash"q',
  '- button "back\\\\slash\\"q": Go',
  '- textbox "PIN": "3"',
  "- paragraph: Step 3 of 4",
  '- link "Page 3":',
  '  - /url: "#"',
  "- textbox: abcd",
  '- button "abcd": Go',
  '- textbox "Upper": upper-secret',
  "- textbox: xyz",
  '- button "xyz": Go',
].join("\n");

// Strings that must not appear in a masked read: every rendered form of each
// value of four or more characters (a shorter one is masked only as a whole
// line value, see the design comment in browser-frames.ts).
export const PASSWORD_LEAKS = [
  "s3cret-typed",
  "-a\\b",
  "-a\\\\b",
  "two spaces",
  "andtab",
  "placeholder-secret",
  "labelled-secret",
  "it's",
  "it''s",
  "slash",
  "abcd",
  "upper-secret",
];

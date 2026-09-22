import type { BrowserFailure } from "./browser-actions";

// Match only known Playwright parser diagnostics on the first line. Never
// return any part of the error: selector text can contain private page data.
export function selectorSyntaxFailure(
  error: unknown,
): BrowserFailure | undefined {
  if (!(error instanceof Error) || error.name === "TimeoutError") return;
  const first = error.message.split("\n", 1)[0];
  const parsed =
    /^(?:(?:page|locator)\.)?(?:click|fill|press|setInputFiles|innerText|ariaSnapshot): (.*)$/.exec(
      first,
    );
  if (!parsed) return;
  const message = parsed[1];
  let hint: string;
  if (/^Error: Unknown attribute "[^"\n]+", must be one of /.test(message)) {
    hint =
      'Unsupported role selector attribute. Use role=button[name="Post"] for a name or role=button[name=/^Post$/] for an exact name; [exact=true] is not supported.';
  } else if (
    /^Unexpected token .* while parsing (?:css )?selector /.test(message) ||
    /^InvalidSelectorError: (?:Unexpected end of selector|Error while parsing selector|Unexpected symbol)/.test(
      message,
    ) ||
    /^Unknown engine "/.test(message)
  ) {
    hint =
      "Invalid selector syntax. Use a CSS selector or a Playwright role selector such as role=dialog >> role=button[name=/^Post$/]. ARIA snapshot roles are not CSS role attributes.";
  } else return;
  return { ok: false, status: 400, code: "invalid_request", error: hint };
}

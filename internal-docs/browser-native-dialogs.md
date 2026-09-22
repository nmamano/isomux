# Native Chrome dialogs

Measured 2026-09-22 on Google Chrome 151.0.7922.137, Linux, under Xvfb.
These results do not establish Windows native-UI behavior.

## File chooser

A fresh headed Chrome profile reproduced the reported failure: clicking a file
input opened an OS chooser. Playwright setInputFiles delivered the fake file and
the page displayed its name, but the native chooser stayed open. A desktop
screenshot and xwininfo showed the chooser after the attachment.

Page.setInterceptFileChooserDialog with enabled=true prevents a new chooser,
provided Page.enable has run on that CDP session. A probe without Page.enable
still opened the chooser. The extension enables both before it publishes control
of an offered root or popup. It also enables interception after Page.enable on
owned child sessions, before Playwright resumes them. Debugger detach releases
interception. Existing native dialogs are not closed by this change.

The integration test uses the actual extension and bridge with a fresh Chrome
profile. An unoffered tab supplies the positive native-window control: attachment
alone leaves an Open File window while the other tab is offered. The test checks roots, popups, child frames,
attachment delivery, an unoffered tab and native behavior after release.
xwininfo observes OS windows independently of page upload results.

Run alone on a new display:

```sh
ISOMUX_TEST_BROWSER_DIALOGS=1 xvfb-run -a -s "-screen 0 1280x900x24" bun test server/browser-extension-dialogs.live.test.ts
```

Use the normal memory scope and gate-log wrapper. The native-window assertion
uses the English Linux chooser title. It is a platform-specific integration
test, not a portable Windows assertion.

## Save-password prompt: blocked

A separate fresh headed profile submitted a fake username and password to a
loopback form. Desktop images showed Chrome's Save password prompt after form
submission and after a subsequent page click. These images include browser
chrome; page screenshots alone cannot establish this result.

Reproduce and capture the native desktop:

```sh
xvfb-run -a -s "-screen 0 1280x900x24" bun scripts/browser-password-prompt-probe.ts
```

The script prints its temporary evidence directory. It retains only its isolated
profile and screenshots. It does not use real accounts or read saved passwords.
The script also writes stages.png, a lossless side-by-side view of the three
original desktop captures, in submitted, page-click, JavaScript-handler order.
Use it when a viewer displays successive screenshots as differences. Inspect
each image; the script does not assert that a native password prompt is
present or closed.

The published CDP schema and extension debugger API expose no save-password
bubble dismissal operation found in this investigation. Page.handleJavaScriptDialog
handles JavaScript alerts, confirms, prompts and beforeunload dialogs, not this
browser UI. The fake-login probe received a rejection from that command; a
desktop capture still showed the prompt. Chromium's password controller hides its bubble when WebContents
visibility changes to HIDDEN, but changing active tabs or windows would alter
desktop state. Global password-manager preferences and blind desktop input are
outside the approved scope. No password-prompt workaround ships.

Sources checked 2026-09-22:

- [Page protocol](https://chromedevtools.github.io/devtools-protocol/tot/Page/)
- [Extension debugger domains](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [CDP schema](https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/browser_protocol.json)
- [Chromium password controller](https://chromium.googlesource.com/chromium/src/+/4a8573cb240df29b0e4d9820303538fb28e31d84/chrome/browser/ui/passwords/manage_passwords_ui_controller.cc)

Remaining validation: Windows native UI, including the reported Chrome/LinkedIn
path in a safe fake fixture. Remaining feature blocker: no supported,
prompt-specific password-bubble API found within the approved constraints.

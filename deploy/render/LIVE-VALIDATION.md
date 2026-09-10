# Live Render validation

Date: 2026-09-09. Tested application commit: b70686573c6ae8a4a6d22fb70b312620031432c8.

The private test repository deployed as a Docker web service in Nil's Render
workspace, in Oregon, on Pro compute with a 20 GB persistent disk at /var/data.
The service is srv-dags8m0u01pc73f1abp0. All test data is synthetic.

Passed: Docker build on Render, HTTPS, protected first-owner setup, secure
session cookie, authenticated office API, custom office and wildcard domains,
generated-app registration and authenticated HTTPS access, persistent app boot
counter increasing from 1 to 2 after a Render CLI restart, office session
survival, app stop, authenticated WebSocket echo, and app deletion.

The smoke app remains registered and stopped. The WebSocket test app was deleted.
The WebSocket driver first expected 200 for deletion; the API correctly returned 204. After correcting the driver, its complete run passed.

## DNS

For the test zone nilmamano.com, all four records are CNAMEs:

| Host                             | Target                                    |
| -------------------------------- | ----------------------------------------- |
| render-test                      | isomux-render-test.onrender.com           |
| \*.render-test                   | isomux-render-test.onrender.com           |
| \_acme-challenge.render-test     | isomux-render-test.verify.renderdns.com   |
| \_cf-custom-hostname.render-test | isomux-render-test.hostname.renderdns.com |

Use the validation targets Render supplies for the specific service. Do not
construct them from its srv- identifier: that produced wrong targets during
this test. Both domains are verified and HTTPS handshakes pass after correction.

## Remaining checks

A follow-up live agent test passed using OpenCode opencode/mimo-v2.5-free,
which the live model catalog reported as free. The Render App Builder agent
created and registered demo-checklist under /var/data/workspaces/demo-checklist.
Chrome on the test driver opened its authenticated HTTPS address; real mouse
clicks added and completed a task, and its state survived a page reload.
Paid-provider authentication and Chromium execution inside Render remain untested. Hard per-app CPU and memory isolation
remains a prototype limitation. This test does not establish PHI suitability.

The CLI validates Blueprints but does not create them. This service was created
with the Render REST API using the Blueprint's settings; subsequent deploys,
logs, and restarts used the CLI. Dashboard Blueprint creation was subsequently tested; see the next section.

## Fresh Blueprint installation (2026-09-10 Europe/Berlin)

Nil created isomux-clean-install through New > Blueprint, using main and the
root render.yaml. Render sync exe-dagtccmk1f9s73dscfjg succeeded and created
service srv-dagtco1t0dsc73fnoa5g and a separate disk dsk-dagtco1t0dsc73fnoap0.
No state was copied from the first service. The setup form and empty apps list
confirmed the new office was unclaimed and empty.

The actual Chrome setup form exposed a defect missed by API-only tests:
Referrer-Policy: no-referrer caused the same-origin POST to fail with Bad origin.
Commit ab30cedac8a11dfce3b11b00779b85f5bd846106 changes this to same-origin.
The fix was deployed to the still-unclaimed Blueprint service. A real mouse
submission then created its owner successfully. The setup unit test (8 assertions)
and scoped ESLint passed. This was a Blueprint-created service plus one code-fix
deploy, not a second untouched Blueprint provisioning run after the fix.

The fresh office passed authenticated app HTTPS and WebSocket echo/deletion.
An OpenCode MiMo request produced no output before cancellation. Switching the
agent to the catalog's free opencode/big-pickle model produced and registered
Demo Checklist. Chrome real mouse events added Verify Blueprint install and
marked it complete. Reload preserved the completion. After a Render CLI restart,
the original owner session signed into the app again and its saved completion
remained checked. The generated app and agent remain in the fresh office.

The approved test domains now belong to this Blueprint service. Their four DNS
targets are isomux.onrender.com (office and wildcard), isomux.verify.renderdns.com,
and isomux.hostname.renderdns.com. The earlier service remains allocated with
its own disk; its former custom-domain routing has moved to the fresh service.

Paid model-provider authentication, PHI suitability, and Chromium running inside
the Render container are not established by these checks. The driving Chrome
browser ran on auntie.

# Chromium sandbox profile

Verified on EC2 Ubuntu 24.04 with Docker 29.1.3
on 2026-09-21 using image revision `b4b7a5f1`.

`docker-default.json` is the unmodified Moby profile at commit
`245180c51918481c0525424b3ee025d2b435d46c`:
https://github.com/moby/profiles/blob/245180c51918481c0525424b3ee025d2b435d46c/seccomp/default.json

Its SHA-256 is `785b2429264afba4d594320337cb17f144f3c7d51585f9805eef72e28f4f9334`.
The upstream Apache 2.0 license is included in `LICENSE`.

`chromium.json` has exactly one added rule: allow `clone`, `setns`, and `unshare`.
This is the namespace allowance documented by
[Playwright](https://playwright.dev/docs/docker#crawling-and-scraping) for a
non-root Chromium sandbox. Other rules and the default deny action are unchanged.
The profile grants no Linux capabilities and does not disable AppArmor.

Every process in the office container gets these namespace calls. The browser
uses them for its inner sandbox. The profile replaces Docker's built-in profile;
review upstream security changes when updating this pinned copy. The structural
test checks its exact basis and delta; it does not prove host compatibility.

`native-check.ts` requires UID 1000 and checks Chromium's `chrome://sandbox`
report for PID/network namespaces and Seccomp-BPF before exercising the
production screenshot path. `smoke.py` and `compose-check.py` use this profile
without additional capabilities. The EC2 check kept Docker's default AppArmor
profile and passed the sandbox report and production preview checks. Render
and Fargate support remain unverified. If a host also blocks user namespaces
through AppArmor or kernel policy, stop; do not disable the browser sandbox or
host policy.

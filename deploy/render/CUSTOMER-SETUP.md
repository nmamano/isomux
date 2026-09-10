# Deploy a customer office

Deploy from the `main` branch of https://github.com/nmamano/isomux. Create the
Blueprint in the intended Render workspace at
https://dashboard.render.com/blueprints and follow
[Deploy on Render](../../docs/self-hosted.md#deploy-on-render).

Connect the model provider in the office under Settings → Office →
Office-wide connections, then check that app subdomains work by asking an
agent to build a small app.

The test office's free OpenCode models were used only with synthetic data. A
customer's protected-data deployment needs its own approved provider connection
and application data-handling review. This document is an installation guide,
not a HIPAA certification.

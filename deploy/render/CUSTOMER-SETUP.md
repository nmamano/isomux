# Deploy a customer office

Use the latest main revision containing the browser setup fix (ab30ced or later).
The repository is public. Customers can deploy it without a GitHub repository
invitation. Sign in to Render to create the Blueprint in the intended workspace.

1. In the intended Render workspace, select New > Blueprint and connect this
   repository. Choose main and render.yaml. Give the Blueprint a name.
2. Set ISOMUX_PUBLIC_URL to the final HTTPS office origin, for example
   https://office.example.com. Review the Pro service and 20 GB disk, then deploy.
3. Add office.example.com and *.office.example.com to that service's custom
   domains. Configure the office and wildcard CNAMEs to the assigned onrender.com
   hostname. Copy Render's two validation CNAME targets exactly; do not derive
   them from the srv- service ID. Verify both domains and wait for HTTPS.
4. Find ISOMUX_SETUP_KEY in the service's environment settings. Open the office
   domain and enter the key and first owner's name. Keep the key out of messages
   and logs. Once claimed, the setup form no longer creates owners.
5. Connect the intended model provider through the office's supported provider
   flow. Create an agent and ask it to build a small app using synthetic data.
   Confirm the app opens, saves a change, and retains it after a service restart.

The test office's free OpenCode models were used only with synthetic data. A
customer's protected-data deployment needs its own approved provider connection
and application data-handling review. This document is an installation guide,
not a HIPAA certification.

Persistent projects belong under /var/data/workspaces. Office and app state live
under /var/data/home. Service restarts interrupt active turns and requests.

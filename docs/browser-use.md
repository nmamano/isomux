---
description: Let agents use a tab in your desktop Chrome. Install and pair the Isomux Browser extension, offer a tab, unpair a browser and update the extension.
---

# Browser use

Agents can open pages, click and fill forms in a desktop Chrome tab that you offer them, with your logins.

## Install and pair

In **Integrations → Browser Use**, download the extension and follow the steps there to load it in Chrome. Then create a pairing code there, open the extension and enter the office address and the code. A code expires after five minutes. Each member pairs their own browsers, with one code for each computer. Agents use the browsers of their manager, also when another member speaks in the chat.

Chrome warns **Read your browsing history**. The extension uses this permission to bind site-opened popups to the agent's tab. It does not collect browsing history. Chrome also shows its own debugger warning during control.

## Offer a tab

Open an HTTP(S) tab, choose **All** (the default) or one agent in the extension popup, and turn on **Agent control**. An agent can have one tab of its own, and you can offer any number of tabs to All. Before you offer a tab, choose when control expires: **Never** (the default), **15 minutes**, **1 hour** or **4 hours**. Agent actions do not extend it. The **ON** badge marks offered tabs and the popups that their sites open. When you turn off control, the pages stay open.

## Unpair a browser

The popup can disconnect or unpair. To revoke a browser that is offline, unpair it in Integrations → Browser Use. When you pair a Chrome again, it is a new browser: unpair its old entry there.

## Update

Update the server and the extension together: the server refuses an extension with an older protocol. Integrations → Browser Use shows the steps when an update is ready. A reload of the extension releases the offers, so offer the tabs again.

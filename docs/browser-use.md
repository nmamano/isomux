---
description: Let agents use a tab in your desktop Chrome. Install and pair the Isomux Browser extension, offer a tab or let agents open their own, unpair a browser and update the extension.
---

# Browser use

Agents can open pages, click and fill forms in a desktop Chrome tab that you offer them, with your logins.

## Install and pair

In **Integrations → Browser Use**, download the extension and follow the steps there to load it in Chrome. Then create a pairing code there, open the extension and enter the office address and the code. A code expires after five minutes. Each member pairs their own browsers, with one code for each computer. Agents use the browsers of their manager, also when another member speaks in the chat, and the browsers of other members who let them in.

Chrome warns **Read your browsing history**. The extension uses this permission to bind site-opened popups to the agent's tab. It does not collect browsing history. Chrome also shows its own debugger warning during control.

## Offer a tab

Open an HTTP(S) tab and turn on **Use this tab** in the extension popup. **Agents** in the popup chooses who may use your offered tabs and open their own: **My agents** (the default), **My agents and members I pick**, or **All agents**, which adds the agents of every member in the rooms you can access. The agents of other members act as you in the tab. A change applies at once, also to the tabs you already offered. The **ON** badge marks offered tabs and the popups that their sites open. When you turn off control, the pages stay open.

## Let agents open tabs

In the extension popup, turn on **Open their own tabs**. The agents that **Agents** chooses then open their own tabs in a separate Agents window when they need one, without asking you to offer a tab. The popup lists the open agent tabs, with **Show tab** and **Close tab**. When you turn the switch off, agents lose control of their tabs, and the tabs stay open.

## Unpair a browser

The popup can disconnect or unpair. To revoke a browser that is offline, unpair it in Integrations → Browser Use. When you pair a Chrome again, it is a new browser: unpair its old entry there.

## Update

Update the server and the extension together: the server refuses an extension with an older protocol. Integrations → Browser Use shows the steps when an update is ready. A reload of the extension ends agent control of every tab, so offer the tabs again.

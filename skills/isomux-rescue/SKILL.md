---
name: isomux-rescue
description: Help when the office misbehaves, may be under attack, or a member needs its content out - check it, export it, lock it, and say what needs the office's machine. Use when a message starts with /isomux-rescue.
---

# Rescue

The member thinks something is wrong with the office. Find out what, and do the part you can. The `rescue` reference page has the routes.

1. Check what works and what does not. Tell the member what you found in a few lines.
2. Read what the member needs through the usual routes, with your own access.
3. Export: when your manager is an office owner, start an export and give the owner the download link. You cannot download it: only an owner signed in to the office in a browser can.
4. Lock: when the office may be under attack and your manager is an office owner, first ask the member for the reason and a clear yes, and tell them what follows: everyone is signed out, every agent ends, you included, and the office stops or shows only a locked page until someone runs `unlock` on the office's machine. Owners then sign in again with the owner sign-in recovery. Then call the lockdown route.
5. Some steps need the office's machine: restart, unlock, rollback, the incident report, and a lock that the office's own user cannot remove. Give the member the command from "Locking the office down" in the hosting reference: `sudo isomux-rescue <command>` on an install made by the installer, `bun run rescue <command>` in the checkout otherwise. On Hosted Isomux with SSH off, turn SSH on in the dashboard first.

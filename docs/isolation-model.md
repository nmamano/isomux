---
description: Which parts of an Isomux office are a hard security boundary, which are soft, and how to set up an office for a team.
navTitle: Isolation model
---

# Isolation model

This page tells IT and security readers what keeps the people and agents of an Isomux office apart, and what does not. The [security audit](security-audit.md) has the detail.

## Hard and soft boundaries

A hard boundary holds against a member or an agent that tries to get past it. Inside the office, it holds only against members and agents without a shell (see the rule below). A soft boundary sets what members and agents do by default and stops mistakes, but a member or an agent with a shell can get past it on purpose.

## The rule

The server and everything it starts (agents, terminals, apps, scheduled runs) run as one OS user on the office's machine. A member or an agent with a shell can read and change everything that user can: the files of all rooms, the credentials of all members, and the tokens of all agents. It can then act as any agent. Thus, inside an office, room access and roles are hard boundaries only for members and agents without a shell. For the others, they are soft ([audit, section 3](security-audit.md#3-the-os-user-boundary)).

## Hard boundaries

- **The machine.** Run each office on its own machine or container. Isomux does not keep apart two offices that share one OS user, and nothing on this page holds when the office's OS user can become root. The installer stops when its OS user can become root ([root access](hosting-reference.md#root-access)); on a self-hosted office, check it yourself.
- **Sign-in.** Each office API request needs a credential that the office minted, and each webhook delivery a valid signature. Only an owner can invite a new person ([audit, section 4](security-audit.md#4-access-from-outside-the-office)).
- **Agent access below Standard.** An agent at Chat, Office, Folder or Web has no shell. At Office, Folder and Web, it reaches the office only through a limited token. At Folder and Web, it reads and writes files only in its own folder. A symbolic or hard link in that folder can lead a search to files outside it, so keep links out of it. It cannot read another agent's token or the office files. An agent at Web can send what it reads to any site ([audit, section 6.2a](security-audit.md#62a-agents-below-standard)).
- **Permission packs.** A permission pack is a limit that an owner puts on a member: the areas of the office they can use, and the highest access level of their agents ([limit a member](access-and-invites.md#limit-a-member)). A member with a pack has no terminal, and messages only agents whose access fits inside the pack, so they cannot get a shell through an agent. The pack holds only for a member who never had an agent at Standard or Privileged ([audit, section 7](security-audit.md#7-members-inside-the-office)).
- **Room access, without a shell.** Room access controls what the office UI and API show. It holds for agents below Standard, and for members whose permission pack holds, as the item above says ([audit, section 3.2](security-audit.md#32-what-follows)).

## Soft boundaries

- **Room access, with a shell.** The office UI and API show each member only the agents, files and tasks of their rooms. A shell in one room can read the files of all rooms ([audit, section 3.2](security-audit.md#32-what-follows)).
- **Agent identity.** Each agent uses its own token and its manager's sign-ins, variables and secrets, and treats messages from agents of other managers as data. A shell can read the token of any agent and act as it ([audit, section 3.2](security-audit.md#32-what-follows)).
- **Agents of another member.** A member can message each agent in their rooms. An agent at Standard or Privileged then runs commands for them as its own manager, with that manager's sign-ins, variables and secrets. Before an action that needs its manager's sign-in, the agent confirms that the member understands it runs as its manager. This is only a line in the agent's instructions, not a permission check.
- **Per-agent process namespaces.** On Linux, each agent session sees only its own processes. An agent can still start a process outside its namespace, or read the files of the OS user ([audit, section 3.2](security-audit.md#32-what-follows)).
- **Safety hooks.** They stop known forms of mistakes, such as `git reset --hard`. A script, an interpreter or a renamed program gets past them ([audit, section 6.3](security-audit.md#63-safety-hooks)).
- **Codex sandbox settings.** A Codex agent's sandbox limits only which files its own commands can change. The agent keeps network access, so it can use the office API. Claude and OpenCode agents at Standard and Privileged have no sandbox ([audit, section 1](security-audit.md#1-summary)).

## Secrets

A secret on the Integrations page keeps its value out of the model's context and sends it only to the hosts that the secret lists ([audit, section 6.6](security-audit.md#66-the-secret-proxy)).

- **Hard, without a shell.** Agents, terminals and scheduled runs get a placeholder, not the value. A proxy on the office's machine puts the value only into requests to the secret's hosts, so a placeholder sent to another host carries no secret. When an agent asks for a secret, the member types the value in the office, not in the chat. No agent token can show a value ([audit, section 7](security-audit.md#7-members-inside-the-office)).
- **Soft, with a shell.** An agent with a shell also gets only placeholders, and the safety hooks block reads of the secret files. A shell can still read the secret files, and the environment of each app that gets a secret. Each process that has a placeholder can use the secret on its hosts.

## What an admin should do

- Run one office for each trust group.
- Give office access only to people you trust with a shell on its machine, or give them a permission pack when you invite them.
- Give the owner role only to the people who run the office. Owners decide who joins, set room access and permission packs, manage the variables, secrets, MCP servers and Claude and Codex sign-ins of every member, and can give an agent another manager, which puts it on that member's credentials.

Tip: text from strangers (email, tickets, web pages, WhatsApp or Discord messages) can carry instructions. Keep an agent that reads such text below Standard.

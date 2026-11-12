---
description: Which parts of an Isomux office are a security boundary, which are not, and how to set up an office for a team.
navTitle: Isolation model
---

# Isolation model

This page tells IT and security readers what keeps the people and agents of an Isomux office apart, and what does not. The [security audit](security-audit.md) has the detail.

## The rule

The server and everything it starts (agents, terminals, apps, scheduled runs) run as one OS user on the office's machine. A member or an agent with a shell can read and change everything that user can: the files of all rooms, the credentials of all members, and the tokens of all agents. It can then act as any agent. Thus, inside an office, room access and roles limit only members and agents without a shell ([audit, section 3](security-audit.md#3-the-os-user-boundary)).

## What is a boundary

- **The machine.** Run each office on its own machine or container. Isomux does not keep apart two offices that share one OS user, and nothing on this page holds when the office's OS user can become root. The installer checks this ([root access](hosting-reference.md#root-access)); on a self-hosted office, check it yourself.
- **Sign-in.** Each office API request needs a credential that the office minted, and each webhook delivery a valid signature. Only an owner can invite a new person ([audit, section 4](security-audit.md#4-access-from-outside-the-office)).
- **Agent access below Standard.** An agent at Chat, Office, Folder or Web has no shell. At Office, Folder and Web, it reaches the office only through a limited token. At Folder and Web, it reads and writes files only in its own folder; keep links out of that folder. It cannot read another agent's token or the office files. An agent at Web can send what it reads to any site ([audit, section 6.2a](security-audit.md#62a-agents-below-standard)).
- **Room access, without a shell.** Room access controls what the office UI and API show. It holds for agents below Standard, and for members with a [permission pack](access-and-invites.md#limit-a-member) who never had an agent at Standard or Privileged. A shell in one room can read the files of all rooms ([audit, section 3.2](security-audit.md#32-what-follows)).

## What is not a boundary

- **Per-agent process namespaces.** On Linux, each agent session sees only its own processes. An agent can still start a process outside its namespace, or read the files of the OS user ([audit, section 3.2](security-audit.md#32-what-follows)).
- **Safety hooks.** They stop known forms of mistakes, such as `git reset --hard`. A script, an interpreter or a renamed program gets past them ([audit, section 6.3](security-audit.md#63-safety-hooks)).
- **Codex sandbox settings.** A Codex agent's sandbox limits only which files its own commands can change. The agent keeps network access, so it can use the office API. Claude and OpenCode agents at Standard and Privileged have no sandbox ([audit, section 1](security-audit.md#1-summary)).

## What an admin should do

- Run one office for each trust group.
- Give office access only to people you trust with a shell on its machine, or give them a permission pack when you invite them.
- Keep each agent that reads text from strangers (email, tickets, web pages, WhatsApp or Discord messages) below Standard. That text can carry instructions.
- Give the owner role only to the people who run the office. Owners decide who joins, set room access and permission packs, manage the variables, secrets and MCP servers of every member, and can give an agent another manager, which puts it on that member's credentials.

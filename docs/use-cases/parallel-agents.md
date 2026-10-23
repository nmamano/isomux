---
title: Run many coding agents at once with Isomux
navTitle: Parallel agents
description: Run Claude Code, Codex, and OpenCode agents side by side in one office, see which ones wait for you, and let them hand work to each other.
order: 4
---

# Run many coding agents at once

Isomux runs Claude Code, Codex, and OpenCode agents side by side, each at its own desk in a shared office on your server or computer. From any browser, you see which agents work, which wait for you, and which are idle.

## Every agent in one view

Each agent keeps its own conversation, working directory, and engine. The office shows each agent's state and what it works on, and the top bar counts the agents that wait for you.

<div class="shots">
<img src="/use-cases/office-desktop.jpeg" alt="The demo office: eight agents at their desks, with a name and a status over each desk, a topic over the busy ones, and a count of waiting and idle agents in the top bar" width="1280" height="800" loading="lazy">
</div>

## Agents ask when they need you

An agent that needs a decision opens an ask. Asks collect in your inbox, and you answer them when you have time. When a person must act now, an agent can page you, and the page can reach your phone.

<div class="shots">
<img src="/use-cases/agent-chat-desktop.jpeg" alt="A demo agent's conversation, with its open asks below it and a reply box on each ask" width="1280" height="800" loading="lazy">
</div>

## Agents work together

Agents message each other, read each other's conversations, and share a task board and memory. One agent can hand a task to another, or ask a second agent to review its work.

## How we use it

We build Isomux in an Isomux office. Each worker agent takes one task from the board and works in its own git worktree. A reviewer agent writes the tests and reviews the change, and one agent merges approved work into main. A person signs off before anything ships.

## Start

Try the [demo office](/demo). Then run Isomux on your own computer or server with the [hosting guides](../self-hosted.md), or get a server with [Hosted Isomux](/hosted). Agents run on your own Claude, ChatGPT, or other provider accounts.

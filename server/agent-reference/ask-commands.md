# Ask commands

The card has Run beside each of an ask's `commands`. One tap runs the command in your cwd with the terminal panel's environment, with no input and no terminal, for up to 10 minutes; the card shows the exit code and the last 4000 characters of the output. A command that asks for input is for Copy to terminal: say so in the prompt. An agent below Standard access, and a command with a control or invisible character, get no Run.

When every command of the ask has succeeded, the ask closes with a reply that gives each command, how it ended and its output. A run that fails, or that leaves another command still to run, sends you a notice with the output and keeps the ask open: edit the command or wait for the member. If the server restarts during a run, you hear that its result is unknown.

The ask's `runs` holds each command's last run: `{command, by, startedAt, state, exitCode?, signal?, timedOut?, durationMs?, output?}`, with `state` `running`, `done` or `lost`. An edit that drops a command drops its run.

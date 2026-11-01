# sound-notify

A Claude Code mod that plays a sound when Claude needs you:

- **done** (`sounds/done.wav`, a rising two-note chime): the main turn has ended — answered, refused or stopped by an API error. Not when you interrupt it yourself, and not when a subagent finishes.
- **waiting** (`sounds/waiting.wav`, a short double beep): Claude stopped to wait for you — a permission dialog, a question (AskUserQuestion), plan approval (ExitPlanMode), an MCP form or URL request, or a background agent needing input. Waits less than 1.5 s apart ring once.

It plays the files with the operating system's own player: PowerShell (`System.Media.SoundPlayer`) on Windows; `paplay`, `pw-play` or `aplay` on Linux, tried in that order; on WSL, Windows' PowerShell as a last resort. When none works it shows one toast saying so.

Run `/sound-notify-test` to play both sounds once and see which player was used.

## Install

At the prompt of a terminal session:

```
/plugin install sound-notify --marketplace cabos-Bit/sound-notify
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install sound-notify --marketplace cabos-Bit/sound-notify
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `cabos-Bit/sound-notify`, then Add plugin.

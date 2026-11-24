# Workflow transcript

Text alternative to the [GIF](../../website/assets/workflow.gif) and
[video](../../website/assets/workflow.mp4). These commands and outputs come from
the [ADG 1.0.2 capture](capture.json), using superpowers 7.0.2 at the fixed
revision shown below. Temporary paths are replaced with `<DEMO>`.
The replay condenses waits; this transcript preserves its captured stdout.

## Add one skill

```text
$ adg plugins add obra/superpowers --ref 22f0b463e7a5e579904dd6211a520321035526f7 --only skills --skill brainstorming --target codex --project
converted native manifest -> .agents/.plugin.json: superpowers
added superpowers -> <DEMO>/project/.agents/plugins/obra__superpowers/superpowers
enabled in Codex: superpowers
```

## Connect Claude Code

```text
$ adg plugins link --target claude --project
linked superpowers [claude] -> Claude Code
  adapted: <DEMO>/project/.agents/plugins/obra__superpowers/superpowers/.claude-plugin/plugin.json
```

## Check Codex registration

```text
$ adg plugins status --target codex --project
Codex
  in sync (1): superpowers
note: name-level only; content drift isn't shown — run `adg plugins sync` if unsure.
```

## Check Claude Code registration

```text
$ adg plugins status --target claude --project
Claude Code
  in sync (1): superpowers
note: name-level only; content drift isn't shown — run `adg plugins sync` if unsure.
```

## What the output confirms

Both native plugin registrations were enabled. Status compares registered
plugin names, not content drift. This capture does not show model execution or
interactive skill discovery in a new session. Antigravity was not part of it.

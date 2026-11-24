# English publication drafts

Owner: rbbtsn0w. Status: unpublished. Use the matching attachment and check the
[publication checklist](README.md#publication-checklist) before posting. Each
numbered item below is one X post; headings and attachment notes are not part of
the post. The drafts use the author's first-person voice without invented
personal history. Publish only the language appropriate to the audience.

## D1 — Real workflow

Attachment: [workflow MP4](../../website/assets/workflow.mp4).

```text
I’m building ADG to manage plugins and skills across Codex and Claude Code from one source inventory.

Here’s a real 10-second CLI replay: add one skill, connect the second agent, check both.

Try one project: https://adg.rbbtsn0w.me/
```

## D4 — Existing source, one skill

Attachment: [static walkthrough](../../website/assets/workflow-poster.png).

```text
Already using superpowers? ADG can import its existing plugin manifest.

Pick one skill, then connect the agents you use. I’ve put the project-scoped commands here:

https://github.com/RbBtSn0w/adg#install-and-quick-start
```

## D8 — State you can inspect

Attachment: [social image](../../website/assets/social-preview.png).

```text
ADG’s lock records source, version and content hashes.

Its status command checks native plugin registration. It doesn’t verify skill execution or content drift.

The real workflow and its boundaries: https://adg.rbbtsn0w.me/#workflow
```

## D12 — First-try invitation

Attachment: optional MP4; one primary action, the issue link.

```text
I’m looking for 5 developers using Codex + Claude Code to try ADG in one project.

Add a skill, connect both agents, check status, then open a new session. Please share versions and sanitized results:

https://github.com/RbBtSn0w/adg/issues
```

## Community discussion outline

This is an outline for an author-written contribution, not a publish-ready
Reddit post. For a community that restricts LLM-generated posts, write the
actual post yourself. Verify relevance and rules before choosing the channel;
do not describe ADG as a local-model integration without real evidence.

Possible title: **Managing the same plugin sources across Codex and Claude Code**

- Disclose: "I maintain ADG, an MIT-licensed TypeScript CLI."
- Describe a specific source-management problem you have personally observed;
  add only a true example. Do not claim "everyone keeps asking for this."
- Show the actual capture: superpowers' existing manifest, one selected skill,
  project scope, Codex registration, Claude connection and both status checks.
- Explain the boundary: it manages plugins and skills, not models or inference.
  Native caches and registries still exist; name-level status is not execution.
- Point to the quick start and the telemetry disclosure, including opt-out.
- Ask a concrete question about the community's current workflow: which agent
  pair and source layout create repeated maintenance, and what would constitute
  a useful first try? Include the repository link only as the channel permits.
- Disclose translation/refinement assistance where the community requires it.

## Reply notes

Use actual versioned evidence when answering. Do not promise a successful setup
on a runtime not tested in that conversation.

- **Scope:** all commands should consistently use project or global scope.
  Native agent tools also maintain their own configuration and caches.
- **Compatibility:** point to the [runtime specification](../agents-spec.md).
- **Existing sources:** native Claude/Codex manifests can be imported; standard
  structural layouts and multi-plugin repositories have distinct requirements.
- **Updates:** point to the [recovery guide](../plugin-upgrade-migrations.md),
  and ask for targeted status before suggesting changes.
- **Telemetry:** anonymous command data is on by default. Link the disclosure
  and the documented `DO_NOT_TRACK=1` opt-out.
- **First-try reports:** request versions, OS, scope, sanitized command and
  observed result. Record registration and new-session discovery separately.

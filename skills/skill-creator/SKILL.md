---
name: skill-creator
description: How to write, lay out and test a new skill in skills/, and how to fix an existing one. Use when a procedure you just worked out is worth keeping, or when a skill you followed turned out to be wrong or incomplete.
---

# Writing a skill

A skill turns something you had to work out once into something you never work out again. The catalog in your prompt shows only each skill's frontmatter; the rest of the directory costs nothing until you open it.

## When a procedure is worth a skill

Write one when all three hold:

- It is mechanical and multi-step — the same commands, in the same order, every time.
- You would otherwise rediscover it: which source works, which flag is needed, which approach fails.
- It will come back. A one-off request is not a skill.

Do not write a skill for something you already do well in a single step, and do not write one that only restates a tool description you already have.

## Layout

```
skills/<skill-name>/
    SKILL.md          required — frontmatter + the procedure
    REFERENCE.md      optional — the rare, deeper cases
    scripts/          optional — code the skill runs
    assets/           optional — templates, fixtures, anything else
```

- The directory name is the skill name. Use lowercase words joined by hyphens, naming the job (`tiktok-video`), not the tool.
- One skill per directory. If two jobs share only a helper, give each its own skill.
- Everything the skill needs lives inside its own directory. Never depend on a file in `workspace/`: that is per-chat and gets wiped.

## Frontmatter

This is the only part that goes into every prompt on every turn, in every chat. Keep it short and make it earn its place.

```yaml
---
name: <the directory name, exactly>
description: <what it does, then when to use it>
---
```

- Two fields, nothing else. Plain `key: value` lines, no lists, no nesting.
- `description` is one sentence on what the skill does, plus one on when it applies — that second half is what makes you reach for it at the right moment. Write the trigger as the moment you need the result ("when you need to watch a TikTok"), never as a pattern that merely appears somewhere ("whenever a TikTok link shows up"): the second kind fires on a link scrolled past in the history.
- Aim for two lines. Long descriptions are truncated, and a vague one is worse than none: it either never fires or fires on everything.
- No secrets, no chat-specific detail, no user names.

## Writing SKILL.md

The body is for you, mid-task, with the user waiting. Write it as instructions, not as an essay.

- Open with the goal in one line: what you have when the skill is done.
- Then the fast path — the shortest sequence that reaches that goal — as numbered steps with the exact command or tool call. State how many rounds it should take.
- State the decisions you already made and why, so you do not relitigate them: which source to try first, which approach not to bother with, what not to save.
- Then failure handling: how to tell the failures apart, what to do for each, and when to stop instead of looping.
- Link every file of the skill that a step needs, by its full path: `skills/<name>/scripts/<file>`. An unlinked file is a file you will not find.
- Keep the common case in SKILL.md. Push the rare, heavier case into `REFERENCE.md` and link it from one line saying when to open it — reading it costs a round, so it must be worth one.

## Scripts

Put code in a script instead of writing it out in the body. A script you call is one tool call; code you retype is a round of writing plus a round of fixing.

- Give it a real command-line interface with defaults, so the body only lists the arguments that change.
- Have it print one machine-readable result line and exit non-zero on failure, so you can tell success from failure without re-reading anything.
- Make its output path deterministic and pass it in. A predictable path is what lets you call `read_file` on the result in the same round as the command that produced it.
- Nothing is executable and nothing gets installed: call the interpreter directly (`python3 /skills/<name>/scripts/<file>.py`), and use only what the container already has.

## Before you finish

1. Run the script end to end in `shell` on a real input, and fix what breaks. A skill that was never run is a guess.
2. Re-read the frontmatter: would it fire on the right request, and only that one?
3. Check that every path in the body exists, spelled exactly.
4. A skill you write appears in the catalog from your next turn, so use it by reading its file directly if you need it in this one.

If a skill you were following was wrong, fix that skill in place. Do not work around it silently — the next chat gets the same wrong instructions.

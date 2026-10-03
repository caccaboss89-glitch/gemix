---
name: agenda
description: Manage one person's weekly commitments and availability in direct WhatsApp chats using permanent memory and personal reminders. Use when planning, checking free time, updating routines, adding one-off commitments, or helping the user choose a time.
direct-messages-only: true
---

# Personal agenda

## Scope and sources

Use this procedure only in one-to-one WhatsApp chats. Never put someone's personal agenda in a group memory or create a personal agenda reminder for a group. Weekly routines and standing commitments belong in the user's permanent memory through `manage_preferences`. Dated, one-off commitments belong in the user's personal reminders through `schedule_tasks`. Weekly reminders are still reminders only when the user explicitly wants a notification for each occurrence; do not duplicate ordinary routines as recurring reminders.

GemiX has no connected calendar or booking service here. Describe availability as free according to the saved agenda and reminders, not as a confirmed calendar booking. Use Europe/Rome local time, as required by the reminder tools.

## Save or update the permanent agenda

Treat a commitment as weekly only when the user says it repeats or the context makes that clear; ask if it could be one-off. Save only standing commitments and useful scheduling preferences, not dated events.

Use this block as the canonical memory structure. Keep field names and order; edit values to reflect the user's details. Use `none` for an empty field and concise day names and 24-hour times.

```text
AGENDA (Europe/Rome)
FIXED WEEKLY: Day HH:MM-HH:MM — commitment [location]; ...
PREFERENCES:
KEEP FREE (if possible): ...
PREFERRED TIMES — commitments: ...
PREFERRED TIMES — leisure: ...
AVOID: ...
BUFFERS/TRAVEL: ...
SCHEMA NOTE: This block follows the schema in skills/agenda/SKILL.md. For structural changes (not ordinary field or value edits), reread that skill first.
```

When adding the block for the first time, append it to the current memory with `manage_preferences` and `replace: false`, preserving unrelated preferences. When updating an existing agenda block, send the complete current memory with the updated block and `replace: true`; preserve all unrelated memory text. Check the tool result and do not claim a save if it failed. The memory limit is 3,000 characters. If the complete memory would exceed it, compress wording without dropping commitments; if it still does not fit, explain the limit and ask which lower-priority details can be shortened or removed.

The final `SCHEMA NOTE` line must remain in the block. It tells future turns which skill defines the format and when to reread it. Routine edits to days, times, activities, locations, and preference values do not require changing the schema.

## Add one-off commitments

For a dated one-off event the user wants kept on the agenda, create a personal reminder with `schedule_tasks`. By default, use the event's exact local date and start time, so the alert arrives when it begins. If the user requests an earlier alert, schedule at that notice time and include the event's exact date and start time in the reminder text, for example, `Your dentist appointment is today at 15:00.` If the user has not specified a usable event date and time, ask rather than inventing them. Make the reminder text read naturally at delivery time. Do not save one-off event details in permanent memory.

The scheduler accepts dates up to one year ahead. If an event falls outside that window, say it cannot be scheduled yet; do not claim it was saved. Confirm the date, time, and reminder behavior after the tool reports success.

If the user asks for a recurring alert, clarify its cadence and first occurrence, then use the tool's recurrence support. Keep the underlying weekly commitment in memory as well when it is part of the standing agenda.

## Find available times

Read the current permanent memory and use `read_my_tasks` to include existing personal reminders before suggesting openings. Follow pagination when `nextCursor` is returned. Compare the requested dates against weekly commitments and one-off reminders, including recurrence occurrences shown by the tool. A reminder's scheduled time is the event time unless its text states a different event date or time; in that case, use the stated event time as the conflict. Never treat unrecorded time as a confirmed commitment or assume an unknown duration.

Ask for missing details that affect the answer, such as date range, event duration, travel time, location, or a needed buffer. Treat `KEEP FREE` times as protected when possible, and preferred times as a ranking signal. If preferences conflict with the only available opening, explain the tradeoff before recommending it.

When the user is undecided, proactively give two or three concrete options that fit the known agenda, favor their preferred periods, preserve free time, and leave practical buffers. Briefly explain the tradeoffs and recommend the best fit. State any assumptions and label openings as based on the saved agenda and reminders. Do not create a reminder for a proposed new appointment until the user chooses or clearly authorizes it.

## Change the schema

Before changing field names, order, meanings, or the `SCHEMA NOTE`, reread this `SKILL.md` and update the canonical block here first. Small edits to the user's field values do not change the schema.

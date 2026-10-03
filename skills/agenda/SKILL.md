---
name: agenda
description: Manage one person's daily and weekly routines, reminders, and availability in direct WhatsApp chats. Use for agenda setup or review, schedule conflicts, finding free time, adding routines or one-off commitments, and choosing among time options.
direct-messages-only: true
---

# Personal agenda

## Scope and sources

Use this procedure only in one-to-one WhatsApp chats. Never put someone's personal agenda in a group memory or create a personal agenda reminder for a group. Permanent memory describes time-blocking routines; `schedule_tasks` creates alerts. A recurring alert is not automatically a routine, and a saved routine does not automatically need an alert. Dated, one-off commitments belong in the user's personal reminders.

GemiX has no connected calendar or booking service here. Describe availability as free according to the saved agenda and reminders, not as a confirmed calendar booking. Use Europe/Rome local time, as required by the reminder tools.

## Set up or review the agenda

Before the initial interview, read the current memory from `CurrentSettings` and inspect all pages from `read_my_tasks`. Do this again when the user asks to review the agenda. In the interview, summarize existing entries, ask which are still current, and compare them with the user's answers; flag possible duplicates and conflicts, but do not change or delete anything yet.

Ask the user one grouped set of questions, then wait for their answers before writing memory or changing reminders. Cover:

- Their normal daily, weekly, and other recurring commitments: days, start/end times, whether each item blocks time or is only a prompt, location, travel/buffer time, and whether it is ongoing or has start/end dates.
- Daily routines they want considered, predictable exceptions, and special events or temporary schedule changes, with dates and duration.
- Time they prefer to keep free, preferred periods for appointments and leisure, times to avoid, and how much flexibility each preference has.
- Which activities need an alert, and when they want that alert. Explain that reminders deliver messages; they do not book an appointment or silently block calendar time.

Do not assume work, sleep, meals, exercise, or other personal routines should be recorded; ask what the user wants included. Let them answer `none` or `not sure` for any item, and avoid repeating questions already answered in memory. Summarize the proposed routine and preferences so the user can correct them before saving.

When existing reminders overlap or duplicate the proposed routine, show the specific reminder, date/cadence, and any apparent mismatch. Ask whether it is a time-blocking commitment, an alert, or both, and whether a dated conflict is an exception to the routine. Keep one-off and short-term exceptions in reminders. If a recurring reminder's intended duration is unclear, ask; the reader can show the next scheduled occurrence rather than the original start, so do not infer total duration from that field alone.

## Choose memory or reminders

Use permanent memory for ongoing daily/weekly routines and recurring time blocks intended to last more than one month. Use the temporary-change field for a routine change lasting more than one month when it has known start/end dates. Do not put one-off events or recurring patterns lasting one month or less in the routine memory; keep those in reminders. Include explicit dates so a temporary change only applies within its stated period.

Treat recurrence as two separate questions: how long the pattern lasts, and whether the user wants a notification. A recurring reminder lasting one month or less stays in the reminder system and is not copied into routine memory. A longer reminder is still only an alert unless the user confirms that it represents a time-blocking routine. A long-term routine can live in memory without alerts; if the user wants both a time block and repeated alerts, keep both representations only with their consent. The scheduler caps a recurrence at one year when `UNTIL` is omitted, so do not describe it as indefinite; clarify its intended duration when that matters.

If a long-running reminder appears to be a routine and conflicts with the user's stated preference to track routines in memory, propose the specific migration and ask permission to save the routine in memory and cancel that reminder. State that canceling it stops future alerts. Do not change either record without clear consent. If approved, update and verify memory first, preserving unrelated text; only then remove the reminder by its ID and verify removal. If saving memory fails, keep the reminder. If removal fails, tell the user the routine was saved but the alert remains.

## Save or update the permanent agenda

Treat an item as a routine only when it occupies time and the user says it repeats or confirms that interpretation. Ask if it could be one-off or only a notification. Save standing commitments and useful scheduling preferences, not dated events or short-term patterns.

Use this block as the canonical memory structure. Keep field names and order; edit values to reflect the user's details. Use `none` for an empty field and concise day names and 24-hour times.

```text
AGENDA (Europe/Rome)
FIXED ROUTINES:
DAILY: HH:MM-HH:MM — commitment [location]; ...
WEEKLY: Day(s) HH:MM-HH:MM — commitment [location]; ...
OTHER RECURRING (>1 month): cadence, dates if bounded — commitment; ...
TEMPORARY CHANGES (>1 month): YYYY-MM-DD to YYYY-MM-DD — changed routine; ...
ROUTINE EXCEPTIONS (>1 month): dates or rule — exception; ...
PREFERENCES:
KEEP FREE (if possible): ...
PREFERRED TIMES — commitments: ...
PREFERRED TIMES — leisure: ...
AVOID: ...
BUFFERS/TRAVEL: ...
SCHEMA NOTE: This block follows the schema in skills/agenda/SKILL.md. For structural changes (not ordinary field or value edits), reread that skill first.
```

When adding the block for the first time, append it to the current memory with `manage_preferences` and `replace: false`, preserving unrelated preferences. When updating an existing agenda block, send the complete current memory with the updated block and `replace: true`; preserve all unrelated memory text. Check the tool result and do not claim a save if it failed. The memory limit is 3,000 characters. If the complete memory would exceed it, compress wording without dropping commitments; if it still does not fit, explain the limit and ask which lower-priority details can be shortened or removed. Remove expired temporary changes when reviewing or updating the memory, after confirming they have ended.

The final `SCHEMA NOTE` line must remain in the block. It tells future turns which skill defines the format and when to reread it. Routine edits to days, times, activities, locations, and preference values do not require changing the schema.

## Add one-off commitments

For a dated one-off event the user wants kept on the agenda, create a personal reminder with `schedule_tasks`. By default, use the event's exact local date and start time, so the alert arrives when it begins. If the user requests an earlier alert, schedule at that notice time and include the event's exact date and start time in the reminder text, for example, `Your dentist appointment is today at 15:00.` If the user has not specified a usable event date and time, ask rather than inventing them. Make the reminder text read naturally at delivery time. Do not save one-off event details in permanent memory. For a short-term recurring activity (one month or less), use a reminder recurrence only if the user wants an alert; explain that GemiX cannot store a silent, temporary calendar block.

The scheduler accepts dates up to one year ahead. If an event falls outside that window, say it cannot be scheduled yet; do not claim it was saved. Confirm the date, time, and reminder behavior after the tool reports success.

If the user asks for recurring alerts, clarify cadence, first occurrence, intended end date, and notification time, then use the tool's recurrence support. Keep a separate memory entry only if the user also confirms that the activity is a time-blocking routine lasting more than one month. For an existing reminder, use `remove_my_tasks` only after the user approves cancellation; if changing rather than migrating a recurrence, remove and recreate it by ID because the tool does not edit an existing reminder.

## Find available times

Read the current permanent memory and use `read_my_tasks` to include existing personal reminders before suggesting openings. Follow pagination when `nextCursor` is returned. Compare the requested dates against applicable daily, weekly, and date-bounded routine entries plus one-off and recurring reminders. A reminder's scheduled time is the event time unless its text states a different event date or time; in that case, use the stated event time as the conflict. Do not count a short-term recurring reminder as a permanent routine. Never treat unrecorded time as a confirmed commitment or assume an unknown duration.

Ask for missing details that affect the answer, such as date range, event duration, travel time, location, or a needed buffer. Treat `KEEP FREE` times as protected when possible, and preferred times as a ranking signal. If preferences conflict with the only available opening, explain the tradeoff before recommending it.

When the user is undecided, proactively give two or three concrete options that fit the known agenda, favor their preferred periods, preserve free time, and leave practical buffers. Briefly explain the tradeoffs and recommend the best fit. State any assumptions and label openings as based on the saved agenda and reminders. Do not create a reminder for a proposed new appointment until the user chooses or clearly authorizes it.

## Change the schema

Before changing field names, order, meanings, or the `SCHEMA NOTE`, reread this `SKILL.md` and update the canonical block here first. Small edits to the user's field values do not change the schema.

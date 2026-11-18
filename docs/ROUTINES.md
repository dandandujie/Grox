# Routines

Routines run a bot on a schedule and record a run in Activity. A routine can target a bot's own tasks or a channel. A channel routine fixes both the channel and its responding bot. The bot must still be a channel member when the routine starts. **Run now** opens the resulting thread.

Daily, weekday, weekly and hourly schedules use the local clock. **Cron** accepts five fields and an optional IANA time zone, such as `0 10 * * 1` in `UTC`. The calendar shows the next computed occurrence.

## Continuous routines

A routine can opt into **Keep one thread**. The first run creates a task thread, and later runs append to the
same thread. If that thread is still busy, a new run is refused instead of overlapping. A fresh task thread
remains the default when continuity is off.

The Grox v1 team format omits continuity and checks. OpenMaus import and export preserve continuity, channel targets and supported schedules. Imported routines start paused.

## Busy and failure behavior

While the bot is busy, **Skip this run** advances to the next scheduled time; **Retry shortly** marks the
routine queued and runs it once when the bot becomes free. Only one queued occurrence is kept per routine.
When a run fails, the next retry backs off from 15 minutes, doubles per consecutive failure and caps at four
hours for enabled routines. A completed run resets the counter. A failed real engine stays failed in Activity.
When Grox closes mid-run, reopening marks it stopped. Future scheduled runs use the persisted schedule.

## Runs check

A routine can opt into **Only when there is news**. On a scheduled tick, Grox looks for other routines' runs
finished after the last check. If none finished, it updates the check time and starts no turn and no run. If
some finished, their title/status/summary lines are appended to the routine prompt. Manual Run now always runs.

The runs check reads local run history. Mail and calendar checks, proactive brief delivery and full catch-up
remain open.

## Proactive routines

The full proactive watch (mail/calendar checks, brief, meeting prep, inbox triage, read-and-draft) requires
connected apps and hosted helpers; it is not implemented.

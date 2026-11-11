# Routines

Routines run a bot on a schedule and record a run in Activity.

## Continuous routines

A routine can opt into **Keep one thread**. The first run creates a task thread, and later runs append to the
same thread. If that thread is still busy, a new run is refused instead of overlapping. A fresh task thread
remains the default when continuity is off.

Continuity is carried through openmaus.package v2 import/export. Overlap queueing, cloud execution, room
goals and timeouts are not ported.

## Busy and failure behavior

While the bot is busy, **Skip this run** advances to the next scheduled time; **Retry shortly** marks the
routine queued and runs it once when the bot becomes free. Only one queued occurrence is kept per routine.
When a run fails, the next retry backs off from 15 minutes, doubles per consecutive failure and caps at four
hours; a completed run resets the counter.

## Runs check

A routine can opt into **Only when there is news**. On a scheduled tick, Grox looks for other routines' runs
finished after the last check. If none finished, it updates the check time and starts no turn and no run. If
some finished, their title/status/summary lines are appended to the routine prompt. Manual Run now always runs.

Checks are limited to local routine runs; mail/calendar checks, brief delivery and backoff/catch-up semantics
are not ported.

## Proactive routines

The full proactive watch (mail/calendar checks, brief, meeting prep, inbox triage, read-and-draft) requires
connected apps and hosted helpers; it is not implemented.

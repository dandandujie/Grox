# Routines

Routines run a bot on a schedule and record a run in Activity.

## Continuous routines

A routine can opt into **Keep one thread**. The first run creates a task thread, and later runs append to the
same thread. If that thread is still busy, a new run is refused instead of overlapping. A fresh task thread
remains the default when continuity is off.

Continuity is carried through openmaus.package v2 import/export. Overlap queueing, cloud execution, room
goals, timeouts and routine checks are not ported.

## Proactive routines

The full proactive watch (mail/calendar checks, brief, meeting prep, inbox triage, read-and-draft) requires
connected apps and hosted helpers; it is not implemented.

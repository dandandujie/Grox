# Onboarding

A first-run welcome appears until Settings.Onboarded is true. It is a local modal, not a hosted signup.

## Actions

- Create a bot: marks onboarding complete and opens the new-bot dialog.
- Start with demo: marks complete and leaves the seeded workspace.
- Connect an engine: marks complete and opens Settings -> Engines.
- Closing the modal also marks complete.

Settings -> About has "Show welcome again" to reset the flag.

## Boundaries

There is no migration wizard for a legacy Grok Bot export yet, no account signup, no telemetry and no hosted
trial. Team package import remains in Settings -> Data & privacy.

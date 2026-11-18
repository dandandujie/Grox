# Local automation API

[简体中文](API.md)

Grox can expose a small loopback HTTP API for local scripts and CI. It is off by default and exists only
on 127.0.0.1; it is not a hosted service or a public relay.

## Enable

Settings -> Automation -> Enable the loopback API. Grox generates a bearer token and shows it once.
When enabled, the token is stored in secrets.json under api:token. Rotate token replaces it and invalidates
the previous value. GetAPIInfo never returns an existing token.

Every /v1 request needs:

    Authorization: Bearer <token>

/health is public and returns only service identity.

## Endpoints

- GET /v1/state - the current AppState snapshot.
- GET /v1/bots - the bot roster.
- GET /v1/events - authenticated server-sent events. The first event is ready; later frames use the same
  message/delta/turn/state event names as the desktop. A comment heartbeat is sent every 15 seconds.
- GET /v1/groups and GET /v1/routines - channel and routine inventories.
- POST /v1/groups/{groupID}/threads/{threadID}/messages, approvals/{messageID} and answers/{messageID} -
  the same group send/approval/answer paths as the UI.
- POST /v1/routines/{routineID}/run - run a routine now and return 202 with the SendResult.
- POST /v1/bots/{botID}/threads/{threadID}/messages with {"text":"..."}.
  Starts a turn and returns the SendResult with 202.
- POST /v1/bots/{botID}/threads/{threadID}/approvals/{messageID} with
  {"decision":"allow"} or {"decision":"deny"}.
- POST /v1/bots/{botID}/threads/{threadID}/answers/{messageID} with {"answer":"..."}.

Example:

    curl -H "Authorization: Bearer $GROX_API_TOKEN" http://127.0.0.1:PORT/v1/state
    curl -X POST -H "Authorization: Bearer $GROX_API_TOKEN" -H 'Content-Type: application/json' \
      -d '{"text":"summarize the inbox"}' \
      http://127.0.0.1:PORT/v1/bots/BOT/threads/THREAD/messages

## Boundaries

- The API binds to loopback and serves local authenticated scripts.
- The API uses the same service methods and approval/waiter paths as the desktop UI.
- Payloads are capped at 64 KB. A turn still runs asynchronously after the 202 response.
- Hosted orchestration, cloud computers and a public API remain unported.

## Files

- internal/service/api_server.go
- internal/model/types.go - Settings.APIEnabled, APIInfo
- src/components/SettingsModal.tsx - Automation section

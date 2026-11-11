# Inbound webhooks

Grox runs a small loopback HTTP receiver for inbound webhook triggers. This is the local-code part of the
OpenMausBot trigger system. App-event triggers (Slack/GitHub/Linear events from Composio), a public relay,
signature verification beyond the capability token, retries and an event journal are not ported yet.

## Receiver

The service starts the receiver with the rest of the app:

    http://127.0.0.1:<random port>

It binds 127.0.0.1 only. /health returns {"ok":true}; the app does not expose the receiver on the LAN or the
public internet. If the bind fails the Webhooks tab reports the error and does not accept new triggers.

## Trigger URL

Each webhook has a random URL token:

    POST http://127.0.0.1:<port>/hooks/<token>

The token is a capability. Treat the URL like a password. An optional Authorization header must be either
empty or Bearer <token>; the path token is always required. Disabled or deleted triggers return 404.

## Payload

The body is capped at 64 KB. Accepted shapes:

- JSON object: the first present of prompt, text, message or body is used; otherwise the whole object is
  serialized.
- JSON string.
- Plain text.

The final task text is:

    <trigger instruction>

    Webhook payload:
    <incoming text>

If the trigger has no instruction, the payload is the task. If both are empty, the request is rejected.

## What happens

A request creates a new task conversation for the trigger's bot, appends the inbound text as a user message,
increments the trigger's event count, stores lastEventAt, and starts the normal turn pipeline. The HTTP
response is 202 with the new thread id. A busy bot returns 409; an unknown/disabled trigger returns 404.

The turn is not selected in the UI, so an inbound hook does not move the person's current conversation. The
task appears in the bot's conversation list and in normal state events.

## Management

The Tasks & routines → Webhooks tab lists triggers, shows the endpoint and event count, copies the URL,
pauses/resumes a trigger, edits its instruction and bot, and deletes it. Creating a trigger mints a new
token; editing keeps the token stable.

## Not ported

- Public relay and internet exposure.
- Composio app-event subscriptions and outbound trigger broker.
- HMAC signature verification, replay protection, retries and delivery IDs.
- Event journal with individual delivery inspection.
- Group/channel target triggers.

## HMAC signatures

A trigger can require a signature. The URL token is also the HMAC key; it is already a capability secret.

Required headers:

- X-Grox-Timestamp: Unix seconds
- X-Grox-Signature: sha256=<lowercase hex>
- X-Grox-Delivery: optional unique delivery id

The signed string is:

    <timestamp>.<raw request body>

The timestamp must be within five minutes of the receiver clock. A signature comparison is constant-time.

If X-Grox-Delivery is present, a delivery id accepted in the last ten minutes is rejected with 409.
Without a delivery id the timestamp window is the only replay limit, so send one for production callers.

Example shell:

    ts=$(date +%s)
    sig=$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$TOKEN" | awk '{print $2}')
    curl -X POST "$URL" -H "Content-Type: application/json" \
      -H "X-Grox-Timestamp: $ts" -H "X-Grox-Delivery: $(uuidgen)" \
      -H "X-Grox-Signature: sha256=$sig" --data-binary "$body"

Invalid or missing signatures return 401; replayed delivery ids return 409.


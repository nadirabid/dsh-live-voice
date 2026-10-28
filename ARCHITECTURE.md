# Architecture

`@nmuzaffar/dsh-live-voice` is one Cordis bundle with two halves: a host plugin that speaks the
GPT-Live protocol and drives harness turns, and a browser module that carries audio and draws the
voice surfaces. Neither half runs a server; both contribute into services DSH already provides.

## Transport

The browser talks to the host over the shared `/api` Fetch channel, registered with
`connection.fetch.register`. Five exact routes:

| Route | Methods | Purpose |
|---|---|---|
| `/api/live-voice/session` | POST | open a live session; resolves the key and dials OpenAI |
| `/api/live-voice/audio` | POST | append one base64 PCM16 chunk of microphone audio |
| `/api/live-voice/poll` | POST | long-poll (5 s) for queued events |
| `/api/live-voice/close` | POST | end the session |
| `/api/live-voice/settings` | GET, POST | read the stored key; write a new one |

Not a WebSocket, deliberately. The desktop window runs on `dsh-app://app`; only relative `/api`
requests are proxied to the host process, with its auth cookie attached by the app. A WebSocket
cannot be addressed from that origin, so an upgrade route is unreachable from the page that matters.

Each live session owns a single-consumer event queue on the host. Polling returns as soon as
anything is queued, so latency is one round trip; the 5 s window keeps every request shorter than
any proxy timeout, and the client retries a failed poll four times before declaring the link lost.

## Session lifecycle

`POST /session` resolves the key, dials `wss://api.openai.com/v1/live/sessions`, sends `session.start`
(model, voice, instructions, `delegation: { type: 'client' }`) and waits for `session.started`.
Server events are queued for the browser and fed to the bridge. A cap timer closes the session after
`maxSessionMinutes` (60 by default).

Nothing about the harness conversation is sent at startup: the voice model begins with the standing
instructions alone and learns context only from what it hears.

## Delegations

GPT-Live decides when it needs work done and pushes `session.delegation.created`. The event carries
an id and no task text, so the task has to be recovered from the user's own speech.

`lib/bridge.js` holds that mapping:

- input transcript deltas accumulate in a buffer, capped at 4,000 characters;
- a delegation takes the buffer as its task and clears it, so the next delegation starts from the
  next utterance;
- tasks longer than 300 characters keep only the tail, cut at a sentence boundary — unrelated talk
  that preceded the request is dropped rather than sent;
- repeated delegation ids and near-identical text within 60 s are dropped;
- a delegation with no actionable speech is answered with a quiet `thinking` note, not a turn;
- one task runs at a time; a second delegation is queued and dispatched when the first settles.

## Turns

`lib/index.js` turns one task into one turn in the attached session:

1. `sessionController.resolveAgent(sessionId)` — the live agent, or a session error;
2. capture `agent.session.seq`;
3. `agent.followup(createUserMessage({ content: task, source: { kind: 'user' } }))`;
4. `await agent.whenIdle()`, then `sessions.flush(session)`;
5. read events after the captured seq for the last assistant text and the turn reason;
6. append the result with `session.commentary.append(text, delegation_id)`.

The message carries the user's own source, so the transcript records the spoken words as the user's
message and draws a normal user bubble. A spoken request is the user's request; the plugin no longer
wraps it in a notice, and a run of spoken turns reads like a typed conversation.

That also removed the plugin's last reason to own `conversation.chat.node`: with no voice notice row
to draw, the keyed `turn-trigger` shadow, its row copy and its label table are gone, and every
trigger source renders through the core chat again.

## Dictation preview

While a session is live, the decoded words are drawn as the message being dictated: a user bubble at
the end of the conversation, a caret where the next word lands, and the plugin's mark and title
beneath it. It clears when the turn dispatches, at which point the committed user message carries the
text, so the bubble hands over to the message it was previewing.

The chat owns the transcript and exposes no seat at its end, so the bubble is portalled into the
chat column itself (`[data-chat-flow]`), resolved from the seat's own hidden anchor inside its
`[data-conversation-content]` so the lookup cannot reach another Session. A `MutationObserver` keeps
the row last — and before the running indicator (`[data-chat-running]`) while a turn is in flight,
because React appends its own children without knowing about the portal. Growing the column is also
what the chat's own `ResizeObserver` follows, so the bubble stays in view while the reader is at the
tail.

The seat is still registered in `conversation.input.dock`: that registration is what keeps the
component mounted under the composer, and it is the fallback placement for a view with no chat
column — a document, a trajectory — pinned to `--dsh-chat-content-width` and centred.

## Composer seat

The orb lives in `conversation.input.right`, which renders before the model seat. The trailing row is
`[input.right][model][mic][stop][send]`; the microphone owns the single-occupant
`conversation.input.activity`, and Send is not a slot. A plugin therefore cannot sit between the mic
and Send without disabling the built-in voice-input bundle.

The orb is an SVG circle with five bars — inline styles, inside a `span` with `role="button"` —
because the composer restyles real `button` elements in that row.

## Key resolution

For each session, in order:

1. `config.apiKey` in the row config;
2. `config.apiKeyFile` (default `~/.dsh/live-voice.key`, `~` expanded, mode 600 on write);
3. the credential service, using the reference in `config.apiKeyEnv` (default `OPENAI_API_KEY`);
4. the launch environment, then `process.env`.

The settings card reads and writes (2) through the host routes and pre-fills the field with the
resolved key, so the field shows what is actually in use.

## Config

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | — | inline key; takes precedence over the file |
| `apiKeyEnv` | `OPENAI_API_KEY` | credential reference |
| `apiKeyFile` | `~/.dsh/live-voice.key` | key file |
| `endpoint` | `wss://api.openai.com/v1/live/sessions` | Foundry or a test server |
| `model` | `gpt-live-1` | live model |
| `voice` | `marin` | one of the 22 Live voices |
| `instructions` | built in | standing orders for the voice model |
| `maxSessionMinutes` | `60` | hard cap per session |
| `logFile` | — | append transport diagnostics |

## Limits

- **Approvals are not bridged.** A turn that stops for permission sits silently while the voice
  model says it is working.
- **One task in flight.** A correction mid-task queues as a new task; there is no `steer` path.
- **`whenIdle()` is coarse.** Typing into the session during a voice task can fold that turn into
  the spoken summary. Correlating `agent/inbox/claimed` by message id is the fix.
- Audio is fixed at 24 kHz PCM16 both ways; other capture rates are linearly resampled.

## Layout

```
lib/index.js        host plugin: routes, session entry, turn dispatch, settings
lib/live-client.js  GPT-Live WebSocket client
lib/protocol.js     session.start, event helpers, voices, default instructions
lib/bridge.js       delegation state machine (buffer, trim, dedupe, queue)
client/index.js     browser module: orb, dictation, chat row, settings card
cordis.patch.yml    bundle patch (one host row)
locale/, icon.svg   display metadata
test/               node:test suites, mock GPT-Live server, fake agent
design/             live-button option sheet
scripts/dev-link.sh dev links for the DSH packages tests import
```

## Development

```sh
npm install          # ws
./scripts/dev-link.sh # link the DSH packages tests import
npm test             # 24 tests
```

Tests cover the bridge, the wire client against a mock server, and the whole loop: fetch routes →
bridge → fake agent turn → `commentary.append`.

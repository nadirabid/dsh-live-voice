# Live Voice for DeepSeek Harness

`@nadirabid/dsh-live-voice` — a Cordis bundle with a host half and a browser half.

A Cordis bundle that adds a full-duplex voice session to the Harness web GUI. You talk
continuously; GPT-Live listens and speaks, and whenever it needs real work done it hands the
request to this harness, which runs it as one turn in the open session and speaks the result back.

v1 is written and unit/integration tested against a mock Live server. It has **not** been run
against the real OpenAI API yet: the `OPENAI_API_KEY` in `../GitHub/stu/.env` is rejected by
OpenAI (HTTP 401), so a live smoke test is the first thing to do once a valid key exists.

## Requirements

- DSH desktop or web profile (the browser half needs the web GUI).
- An OpenAI API key with GPT-Live access (`gpt-live-1`).
- The package is plain JavaScript; no build step.

## Install

1. Install the package into the profile (this runs pnpm in the profile directory):

   ```sh
   DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
   "$DSH" plugin --profile desktop add "$PWD"
   ```

2. Add the bundle to the profile's ordered bundle list in `~/.dsh/profiles/desktop/package.json`:

   ```json
   {
     "dsh": {
       "profile": {
         "bundles": ["...", "@local/dsh-live-voice"]
       }
     }
   }
   ```

3. Restart DSH. With HMR mounted the new bundle may load without a restart; if the Live button
   does not appear, quit and reopen the app.

4. Give the plugin a key. The least invasive option is a one-line key file outside the profile:

   ```sh
   printf '%s' 'sk-...' > ~/.dsh/live-voice.key
   chmod 600 ~/.dsh/live-voice.key
   ```

   and point the row at it in `~/.dsh/profiles/desktop/cordis.patch.yml`:

   ```yaml
   - id: live-voice
     config:
       apiKeyFile: ~/.dsh/live-voice.key
   ```

   Alternatively leave `apiKeyEnv` at its default and provide `OPENAI_API_KEY` through the
   credential service or the launch environment.

## Set the key from the UI

Plugins → Live Voice → the `live-voice` row → paste the key into **OpenAI API key** →
**Save key**. The host writes it to the file below with mode 600 and uses it for the next
session immediately, no restart. The row summary shows the stored key masked
(`sk-proj…4xnk`) so you can tell whether one is set.

## The voice row

`conversation.chat.node` is a keyed slot owned by `@deepseek-ai/dsh-client-ui-chat`. This bundle
registers the `turn-trigger` key at priority −1, shadowing that package's renderer so voice turns can
carry the plugin's own mark and the title **Live Voice** with the decoded speech inline, right-aligned
like the user's own messages so speech and answer sit on opposite sides of the column. Every other
trigger source (schedule, job, webhook, subagent, team, github, plugin) keeps the core title and
icon, rendered by our copy of that row.

Owning the key means owning the row for all sources: if core redesigns it, this copy has to follow.

## What you said, in the chat

Each dispatched task carries the decoded speech as its notice summary, so the conversation shows a
compact row reading `Voice: …` immediately above the turn it triggered, with the result below it.
The agent itself receives only the trimmed task text, not the whole transcript — the row is for you.

While you are still speaking, the same words appear in a right-aligned strip above the composer, so
dictation is visible before anything is dispatched. The strip clears the moment the request becomes a
turn, and the chat row carries it from there.

## Use

Open a session, click **Live** in the composer's right-hand controls (same row as the microphone
and Send). The pill shows `Connecting`, `Listening`, `Working`, or `Speaking`; `×` ends the
session. Speech is streamed both ways while turns run, so you can keep talking during a long task.

## How it works

```
browser mic ──AudioWorklet → PCM16 24 kHz──▶ POST /api/live-voice/audio
browser speaker ◀──PCM16 24 kHz── poll ───── host ──WebSocket──▶ GPT-Live /v1/live/sessions
                                     │
                     session.delegation.created
                                     ▼
              task = user transcript since the previous delegation
                                     ▼
              agent.followup(task) → whenIdle() → assistant text
                                     ▼
              session.commentary.append(text, delegation_id)
```

- One delegation is one harness turn. The transcript buffer is consumed by each delegation, so the
  next one starts from the next utterance.
- Repeated delegation ids and near-identical requests inside 60 s are dropped.
- Delegations with no actionable speech are answered with a quiet `thinking` note, not a turn.
- A second delegation while a turn runs is queued and dispatched when the first settles.
- The browser transport is the shared `/api` Fetch channel at `/api/live-voice/*`
  (`session`, `audio`, `poll`, `close`), registered through `connection.fetch`.
  A WebSocket cannot be used here: the desktop window runs on `dsh-app://app`,
  and only relative `/api` requests are proxied to the host with its cookie.

## Config

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | — | Inline key; testing only |
| `apiKeyEnv` | `OPENAI_API_KEY` | Credential reference resolved through the credential service, then the launch environment |
| `apiKeyFile` | — | File holding the key; `~` expanded |
| `endpoint` | `wss://api.openai.com/v1/live/sessions` | Override for Foundry or a test server |
| `model` | `gpt-live-1` | Live model |
| `voice` | `marin` | One of the 22 Live voices |
| `instructions` | built in | Standing orders for the voice model |
| `routePath` | `/live-voice` | Browser transport path |
| `maxSessionMinutes` | `60` | Hard cap per session |

## Limits in v1

- **Approvals are not bridged.** A turn that stops for permission will sit there while the voice
  model says it is working. This is the first thing to fix.
- **One task at a time.** A correction mid-task is queued as a new task, not applied to the
  running one (no `steer` yet).
- **`whenIdle()` is coarse.** If you type into the session while a voice task runs, the spoken
  summary can include the typed turn as well. Correlating via `agent/inbox/claimed` is the fix.
- Audio is fixed at 24 kHz PCM16 in both directions; other context rates are linearly resampled.

## Layout

```
lib/index.js        host plugin: /api routes, session entry, turn dispatch
lib/live-client.js  GPT-Live WebSocket client
lib/protocol.js     session.start and event helpers, voices, default instructions
lib/bridge.js       delegation state machine (buffer, dedupe, queue, results)
client/index.js     browser module: composer orb + settings card
cordis.patch.yml    bundle patch (one host row)
locale/, icon.svg   display metadata for the plugin list
test/               node:test suites, mock GPT-Live server, fake agent
design/             the live-button option sheet
scripts/dev-link.sh links DSH packages into node_modules for local tests
```

## Where the button sits

The composer's trailing row is composed as `[input.right slot][model seat][mic][stop][send]`. The
microphone owns `conversation.input.activity`, a single-occupant slot, and the Send button is not a
slot at all. So a plugin can sit *before* the model seat (this bundle's choice) but cannot sit
between the mic and Send unless the built-in voice-input bundle is disabled, freeing that seat.

## Tests

```sh
npm test
```

21 tests: the delegation state machine, the Live protocol client, and a full loop with a mock
GPT-Live WebSocket server and a fake harness agent (browser socket → plugin → turn → commentary).

# Live Voice

Talk to DeepSeek Harness. GPT-Live listens and speaks; the harness does the work.

## Install

In DSH: **Plugins → Install**, paste:

```
@nmuzaffar/dsh-live-voice
```

Then **Plugins → Live Voice** and paste an OpenAI API key with GPT-Live access. It's stored on this
machine, not in the plugin.

## Use

Click the orb beside the microphone and talk. Keep talking while it works — it says what the harness
is doing and speaks the result when it lands.

## Privacy

The key is written to `~/.dsh/live-voice.key` with mode 600. Audio goes to OpenAI and nowhere else.
No telemetry.

How it works, and where the edges are: [ARCHITECTURE.md](ARCHITECTURE.md)

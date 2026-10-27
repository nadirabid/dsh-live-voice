/**
 * Live Voice — full-duplex GPT-Live session wired to this harness.
 *
 * The browser half carries microphone audio and playback; this host half holds
 * the OpenAI key, speaks the Live protocol, and turns each GPT-Live delegation
 * into one harness turn. Results are appended back to the live session against
 * the delegation id that asked for them.
 *
 * The browser transport is the shared `/api` Fetch channel, not a WebSocket:
 * the desktop app runs the page on `dsh-app://app` and proxies `/api` requests
 * (with the auth cookie) to the host, so relative Fetch paths are the only
 * origin-agnostic way to reach this process.
 *
 * @module @local/dsh-live-voice
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import z from '@deepseek-ai/schemastery';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { LiveBridge } from './bridge.js';
import { LiveClient } from './live-client.js';
import { DEFAULT_INSTRUCTIONS, DEFAULT_MODEL, DEFAULT_VOICE, LIVE_ENDPOINT, VOICES } from './protocol.js';

export const name = 'live-voice';
// bundle-rev: 2

export const inject = ['connection', 'sessionController', 'sessions'];

const ROUTE = '/api/live-voice';

/** Configuration for one live-voice host row. */
export const Config = z.object({
  /** OpenAI API key; prefer `apiKeyFile` or `apiKeyEnv`. */
  apiKey: z.string(),
  /** Credential reference naming the key; defaults to `OPENAI_API_KEY`. */
  apiKeyEnv: z.string(),
  /** File holding the key, one line; `~` is expanded. */
  apiKeyFile: z.string(),
  /** Live WebSocket endpoint; override for Microsoft Foundry or a test server. */
  endpoint: z.string(),
  /** Model name; defaults to `gpt-live-1`. */
  model: z.string(),
  /** Output voice; one of the Live voices. */
  voice: z.string(),
  /** Standing instructions for the voice model. */
  instructions: z.string(),
  /** Hard cap on one live session, in minutes. */
  maxSessionMinutes: z.number(),
  /** Append transport diagnostics to this file; `~` is expanded. */
  logFile: z.string(),
});

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {z.infer<typeof Config>} config
 */
export function apply(ctx, config) {
  const logger = {
    info: (message) => console.log(`[live-voice] ${message}`),
    warn: (message) => console.warn(`[live-voice] ${message}`),
  };
  /** @type {Map<string, any>} */
  const sessions = new Map();

  const register = (path, methods, fetch) => {
    ctx.effect(
      () => ctx.connection.fetch.register({
        path: `${ROUTE}${path}`,
        methods,
        requestBody: 'buffered',
        fetch,
      }),
      `live-voice: ${ROUTE}${path}`,
    );
  };

  register('/session', ['POST'], async (request) => {
    const body = await readJson(request);
    const sessionId = body?.sessionId;
    if (typeof sessionId !== 'string' || sessionId === '') return json({ error: 'live voice: no session id' }, 400);
    const apiKey = await resolveApiKey(ctx, config);
    debugLog(config, `start session=${sessionId} key=${apiKey ? 'yes' : 'no'}`);
    if (!apiKey) return json({ error: `live voice: no OpenAI API key in ${config.apiKeyEnv ?? 'OPENAI_API_KEY'}` }, 503);
    try {
      const entry = await createEntry({ ctx, config, logger, apiKey, sessionId });
      const liveId = randomUUID();
      sessions.set(liveId, entry);
      return json({ liveId, model: config.model ?? DEFAULT_MODEL, voice: config.voice ?? DEFAULT_VOICE });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugLog(config, `start-failed session=${sessionId} ${message}`);
      return json({ error: message }, 502);
    }
  });

  register('/audio', ['POST'], async (request) => {
    const body = await readJson(request);
    const entry = sessions.get(body?.liveId);
    if (!entry) return json({ error: 'live voice: unknown session' }, 404);
    if (typeof body.data === 'string') entry.sendAudio(body.data);
    return new Response(null, { status: 204 });
  });

  register('/poll', ['POST'], async (request) => {
    const body = await readJson(request);
    const entry = sessions.get(body?.liveId);
    if (!entry) return json({ error: 'live voice: unknown session', closed: true }, 404);
    return json(await entry.poll(5_000));
  });

  register('/close', ['POST'], async (request) => {
    const body = await readJson(request);
    debugLog(config, `close requested reason=${body?.reason ?? 'user'}`);
    const entry = sessions.get(body?.liveId);
    if (entry) {
      entry.close();
      sessions.delete(body.liveId);
    }
    return new Response(null, { status: 204 });
  });
}

/**
 * One live session: the GPT-Live socket, the bridge, and the event queue the
 * browser polls.
 */
async function createEntry({ ctx, config, logger, apiKey, sessionId }) {
  const queue = [];
  let waiter = null;
  let isClosed = false;

  const push = (message) => {
    queue.push(message);
    waiter?.();
    waiter = null;
  };

  const bridge = new LiveBridge({
    dispatch: (task) => {
      push({ type: 'status', state: 'thinking', detail: task.text });
      void runHarnessTurn(ctx, sessionId, task, bridge, logger);
    },
    commentary: (delegationId, content) => {
      live.send({ type: 'session.commentary.append', delegation_id: delegationId, content });
      push({ type: 'transcript', role: 'assistant', text: content });
    },
    thinking: (delegationId, content) => {
      live.send({ type: 'session.thinking.append', delegation_id: delegationId, content });
    },
    log: (message) => logger.info(message),
  });

  const live = new LiveClient({
    apiKey,
    url: config.endpoint ?? LIVE_ENDPOINT,
    model: config.model ?? DEFAULT_MODEL,
    voice: config.voice ?? DEFAULT_VOICE,
    instructions: config.instructions ?? DEFAULT_INSTRUCTIONS,
    onEvent: (event) => {
      if (event.type === 'session.output_audio.delta') {
        push({ type: 'audio', data: event.delta });
      } else if (event.type === 'session.input_transcript.delta') {
        push({ type: 'transcript', role: 'user', text: event.delta });
      } else if (event.type === 'session.output_transcript.delta') {
        push({ type: 'transcript', role: 'assistant', text: event.delta });
      } else if (event.type === 'session.closed') {
        debugLog(config, `session-closed reason=${event.reason}`);
        push({ type: 'closed', reason: event.reason });
      } else if (event.type === 'error') {
        push({ type: 'error', message: event.error?.message ?? 'live error' });
      }
      bridge.handleLiveEvent(event);
    },
    onClose: (detail) => {
      isClosed = true;
      debugLog(config, `socket-closed code=${detail?.code ?? '-'} reason=${detail?.reason || '-'}`);
      push({ type: 'closed', reason: 'socket_closed' });
    },
    onError: (error) => push({ type: 'error', message: error.message }),
  });

  await live.connect();
  push({ type: 'ready', model: config.model ?? DEFAULT_MODEL, voice: config.voice ?? DEFAULT_VOICE });

  const cap = setTimeout(() => live.close(), (config.maxSessionMinutes ?? 60) * 60_000);
  cap.unref?.();

  return {
    sendAudio: (data) => live.sendAudio(data),
    close() {
      clearTimeout(cap);
      isClosed = true;
      live.close();
      waiter?.();
      waiter = null;
    },
    /** Return everything queued, waiting up to `timeoutMs` for the first item. */
    async poll(timeoutMs) {
      if (queue.length === 0 && !isClosed) {
        await new Promise((resolve) => {
          waiter = resolve;
          setTimeout(resolve, timeoutMs).unref?.();
        });
      }
      const events = queue.splice(0, queue.length);
      return { events, closed: isClosed };
    },
  };
}

/**
 * One task runs as one follow-up turn in the attached harness session. The
 * turn's final assistant text is the answer spoken back to the caller.
 */
async function runHarnessTurn(ctx, sessionId, task, bridge, logger) {
  try {
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
    const resolved = await ctx.sessionController.resolveAgent(sessionId);
    if (resolved && 'error' in resolved) {
      bridge.turnFinished({ ok: false, text: resolved.error?.message ?? 'session unavailable' });
      return;
    }
    const agent = resolved.agent;
    const firstSeq = agent.session.seq;
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: task.text }],
      source: {
        kind: 'cordis-host-runner',
        form: 'notice',
        summary: `Voice: ${noticeSummary(task.raw ?? task.text)}`,
      },
    }));
    await agent.whenIdle();
    await ctx.sessions.flush(agent.session);
    const outcome = readOutcome(agent.session, firstSeq);
    bridge.turnFinished({ ok: outcome.reason?.kind !== 'error', text: outcome.text });
  } catch (error) {
    logger.warn(`turn failed: ${error instanceof Error ? error.message : String(error)}`);
    bridge.turnFinished({ ok: false, text: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Read the assistant text and turn outcome produced after `firstSeq`.
 * Mirrors the headless runner's summary of the durable session log.
 */
export function readOutcome(session, firstSeq) {
  let started = false;
  let text = '';
  let reason;
  const length = session.seq;
  for (let seq = firstSeq; seq < length; seq++) {
    const event = session.eventAt(seq);
    if (event === undefined) break;
    if (event.type === 'turn/start') {
      started = true;
      continue;
    }
    if (!started) continue;
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (joined !== '') text = joined;
    }
    if (event.type === 'turn/end') reason = event.data.reason;
  }
  return { text, reason };
}

/**
 * Resolve the key the way other host plugins do: explicit config, then a key
 * file, then the credential service, then the launch environment.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {z.infer<typeof Config>} config
 */
export async function resolveApiKey(ctx, config) {
  if (config.apiKey) return config.apiKey;
  if (config.apiKeyFile) {
    const fromFile = readKeyFile(config.apiKeyFile);
    if (fromFile) return fromFile;
  }
  const ref = config.apiKeyEnv ?? 'OPENAI_API_KEY';
  const credentials = ctx.get?.('credentials');
  if (credentials && typeof credentials.resolve === 'function') {
    try {
      const hit = await credentials.resolve(ref);
      if (hit?.value) return hit.value;
    } catch {
      // fall through to the ambient environment
    }
  }
  try {
    const ambient = launchEnvironmentOf(ctx).get(ref);
    if (ambient?.value) return ambient.value;
  } catch {
    // no launcher snapshot; read the process environment directly
  }
  return process.env[ref] || undefined;
}

/** One-line account of what was said, shown on the voice row. */
function noticeSummary(text, limit = 240) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

function expandHome(path) {
  return path.replace(/^~(?=$|\/)/, homedir());
}

/** Read a one-line key file; absent or unreadable reads as no key. */
export function readKeyFile(path) {
  try {
    return readFileSync(expandHome(path), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

function debugLog(config, line) {
  if (!config.logFile) return;
  try {
    appendFileSync(expandHome(config.logFile), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // diagnostics must never break the route
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

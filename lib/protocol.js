/**
 * GPT-Live wire protocol helpers.
 *
 * GPT-Live is not the Realtime protocol: the socket opens with no query
 * parameters, the client sends `session.start` (model inside the session),
 * and the server answers `session.started`. Every event name used here is
 * taken from OpenAI's Live API and its Microsoft Foundry mirror.
 */

export const LIVE_ENDPOINT = 'wss://api.openai.com/v1/live/sessions';
export const DEFAULT_MODEL = 'gpt-live-1';
export const DEFAULT_VOICE = 'marin';

/** Voices the Live API accepts in `audio.output.voice`. */
export const VOICES = [
  'alloy', 'ash', 'ballad', 'beacon', 'bossa', 'cedar', 'cinder', 'coral',
  'delta', 'echo', 'gleam', 'marin', 'meridian', 'quartz', 'ripple', 'sage',
  'shimmer', 'stone', 'tempo', 'verse', 'vesper', 'willow',
];

/**
 * The voice half's standing orders. The harness is the only thing that can
 * act, so the voice model must never answer a request from its own knowledge
 * or claim an outcome it has not been told.
 */
export const DEFAULT_INSTRUCTIONS = [
  'You are the voice of a coding agent running on this machine.',
  'You can hear and speak continuously, but you cannot run commands, read files, or use tools yourself.',
  'When the user asks for anything that touches files, code, commands, or this machine, delegate the work and keep talking while it runs.',
  'Never claim work was done, and never guess or invent a result. Results arrive later as commentary you should speak aloud.',
  'Progress and context arrive as notes for you only; do not read them aloud.',
  'Keep replies to one or two sentences unless the user asks for detail.',
  'If a request is ambiguous, ask one short clarifying question before delegating.',
].join(' ');

/**
 * Build the `session.start` payload.
 * @param {{model?: string, instructions?: string, voice?: string}} [options]
 */
export function sessionStart(options = {}) {
  const model = options.model ?? DEFAULT_MODEL;
  const instructions = options.instructions ?? DEFAULT_INSTRUCTIONS;
  const voice = options.voice ?? DEFAULT_VOICE;
  return {
    type: 'session.start',
    session: {
      model,
      instructions,
      audio: { output: { voice } },
      delegation: { type: 'client' },
    },
  };
}

/** @param {string} audio base64 PCM16 mono 24 kHz */
export function inputAudio(audio) {
  return { type: 'session.input_audio.append', audio };
}

/**
 * Context for the voice model only: it is injected into the session and is
 * not spoken.
 * @param {{delegationId?: string | null, content: string, eventId?: string}} options
 */
export function thinkingAppend({ delegationId = null, content, eventId }) {
  const event = {
    type: 'session.thinking.append',
    delegation_id: delegationId,
    content,
  };
  if (eventId) event.event_id = eventId;
  return event;
}

/**
 * Text the voice model should say aloud.
 * @param {{delegationId?: string | null, content: string, eventId?: string}} options
 */
export function commentaryAppend({ delegationId = null, content, eventId }) {
  const event = {
    type: 'session.commentary.append',
    delegation_id: delegationId,
    content,
  };
  if (eventId) event.event_id = eventId;
  return event;
}

/**
 * Trusted host instruction, addressed to the session (null delegation) or to
 * one task.
 * @param {{delegationId?: string | null, content: string}} options
 */
export function instructionsAppend({ delegationId = null, content }) {
  return {
    type: 'session.instructions.append',
    delegation_id: delegationId,
    content,
  };
}

export function sessionClose() {
  return { type: 'session.close' };
}

/**
 * Parse one server frame. Returns null for anything that is not a JSON object
 * with a string `type`; never throws.
 * @param {string | Buffer} raw
 */
export function parseEvent(raw) {
  let text;
  if (typeof raw === 'string') text = raw;
  else if (raw && typeof raw.toString === 'function') text = raw.toString('utf8');
  else return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || typeof value.type !== 'string') return null;
  return value;
}

/** @param {any} event */
export function isDelegation(event) {
  return event?.type === 'session.delegation.created'
    && typeof event.delegation?.id === 'string'
    && (event.delegation.target === 'client' || event.delegation.target === undefined);
}

/**
 * A short, log-safe description of a server event. Transcript and audio
 * payloads are reduced to their length so callers can log events without
 * leaking speech.
 * @param {any} event
 */
export function describeEvent(event) {
  switch (event?.type) {
    case 'session.output_audio.delta':
      return `${event.type} ${event.delta?.length ?? 0}b`;
    case 'session.input_transcript.delta':
    case 'session.output_transcript.delta':
      return `${event.type} ${JSON.stringify(event.delta ?? '')}`;
    case 'session.delegation.created':
      return `${event.type} ${event.delegation?.id} -> ${event.delegation?.target}`;
    case 'error':
      return `error ${event.error?.code ?? ''} ${event.error?.message ?? ''}`.trim();
    default:
      return String(event?.type ?? 'unknown');
  }
}

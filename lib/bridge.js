import { isDelegation } from './protocol.js';

/**
 * One live voice session's worth of bridge state.
 *
 * GPT-Live pushes a delegation when it wants the harness to do something, and
 * gives no task text: the request is whatever the user said since the previous
 * delegation. This class owns that mapping — buffer the user's speech, turn it
 * into one task per delegation, run one task at a time, and answer each
 * delegation by id.
 *
 * It is deliberately free of Cordis, WebSocket, and audio concerns so it can be
 * tested on its own.
 */
export class LiveBridge {
  /** @type {string} */
  #buffer = '';
  /** @type {{delegationId: string, text: string, startedAt: number} | null} */
  #inFlight = null;
  /** @type {{delegationId: string, text: string}[]} */
  #queue = [];
  /** @type {Set<string>} */
  #seen = new Set();
  /** @type {{key: string, at: number}[]} */
  #recent = [];
  #closed = false;

  /**
   * @param {object} options
   * @param {(task: {delegationId: string, text: string}) => void} options.dispatch
   * @param {(delegationId: string, content: string) => void} options.commentary
   * @param {(delegationId: string | null, content: string) => void} options.thinking
   * @param {() => number} [options.now]
   * @param {(message: string) => void} [options.log]
   * @param {number} [options.dedupeWindowMs]
   * @param {number} [options.maxBufferChars]
   */
  constructor({ dispatch, commentary, thinking, now = Date.now, log = () => {}, dedupeWindowMs = 60_000, maxBufferChars = 4_000, maxTaskChars = 300 }) {
    this.dispatch = dispatch;
    this.commentary = commentary;
    this.thinking = thinking;
    this.now = now;
    this.log = log;
    this.dedupeWindowMs = dedupeWindowMs;
    this.maxBufferChars = maxBufferChars;
    this.maxTaskChars = maxTaskChars;
  }

  get busy() {
    return this.#inFlight !== null;
  }

  get closed() {
    return this.#closed;
  }

  /** State for the status surface. */
  snapshot() {
    return {
      closed: this.#closed,
      inFlight: this.#inFlight ? { ...this.#inFlight } : null,
      queued: this.#queue.length,
      buffered: this.#buffer.length,
    };
  }

  /**
   * Feed one server event.
   * @param {any} event
   * @returns {'delegation' | 'dispatched' | 'queued' | 'ignored'}
   */
  handleLiveEvent(event) {
    if (this.#closed) return 'ignored';
    switch (event?.type) {
      case 'session.input_transcript.delta':
        if (typeof event.delta === 'string') this.#buffer = (this.#buffer + event.delta).slice(-this.maxBufferChars);
        return 'ignored';
      case 'session.delegation.created':
        return this.#onDelegation(event);
      case 'session.closed':
        this.#closed = true;
        return 'ignored';
      case 'error':
        this.log(`live error: ${event.error?.code ?? ''} ${event.error?.message ?? ''}`.trim());
        return 'ignored';
      default:
        return 'ignored';
    }
  }

  /**
   * Called when the harness turn started from the current task settles.
   * @param {{text?: string, ok?: boolean}} [result]
   */
  turnFinished(result = {}) {
    const task = this.#inFlight;
    this.#inFlight = null;
    if (!task) return;
    if (!this.#closed) {
      const text = result.ok === false
        ? `That failed. ${(result.text ?? '').trim()}`.trim()
        : summarize(result.text ?? '');
      this.commentary(task.delegationId, text || 'That finished, with no output to report.');
    }
    this.#drain();
  }

  #drain() {
    const next = this.#queue.shift();
    if (next) this.#start(next);
  }

  #onDelegation(event) {
    if (!isDelegation(event)) return 'ignored';
    const id = event.delegation.id;
    if (this.#seen.has(id)) return 'ignored';
    this.#seen.add(id);

    const task = this.#takeTask();
    if (!task) {
      this.thinking(id, 'The user asked for nothing actionable in this delegation; stay conversational and do not claim work.');
      return 'ignored';
    }
    if (this.#isDuplicate(task.text)) return 'ignored';

    if (this.#inFlight) {
      this.#queue.push({ delegationId: id, text: task.text, raw: task.raw });
      this.log(`queued delegation ${id}: ${task.text}`);
      return 'queued';
    }
    this.#start({ delegationId: id, text: task.text, raw: task.raw });
    return 'dispatched';
  }

  #start(task) {
    this.#inFlight = { ...task, startedAt: this.now() };
    this.log(`dispatch delegation ${task.delegationId}: ${task.text}`);
    this.thinking(task.delegationId, `Started in the harness: ${task.text}`);
    this.dispatch(task);
  }

  /**
   * Consume the speech since the previous delegation as one task.
   *
   * The buffer can hold unrelated talk that arrived before the request (a TV,
   * another person, the previous sentence). Only the tail of it is the request,
   * so the task is the last `maxTaskChars`, started at a sentence boundary.
   */
  #takeTask() {
    let raw = this.#buffer.replace(/\s+/g, ' ').trim();
    this.#buffer = '';
    let text = raw;
    if (text.length > this.maxTaskChars) {
      const tail = text.slice(-this.maxTaskChars);
      const boundary = tail.search(/[.!?]\s/);
      text = boundary >= 0 ? tail.slice(boundary + 2).trim() : tail.trim();
    }
    if (text.split(' ').filter(Boolean).length < 2) return '';
    return { text, raw };
  }

  #isDuplicate(text) {
    const now = this.now();
    const key = text.toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();
    this.#recent = this.#recent.filter((entry) => now - entry.at < this.dedupeWindowMs);
    if (this.#recent.some((entry) => entry.key === key)) return true;
    this.#recent.push({ key, at: now });
    return false;
  }
}

/**
 * Keep a spoken result short enough for one commentary append.
 * @param {string} text
 * @param {number} [maxChars]
 */
export function summarize(text, maxChars = 1_800) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= maxChars) return flat;
  const cut = flat.slice(0, maxChars);
  const boundary = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  return `${(boundary > maxChars * 0.5 ? cut.slice(0, boundary + 1) : cut).trim()} …`;
}

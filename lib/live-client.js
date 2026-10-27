import WebSocket from 'ws';
import { LIVE_ENDPOINT, parseEvent, sessionStart } from './protocol.js';

/**
 * One GPT-Live WebSocket session.
 *
 * Connects with the API key in the handshake, sends `session.start`, and waits
 * for `session.started` before reporting the session open. Server events are
 * handed to `onEvent` unchanged; this class deliberately interprets almost
 * nothing, so the protocol stays visible in one place.
 */
export class LiveClient {
  #socket = null;
  #opened = false;

  /**
   * @param {object} options
   * @param {string} options.apiKey
   * @param {string} [options.url]
   * @param {string} [options.model]
   * @param {string} [options.instructions]
   * @param {string} [options.voice]
   * @param {(event: any) => void} [options.onEvent]
   * @param {(error: Error) => void} [options.onError]
   * @param {() => void} [options.onClose]
   * @param {number} [options.startTimeoutMs]
   */
  constructor({
    apiKey,
    url = LIVE_ENDPOINT,
    model,
    instructions,
    voice,
    onEvent = () => {},
    onError = () => {},
    onClose = () => {},
    startTimeoutMs = 15_000,
  }) {
    if (!apiKey) throw new Error('live voice: missing OpenAI API key');
    this.apiKey = apiKey;
    this.url = url;
    this.startOptions = { model, instructions, voice };
    this.onEvent = onEvent;
    this.onError = onError;
    this.onClose = onClose;
    this.startTimeoutMs = startTimeoutMs;
  }

  get open() {
    return this.#opened;
  }

  /** Dial, start the session, and resolve once the server confirms. */
  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.close();
        reject(new Error('live voice: session did not start in time'));
      }, this.startTimeoutMs);

      const socket = new WebSocket(this.url, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      this.#socket = socket;

      socket.on('open', () => {
        socket.send(JSON.stringify(sessionStart(this.startOptions)));
      });

      socket.on('message', (raw) => {
        const event = parseEvent(raw);
        if (!event) return;
        if (!settled) {
          if (event.type === 'session.started') {
            settled = true;
            clearTimeout(timer);
            this.#opened = true;
            this.onEvent(event);
            resolve(event.session ?? {});
            return;
          }
          if (event.type === 'error') {
            settled = true;
            clearTimeout(timer);
            this.close();
            reject(new Error(`live voice: ${event.error?.code ?? 'error'}: ${event.error?.message ?? 'session refused'}`));
            return;
          }
        }
        this.onEvent(event);
      });

      socket.on('error', (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
          return;
        }
        this.onError(error);
      });

      socket.on('close', (code, reason) => {
        this.#opened = false;
        this.closeCode = code;
        this.closeReason = reason?.toString?.() ?? '';
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('live voice: socket closed before the session started'));
          return;
        }
        this.onClose({ code, reason: this.closeReason });
      });
    });
  }

  /** @param {object} event */
  send(event) {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) return false;
    this.#socket.send(JSON.stringify(event));
    return true;
  }

  /** @param {string} base64Pcm16 */
  sendAudio(base64Pcm16) {
    return this.send({ type: 'session.input_audio.append', audio: base64Pcm16 });
  }

  close() {
    if (!this.#socket) return;
    const socket = this.#socket;
    this.#socket = null;
    this.#opened = false;
    try {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'session.close' }));
    } catch {
      // closing anyway
    }
    try {
      socket.close();
    } catch {
      // already closed
    }
  }
}

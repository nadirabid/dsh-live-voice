/**
 * Live Voice — browser half.
 *
 * Adds a live-session toggle beside the composer's voice button. While it is
 * on, microphone audio goes to the host's GPT-Live session over the shared
 * `/api` Fetch channel and returned audio plays through a scheduled buffer
 * queue, so speech keeps flowing while the harness works.
 *
 * The transport is Fetch rather than a WebSocket on purpose: the desktop app
 * runs this page on `dsh-app://app`, where only `/api` requests are proxied to
 * the host process (with its auth cookie). A WebSocket cannot be addressed
 * from that origin.
 */
window.__ModuleLoader__.load({
  id: '@nadirabid/dsh-live-voice',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React;
    const h = React.createElement;

    /**
     * Speech as it is decoded, shared by the orb and the dictation strip. The
     * strip shows the words while they arrive; the chat row takes over once a
     * delegation hands the request to the harness.
     */
    const dictation = (() => {
      let state = { active: false, user: '', assistant: '' };
      const listeners = new Set();
      const emit = () => { for (const listener of listeners) listener(); };
      const set = (next) => {
        const merged = { ...state, ...next };
        if (merged.active === state.active && merged.user === state.user && merged.assistant === state.assistant) return;
        state = merged;
        emit();
      };
      return {
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        get: () => state,
        start() { set({ active: true, user: '', assistant: '' }); },
        stop() { set({ active: false, user: '', assistant: '' }); },
        clearUser() { set({ user: '' }); },
        append(role, text) {
          if (typeof text !== 'string' || text === '') return;
          const key = role === 'user' ? 'user' : 'assistant';
          set({ [key]: (state[key] + text).slice(-800) });
        },
      };
    })();

    const CAPTURE_RATE = 24_000;
    const FRAME_SAMPLES = 480; // 20 ms at 24 kHz
    const FLUSH_MS = 100;
    const WORKLET_SOURCE = `
      class LiveVoiceCapture extends AudioWorkletProcessor {
        constructor() { super(); this.frame = new Float32Array(${FRAME_SAMPLES}); this.filled = 0; }
        process(inputs) {
          const channel = inputs[0] && inputs[0][0];
          if (!channel) return true;
          for (let i = 0; i < channel.length; i++) {
            this.frame[this.filled++] = channel[i];
            if (this.filled === this.frame.length) {
              this.port.postMessage(this.frame.slice(0));
              this.filled = 0;
            }
          }
          return true;
        }
      }
      registerProcessor('live-voice-capture', LiveVoiceCapture);
    `;

    async function api(path, body) {
      const response = await fetch(`/api/live-voice${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (response.status === 204) return undefined;
      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      if (!response.ok && !payload?.error) {
        throw new Error(`live voice: ${response.status}`);
      }
      return payload;
    }

    function resample(input, from, to) {
      if (from === to) return input;
      const ratio = from / to;
      const length = Math.max(1, Math.round(input.length / ratio));
      const out = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        const pos = i * ratio;
        const base = Math.floor(pos);
        const frac = pos - base;
        const a = input[base] ?? 0;
        const b = input[Math.min(base + 1, input.length - 1)] ?? a;
        out[i] = a * (1 - frac) + b * frac;
      }
      return out;
    }

    function toPcm16(samples) {
      const pcm = new Int16Array(samples.length);
      for (let i = 0; i < samples.length; i++) {
        const value = Math.max(-1, Math.min(1, samples[i]));
        pcm[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
      }
      return pcm;
    }

    function pcm16ToBase64(pcm) {
      const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      let binary = '';
      const chunk = 0x8000;
      for (let offset = 0; offset < bytes.length; offset += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunk));
      }
      return btoa(binary);
    }

    function base64ToFloat(base64) {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const pcm = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
      const out = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
      return out;
    }

    /** Everything one live session owns, so teardown is one call. */
    function createEngine({ onAudio, onStatus, onTranscript, onError, onClosed }) {
      let liveId = null;
      let audioContext = null;
      let worklet = null;
      let stream = null;
      let source = null;
      let flushTimer = null;
      let pending = [];
      let nextPlaybackAt = 0;
      let stopped = false;
      let polling = false;

      async function start(sessionId) {
        const started = await api('/session', { sessionId });
        if (started?.error) throw new Error(started.error);
        liveId = started.liveId;

        audioContext = new AudioContext();
        await audioContext.resume();
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        const moduleUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
        await audioContext.audioWorklet.addModule(moduleUrl);
        URL.revokeObjectURL(moduleUrl);
        source = audioContext.createMediaStreamSource(stream);
        worklet = new AudioWorkletNode(audioContext, 'live-voice-capture');
        const captureRate = audioContext.sampleRate;
        worklet.port.onmessage = (event) => {
          if (stopped) return;
          pending.push(toPcm16(resample(event.data, captureRate, CAPTURE_RATE)));
        };
        source.connect(worklet);
        const sink = audioContext.createGain();
        sink.gain.value = 0;
        worklet.connect(sink).connect(audioContext.destination);

        flushTimer = setInterval(() => { void flush(); }, FLUSH_MS);
        void poll();
      }

      async function flush() {
        if (stopped || !liveId || pending.length === 0) return;
        const total = pending.reduce((sum, part) => sum + part.length, 0);
        const merged = new Int16Array(total);
        let offset = 0;
        for (const part of pending) {
          merged.set(part, offset);
          offset += part.length;
        }
        pending = [];
        try {
          await api('/audio', { liveId, data: pcm16ToBase64(merged) });
        } catch {
          // a dropped audio chunk is preferable to tearing down the session
        }
      }

      async function poll() {
        if (polling || stopped) return;
        polling = true;
        let failures = 0;
        while (!stopped && liveId) {
          let result;
          try {
            result = await api('/poll', { liveId });
            failures = 0;
          } catch {
            if (stopped) return;
            failures += 1;
            if (failures >= 4) {
              onError('live voice: connection lost');
              await stop('poll-error');
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 800));
            continue;
          }
          if (stopped) return;
          for (const event of result?.events ?? []) handle(event);
          if (result?.closed) {
            await stop('server-closed');
            onClosed('closed');
            return;
          }
        }
        polling = false;
      }

      function handle(message) {
        if (message.type === 'audio') {
          play(message.data);
          onStatus('speaking');
        } else if (message.type === 'ready') {
          onStatus('listening');
        } else if (message.type === 'status') {
          onStatus(message.state === 'thinking' ? 'thinking' : 'listening');
        } else if (message.type === 'transcript') {
          onTranscript(message.role, message.text);
        } else if (message.type === 'error') {
          onError(message.message);
        } else if (message.type === 'closed') {
          void stop();
          onClosed(message.reason);
        }
      }

      function play(base64) {
        if (!audioContext) return;
        const samples = base64ToFloat(base64);
        if (samples.length === 0) return;
        const buffer = audioContext.createBuffer(1, samples.length, CAPTURE_RATE);
        buffer.copyToChannel(samples, 0);
        const player = audioContext.createBufferSource();
        player.buffer = buffer;
        player.connect(audioContext.destination);
        const at = Math.max(audioContext.currentTime + 0.03, nextPlaybackAt);
        player.start(at);
        nextPlaybackAt = at + buffer.duration;
        onAudio();
      }

      async function stop(reason = 'user') {
        if (stopped && !liveId) return;
        stopped = true;
        clearInterval(flushTimer);
        flushTimer = null;
        const id = liveId;
        liveId = null;
        if (id) {
          try { await api('/close', { liveId: id, reason }); } catch {}
        }
        try { worklet?.disconnect(); } catch {}
        try { source?.disconnect(); } catch {}
        worklet = null;
        source = null;
        for (const track of stream?.getTracks() ?? []) track.stop();
        stream = null;
        try { await audioContext?.close(); } catch {}
        audioContext = null;
        pending = [];
        nextPlaybackAt = 0;
      }

      return { start, stop };
    }

    const STATUS_TEXT = {
      connecting: 'Connecting',
      listening: 'Listening',
      thinking: 'Working',
      speaking: 'Speaking',
      error: 'Error',
    };

    const STYLE_ID = 'dsh-live-voice-style';

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
        .lv-orb { transition: transform .12s ease, opacity .12s ease; }
        .lv-orb:hover { transform: scale(1.06); }
        .lv-orb:disabled { opacity: .45; cursor: default; transform: none; }
        .lv-bar {
          transform-box: fill-box; transform-origin: center; transform: scaleY(.62);
        }
        .lv-orb-on .lv-bar { animation: lv-pulse 900ms ease-in-out infinite; }
        .lv-orb-thinking .lv-bar { animation-duration: 1600ms; }
        @keyframes lv-blink {
          0%, 100% { opacity: .25; }
          50% { opacity: 1; }
        }
        @keyframes lv-pulse {
          0%, 100% { transform: scaleY(.35); }
          50% { transform: scaleY(1); }
        }
        @media (prefers-reduced-motion: reduce) {
          .lv-orb-on .lv-bar { animation: none; transform: scaleY(.8); }
        }
      `;
      document.head.append(style);
    }

    function LiveVoice({ sessionId }) {
      const [status, setStatus] = useState('idle');
      const [error, setError] = useState('');
      const engineRef = useRef(null);
      const idleTimer = useRef(null);

      useEffect(() => { ensureStyle(); }, []);

      const settle = useCallback(() => {
        clearTimeout(idleTimer.current);
        idleTimer.current = setTimeout(() => {
          setStatus((current) => (current === 'speaking' ? 'listening' : current));
        }, 600);
      }, []);

      const stop = useCallback(async () => {
        clearTimeout(idleTimer.current);
        const engine = engineRef.current;
        engineRef.current = null;
        setStatus('idle');
        dictation.stop();
        await engine?.stop();
      }, []);

      useEffect(() => () => { void engineRef.current?.stop(); }, []);

      const start = useCallback(async () => {
        if (!sessionId || engineRef.current) return;
        setError('');
        setStatus('connecting');
        dictation.start();
        const engine = createEngine({
          onAudio: () => { setStatus('speaking'); settle(); },
          onStatus: (next) => {
            setStatus(next);
            if (next === 'thinking') dictation.clearUser();
          },
          onTranscript: (role, text) => { dictation.append(role, text); },
          onError: (message) => {
            setError(message);
            setStatus('error');
            dictation.stop();
            const running = engineRef.current;
            engineRef.current = null;
            void running?.stop();
          },
          onClosed: (reason) => {
            engineRef.current = null;
            setStatus('idle');
            dictation.stop();
            setError(`live session ended (${reason})`);
          },
        });
        engineRef.current = engine;
        try {
          await engine.start(sessionId);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setStatus('error');
          engineRef.current = null;
          await engine.stop();
        }
      }, [sessionId, settle]);

      const active = status !== 'idle' && status !== 'error';
      const title = active
        ? 'End live voice session'
        : sessionId ? 'Start live voice session' : 'Open a session first';
      const className = ['lv-orb', active ? 'lv-orb-on' : '', status === 'thinking' ? 'lv-orb-thinking' : '']
        .filter(Boolean).join(' ');

      return h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
        h('span', {
          role: 'button',
          tabIndex: sessionId ? 0 : -1,
          'aria-label': title,
          'aria-disabled': sessionId ? undefined : true,
          title,
          className,
          onClick: () => { if (!sessionId) return; if (active) void stop(); else void start(); },
          onKeyDown: (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            if (!sessionId) return;
            if (active) void stop(); else void start();
          },
          style: {
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 34, height: 34, minWidth: 34, maxWidth: 34, flex: '0 0 auto',
            padding: 0, margin: 0, background: 'transparent', border: 'none',
            boxShadow: 'none', outline: 'none', cursor: sessionId ? 'pointer' : 'default',
            opacity: sessionId ? 1 : 0.45, userSelect: 'none', lineHeight: 0,
          },
        },
        h('svg', {
          width: 34, height: 34, viewBox: '0 0 34 34',
          'aria-hidden': true, style: { display: 'block' },
        },
        h('circle', {
          cx: 17, cy: 17, r: 15.5,
          fill: '#ffffff', stroke: 'rgba(0, 0, 0, 0.12)', strokeWidth: 1,
        }),
        [
          [8.675 + 0 * 3.85, 8],
          [8.675 + 1 * 3.85, 14],
          [8.675 + 2 * 3.85, 20],
          [8.675 + 3 * 3.85, 14],
          [8.675 + 4 * 3.85, 8],
        ].map(([x, height], index) => h('rect', {
          key: index,
          className: 'lv-bar',
          x, y: 17 - height / 2, width: 1.25, height, rx: 0.625,
          fill: '#0d0f12',
          style: { animationDelay: `${index * 90}ms` },
        })))),
        error ? h('span', {
          title: error,
          style: { fontSize: 11, color: '#ff8a8a', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, error) : null);
    }



    const NS = 'live-voice';

    /**
     * The trigger row is a keyed chat-node seat owned by `dsh-client-ui-chat`.
     * This bundle shadows it at priority -1 so voice turns can be titled with
     * the plugin's own name and mark; every other source keeps the same title
     * and icon the core row gives it.
     */
    const TRIGGER_LABELS = {
      en: {
        'trigger.request': 'Execution requested',
        'trigger.goal': 'Continuing goal',
        'trigger.agent': 'Task message received',
        'trigger.team': 'Team message received',
        'trigger.subagent': 'Subtask status updated',
        'trigger.github': 'GitHub event received',
        'trigger.webhook': 'External event received',
        'trigger.schedule': 'Automation task',
        'trigger.job': 'Background task updated',
        'trigger.plugin': 'Plugin status updated',
        'trigger.voice': 'Live Voice',
        'trigger.explanation': 'This notification triggered this response.',
        'trigger.voiceNote': 'Decoded from the microphone. The agent receives the trimmed request.',
      },
      zh: {
        'trigger.request': '收到执行请求',
        'trigger.goal': '继续执行目标',
        'trigger.agent': '收到任务消息',
        'trigger.team': '收到团队消息',
        'trigger.subagent': '子任务状态更新',
        'trigger.github': '收到 GitHub 事件',
        'trigger.webhook': '收到外部事件',
        'trigger.schedule': '自动化任务',
        'trigger.job': '后台任务状态更新',
        'trigger.plugin': '插件状态更新',
        'trigger.voice': '实时语音',
        'trigger.explanation': '这条通知触发了本轮回复。',
        'trigger.voiceNote': '来自麦克风的转写。智能体收到的是修剪后的请求。',
      },
    };

    /**
     * Both voice surfaces sit in wider seats than the chat column — the chat
     * flow item and the full-width composer dock — so each is pinned to the
     * conversation's own content width and centred inside its seat.
     */
    const CHAT_COLUMN = {
      width: '100%',
      maxWidth: 'var(--dsh-chat-content-width, 748px)',
      marginLeft: 'auto',
      marginRight: 'auto',
      boxSizing: 'border-box',
    };

    function triggerIconFor(kind) {
      let icons;
      try {
        icons = require('@deepseek-ai/dsh-client-ui-primitives');
      } catch {
        return null;
      }
      const map = {
        goal: icons.IconGoalOutlineRegular,
        'agent-message': icons.IconPaperPlaneOutlineRegular,
        'team-message': icons.IconAgentPresetOutlineRegular,
        'subagent-settled': icons.IconAgentPresetOutlineRegular,
        webhook: icons.IconGlobeOutlineRegular,
        schedule: icons.IconClockOutlineRegular,
        'tool-jobs': icons.IconQueueOutlineRegular,
        'cordis-host-runner': icons.IconCordisPluginOutlineRegular,
      };
      return map[kind] ?? icons.IconContextInjectionOutlineRegular ?? null;
    }

    function blocksToText(content) {
      if (!Array.isArray(content)) return '';
      return content
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim();
    }

    function clockOf(time) {
      if (typeof time !== 'number' || !Number.isFinite(time)) return '';
      try {
        return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(time));
      } catch {
        return '';
      }
    }

    function VoiceMark({ size = 14 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 34 34', 'aria-hidden': true, style: { display: 'block' } },
        h('circle', { cx: 17, cy: 17, r: 16, fill: '#ffffff', stroke: 'rgba(0,0,0,0.18)', strokeWidth: 1 }),
        [[8.05, 8], [12.15, 14], [16.25, 20], [20.35, 14], [24.45, 8]].map(([x, height], index) => h('rect', {
          key: index, x, y: 17 - height / 2, width: 1.5, height, rx: 0.75, fill: '#0d0f12',
        })));
    }

    /**
     * The voice row's chrome, shared by the committed trigger row and the live
     * dictation preview so the two read as the same component at both stages.
     */
    function voiceRowChildren({ speech, t, time = '', live = false }) {
      const spoken = speech === '' ? null : h('span', {
        key: 'spoken',
        style: live
          ? {
            minWidth: 0, maxWidth: '76%', flex: '0 1 auto',
            fontSize: 12.5, lineHeight: 1.45, opacity: 0.6, textAlign: 'right',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }
          : {
            minWidth: 0, maxWidth: '68%', flex: '0 1 auto',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            fontSize: 12.5, opacity: 0.55, textAlign: 'right',
          },
      }, speech);
      const label = h('span', {
        key: 'label', style: { flex: '0 0 auto', fontSize: 12.5, fontWeight: 500 },
      }, t('trigger.voice'));
      const mark = h('span', {
        key: 'mark', style: { flex: '0 0 auto', display: 'inline-flex', opacity: 0.75 },
      }, h(VoiceMark, { size: 15 }));
      const tail = live
        ? h('span', {
          key: 'tail',
          style: {
            flex: '0 0 auto', width: 6, height: 6, borderRadius: 3,
            background: '#7ad0ff', animation: 'lv-blink 1.2s ease-in-out infinite',
          },
        })
        : h('span', {
          key: 'time',
          style: { flex: '0 0 auto', fontSize: 11, opacity: 0.45, fontVariantNumeric: 'tabular-nums' },
        }, time);
      return [spoken, label, mark, tail].filter(Boolean);
    }

    function TurnTriggerRow({ node, t }) {
      const [open, setOpen] = useState(false);
      const data = node?.data ?? {};
      const source = data.source ?? {};
      const kind = typeof source.kind === 'string' ? source.kind : '';
      const voice = kind === 'cordis-host-runner';
      const speech = voice ? String(source.summary ?? '').replace(/^Voice:\s*/, '') : '';
      const title = voice ? t('trigger.voice') : (
        kind === 'goal' ? t('trigger.goal')
          : kind === 'agent-message' ? t('trigger.agent')
            : kind === 'team-message' ? t('trigger.team')
              : kind === 'subagent-settled' ? t('trigger.subagent')
                : kind === 'webhook' ? (source.provider === 'github' ? t('trigger.github') : t('trigger.webhook'))
                  : kind === 'schedule' ? t('trigger.schedule')
                    : kind === 'tool-jobs' ? t('trigger.job')
                      : kind === 'cordis-host-runner' ? t('trigger.plugin')
                        : t('trigger.request'));
      const Icon = triggerIconFor(kind);
      const time = clockOf(data.time);
      const body = blocksToText(data.content);

      const mark = h('span', { key: 'mark', style: { flex: '0 0 auto', display: 'inline-flex', opacity: 0.75 } },
        voice ? h(VoiceMark, { size: 15 }) : Icon ? h(Icon, { size: 14 }) : null);
      const label = h('span', { key: 'label', style: { flex: '0 0 auto', fontSize: 12.5, fontWeight: 500 } }, title);
      const spoken = speech === '' ? null : h('span', {
        key: 'spoken',
        style: {
          minWidth: 0, maxWidth: voice ? '68%' : undefined,
          flex: voice ? '0 1 auto' : '1 1 auto',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          fontSize: 12.5, opacity: 0.55, textAlign: voice ? 'right' : 'left',
        },
      }, speech);
      const timeNode = h('span', {
        key: 'time',
        style: { flex: '0 0 auto', fontSize: 11, opacity: 0.45, fontVariantNumeric: 'tabular-nums' },
      }, time);
      const chevron = h('span', {
        key: 'chevron',
        style: { flex: '0 0 auto', opacity: 0.45, fontSize: 10, transform: open ? 'rotate(180deg)' : 'none' },
      }, '\u25be');

      // A voice turn reads like the user's own message: right-aligned, speech
      // first, then the mark and title. Every other trigger keeps the core
      // left-aligned arrangement.
      const children = voice
        ? [...voiceRowChildren({ speech, t, time }), chevron]
        : [mark, label, spoken, h('span', { key: 'spacer', style: { flex: '1 1 auto' } }), timeNode, chevron];

      return h('section', { style: { ...CHAT_COLUMN, marginTop: 2, marginBottom: 2 }, 'data-turn-trigger': true },
        h('button', {
          type: 'button',
          'aria-expanded': open,
          onClick: () => setOpen(!open),
          style: {
            display: 'flex', alignItems: 'center', gap: 8, width: '100%',
            justifyContent: voice ? 'flex-end' : 'flex-start',
            padding: '6px 2px', background: 'none', border: 'none', cursor: 'pointer',
            color: 'inherit', font: 'inherit', textAlign: voice ? 'right' : 'left',
          },
        }, children),
        open ? h('div', {
          style: {
            padding: voice ? '2px 23px 10px 0' : '2px 0 10px 23px',
            display: 'grid', gap: 6,
            justifyItems: voice ? 'end' : 'start',
            textAlign: voice ? 'right' : 'left',
          },
        },
        h('div', { style: { fontSize: 11.5, opacity: 0.5 } },
          voice ? t('trigger.voiceNote') : t('trigger.explanation')),
        voice && speech !== '' ? h('div', { style: { fontSize: 12.5, opacity: 0.85 } }, speech) : null,
        body === '' ? null : h('div', { style: { fontSize: 12.5, opacity: 0.7, whiteSpace: 'pre-wrap' } }, body)) : null);
    }


    /**
     * Dictation preview: the same row the turn will become, live. It uses the
     * voice row's chrome — orb, title, right-aligned speech — with a blinking
     * dot where the timestamp goes, and clears when the request dispatches.
     */
    function DictationStrip({ t }) {
      const view = useSyncExternalStore(dictation.subscribe, dictation.get);
      const scroller = useRef(null);
      const text = view.user;

      useEffect(() => {
        const node = scroller.current;
        if (node) node.scrollTop = node.scrollHeight;
      }, [text]);

      if (!view.active || text === '') return null;
      return h('div', {
        ref: scroller,
        style: {
          ...CHAT_COLUMN,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end', gap: 8,
          padding: '6px 2px 8px', maxHeight: 'min(32vh, 240px)', overflowY: 'auto',
        },
      }, voiceRowChildren({ speech: text, t, live: true }));
    }

    /** The plugin's own settings card: paste an OpenAI key, stored host-side. */
    function LiveVoiceSettings({ view }) {
      const [state, setState] = useState(null);
      const [value, setValue] = useState('');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');

      const load = useCallback(async () => {
        try {
          const response = await fetch('/api/live-voice/settings', { credentials: 'same-origin', cache: 'no-store' });
          setState(await response.json());
        } catch {
          setState(null);
        }
      }, []);

      useEffect(() => { void load(); }, [load]);

      const save = useCallback(async () => {
        if (value.trim() === '') return;
        setBusy(true);
        setError('');
        try {
          const response = await fetch('/api/live-voice/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ apiKey: value.trim() }),
            credentials: 'same-origin',
          });
          const result = await response.json();
          if (!response.ok || result.error) throw new Error(result.error ?? `status ${response.status}`);
          setState(result);
          setValue('');
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setBusy(false);
        }
      }, [value]);

      if (view === 'summary') {
        return h('span', null, state?.hasKey ? `API key ${state.hint}` : 'No OpenAI API key yet');
      }

      return h('div', { style: { display: 'grid', gap: 8, padding: '4px 0 12px' } },
        h('div', { style: { fontSize: 12, opacity: 0.75 } },
          state?.hasKey ? `Stored key ${state.hint} · ${state.file}` : 'No key stored. Paste an OpenAI key with GPT-Live access.'),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('input', {
            type: 'password',
            value,
            placeholder: 'sk-...',
            autoComplete: 'off',
            spellCheck: false,
            onChange: (event) => setValue(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') void save(); },
            style: {
              flex: '1 1 280px', height: 30, padding: '0 10px', borderRadius: 8,
              border: '1px solid rgba(128, 140, 160, 0.4)', background: 'transparent',
              color: 'inherit', fontFamily: 'monospace', fontSize: 12,
            },
          }),
          h('button', {
            type: 'button',
            disabled: busy || value.trim() === '',
            onClick: () => { void save(); },
            style: {
              height: 30, padding: '0 14px', borderRadius: 8, cursor: 'pointer',
              border: '1px solid rgba(122, 208, 255, 0.45)', background: 'rgba(122, 208, 255, 0.12)',
              color: 'inherit', fontSize: 12, opacity: busy ? 0.6 : 1,
            },
          }, busy ? 'Saving…' : 'Save key')),
        error ? h('div', { style: { fontSize: 11, color: '#ff8a8a' } }, error) : null);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, TRIGGER_LABELS));
        ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
          name: 'conversation.chat.node',
          key: 'turn-trigger',
          priority: -1,
          locale: NS,
        }, TurnTriggerRow));
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'live-voice-dictation',
          order: 30,
          locale: NS,
        }, DictationStrip));
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'live-voice',
          order: 20,
        }, LiveVoice));
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: '@nadirabid/dsh-live-voice',
        }, LiveVoiceSettings));
      },
    };
  },
});

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { WebSocketServer } from 'ws';

/**
 * End-to-end: the browser's Fetch calls, the host plugin, a mock GPT-Live
 * server, and a fake harness agent. Only the OpenAI service and the harness
 * internals are simulated; every wire between them is the real implementation.
 */

function mockLive() {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const received = [];
  let socket = null;
  const connected = new Promise((resolve) => {
    wss.on('connection', (peer) => {
      socket = peer;
      peer.on('message', (raw) => {
        const event = JSON.parse(raw.toString());
        received.push(event);
        if (event.type === 'session.start') {
          peer.send(JSON.stringify({ type: 'session.started', session: { id: 'sess_test', model: 'gpt-live-1' } }));
          resolve(peer);
        }
      });
    });
  });
  return new Promise((resolve) => {
    http.listen(0, '127.0.0.1', () => {
      const { port } = http.address();
      resolve({
        url: `ws://127.0.0.1:${port}`,
        received,
        connected,
        socket: () => socket,
        close: () => new Promise((done) => { wss.close(); http.close(done); }),
      });
    });
  });
}

function fakeCtx(agent) {
  const routes = new Map();
  const ctx = {
    connection: {
      fetch: {
        register: (route) => {
          routes.set(route.path, route);
          return () => { routes.delete(route.path); };
        },
      },
    },
    sessionController: {
      resolveAgent: async (sessionId) => (sessionId === 's1' ? { agent } : { error: { message: 'no session' } }),
    },
    sessions: { flush: async () => true },
    effect: (fn) => fn(),
    get: () => undefined,
  };
  return { ctx, routes };
}

function fakeAgent(text = 'all green') {
  const events = [];
  const tasks = [];
  let resolveIdle = null;
  const agent = {
    session: {
      get seq() { return events.length; },
      eventAt: (index) => events[index],
    },
    followup(message) {
      tasks.push(message);
      events.push({ type: 'turn/start' });
      setTimeout(() => {
        events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
        events.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
        resolveIdle?.();
      }, 10);
    },
    whenIdle: () => new Promise((resolve) => { resolveIdle = resolve; }),
  };
  return { agent, tasks };
}

async function call(routes, path, body) {
  const route = routes.get(path);
  assert.ok(route, `route ${path} is registered`);
  const response = await route.fetch(new Request(`http://host${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }));
  if (response.status === 204) return { status: 204 };
  return { status: response.status, body: await response.json() };
}

async function get(routes, path) {
  const route = routes.get(path);
  assert.ok(route, `route ${path} is registered`);
  const response = await route.fetch(new Request(`http://host${path}`, { method: 'GET' }));
  return { status: response.status, body: await response.json() };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

test('a delegation runs one harness turn and answers the delegation id', async () => {
  const live = await mockLive();
  const { agent, tasks } = fakeAgent('340 passed.');
  const { ctx, routes } = fakeCtx(agent);
  const { apply } = await import('../lib/index.js');
  apply(ctx, { apiKey: 'sk-test', endpoint: live.url, instructions: 'be brief' });

  const started = await call(routes, '/api/live-voice/session', { sessionId: 's1' });
  assert.equal(started.status, 200);
  const liveId = started.body.liveId;
  assert.ok(liveId);

  const first = await call(routes, '/api/live-voice/poll', { liveId });
  assert.ok(first.body.events.some((event) => event.type === 'ready'));

  const liveSocket = await live.connected;
  await call(routes, '/api/live-voice/audio', { liveId, data: 'BBBB' });
  await waitFor(() => live.received.some((event) => event.type === 'session.input_audio.append' && event.audio === 'BBBB'));
  assert.ok(live.received.some((event) => event.type === 'session.input_audio.append' && event.audio === 'BBBB'));

  liveSocket.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'run the tests' }));
  liveSocket.send(JSON.stringify({
    type: 'session.delegation.created',
    delegation: { id: 'd1', type: 'delegation', target: 'client' },
  }));

  const second = await call(routes, '/api/live-voice/poll', { liveId });
  const thinking = second.body.events.find((event) => event.type === 'status');
  assert.equal(thinking.state, 'thinking');

  await waitFor(() => tasks.length === 1);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].content[0].text, 'run the tests');
  assert.equal(tasks[0].source.form, 'notice');
  assert.equal(tasks[0].source.kind, 'cordis-host-runner');
  assert.match(tasks[0].source.summary, /^Voice: run the tests$/);

  await waitFor(() => live.received.some((event) => event.type === 'session.commentary.append'));
  const commentary = live.received.find((event) => event.type === 'session.commentary.append');
  assert.equal(commentary.delegation_id, 'd1');
  assert.equal(commentary.content, '340 passed.');
  assert.ok(live.received.some((event) => event.type === 'session.thinking.append'));

  await call(routes, '/api/live-voice/close', { liveId });
  await live.close();
});

test('a session request without a session id is refused', async () => {
  const live = await mockLive();
  const { agent } = fakeAgent();
  const { ctx, routes } = fakeCtx(agent);
  const { apply } = await import('../lib/index.js');
  apply(ctx, { apiKey: 'sk-test', endpoint: live.url });

  const response = await call(routes, '/api/live-voice/session', {});
  assert.equal(response.status, 400);
  assert.match(response.body.error, /session id/);
  await live.close();
});

test('a missing key is reported instead of dialling', async () => {
  const live = await mockLive();
  const { agent } = fakeAgent();
  const { ctx, routes } = fakeCtx(agent);
  const { apply } = await import('../lib/index.js');
  apply(ctx, { endpoint: live.url });

  const response = await call(routes, '/api/live-voice/session', { sessionId: 's1' });
  assert.equal(response.status, 503);
  assert.match(response.body.error, /API key/);
  await live.close();
});

test('an unknown live id does not reach the model', async () => {
  const live = await mockLive();
  const { agent } = fakeAgent();
  const { ctx, routes } = fakeCtx(agent);
  const { apply } = await import('../lib/index.js');
  apply(ctx, { apiKey: 'sk-test', endpoint: live.url });

  const audio = await call(routes, '/api/live-voice/audio', { liveId: 'nope', data: 'AAAA' });
  assert.equal(audio.status, 404);
  const poll = await call(routes, '/api/live-voice/poll', { liveId: 'nope' });
  assert.equal(poll.status, 404);
  await live.close();
});

test('readOutcome reports the last assistant text and the turn reason', async () => {
  const { readOutcome } = await import('../lib/index.js');
  const events = [
    { type: 'turn/start' },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'first' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'final answer' }] } } },
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ];
  const session = { get seq() { return events.length; }, eventAt: (index) => events[index] };
  assert.deepEqual(readOutcome(session, 0), { text: 'final answer', reason: { kind: 'completed' } });
});
;
;

test('the settings route stores the key and echoes it back', async () => {
  const { mkdtempSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'live-voice-'));
  const keyFile = join(dir, 'openai.key');

  const live = await mockLive();
  const { agent } = fakeAgent();
  const { ctx, routes } = fakeCtx(agent);
  const { apply } = await import('../lib/index.js');
  apply(ctx, { endpoint: live.url, apiKeyFile: keyFile, apiKeyEnv: 'LIVE_VOICE_TEST_MISSING' });

  const empty = await get(routes, '/api/live-voice/settings');
  assert.equal(empty.body.hasKey, false);

  const saved = await call(routes, '/api/live-voice/settings', { apiKey: 'sk-test-abcdefgh1234' });
  assert.equal(saved.body.hasKey, true);
  assert.equal(saved.body.key, 'sk-test-abcdefgh1234');
  assert.equal(saved.body.hint, 'sk-test…1234');
  assert.equal(readFileSync(keyFile, 'utf8'), 'sk-test-abcdefgh1234');
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);

  const again = await get(routes, '/api/live-voice/settings');
  assert.equal(again.body.key, 'sk-test-abcdefgh1234');
  await live.close();
});

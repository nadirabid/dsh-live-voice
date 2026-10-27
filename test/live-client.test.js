import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { LiveClient } from '../lib/live-client.js';

async function mockLiveServer() {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const received = [];
  let auth = null;
  const started = new Promise((resolve) => {
    wss.on('connection', (socket, request) => {
      auth = request.headers.authorization;
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString());
        received.push(event);
        if (event.type === 'session.start') {
          socket.send(JSON.stringify({
            type: 'session.started',
            session: { id: 'sess_test', model: event.session.model },
          }));
          resolve(socket);
        }
      });
    });
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address();
  return {
    url: `ws://127.0.0.1:${port}`,
    received,
    started,
    auth: () => auth,
    close: () => new Promise((resolve) => { wss.close(); http.close(resolve); }),
  };
}

test('connects with the API key and starts a client-delegation session', async () => {
  const server = await mockLiveServer();
  const events = [];
  const client = new LiveClient({
    apiKey: 'sk-test',
    url: server.url,
    onEvent: (event) => events.push(event),
  });
  const session = await client.connect();
  assert.equal(server.auth(), 'Bearer sk-test');
  assert.equal(session.id, 'sess_test');
  const start = server.received.find((event) => event.type === 'session.start');
  assert.equal(start.session.model, 'gpt-live-1');
  assert.deepEqual(start.session.delegation, { type: 'client' });
  assert.equal(events[0].type, 'session.started');
  client.close();
  await server.close();
});

test('round-trips audio and server events', async () => {
  const server = await mockLiveServer();
  const events = [];
  const client = new LiveClient({
    apiKey: 'sk-test',
    url: server.url,
    onEvent: (event) => events.push(event),
  });
  await client.connect();
  const socket = await server.started;

  assert.equal(client.sendAudio('AAAA'), true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const audio = server.received.find((event) => event.type === 'session.input_audio.append');
  assert.equal(audio.audio, 'AAAA');

  socket.send(JSON.stringify({
    type: 'session.delegation.created',
    delegation: { id: 'd1', type: 'delegation', target: 'client' },
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const delegation = events.find((event) => event.type === 'session.delegation.created');
  assert.equal(delegation.delegation.id, 'd1');

  client.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(server.received.some((event) => event.type === 'session.close'));
  await server.close();
});

test('a refused session rejects connect', async () => {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  wss.on('connection', (socket) => {
    socket.on('message', () => {
      socket.send(JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', code: 'model_not_found', message: 'no such model' },
      }));
    });
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address();
  const client = new LiveClient({ apiKey: 'sk-test', url: `ws://127.0.0.1:${port}` });
  await assert.rejects(client.connect(), /model_not_found/);
  await new Promise((resolve) => { wss.close(); http.close(resolve); });
});

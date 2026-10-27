import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveBridge, summarize } from '../lib/bridge.js';
import {
  DEFAULT_MODEL, DEFAULT_VOICE, isDelegation, parseEvent, sessionStart,
} from '../lib/protocol.js';

function setup(options = {}) {
  const calls = { dispatched: [], commentary: [], thinking: [] };
  const bridge = new LiveBridge({
    dispatch: (task) => calls.dispatched.push(task),
    commentary: (id, content) => calls.commentary.push({ id, content }),
    thinking: (id, content) => calls.thinking.push({ id, content }),
    now: options.now ?? (() => 1_000),
    dedupeWindowMs: options.dedupeWindowMs,
    log: () => {},
  });
  return { bridge, calls };
}

function say(bridge, text) {
  bridge.handleLiveEvent({ type: 'session.input_transcript.delta', delta: text });
}

function delegate(bridge, id, target = 'client') {
  return bridge.handleLiveEvent({
    type: 'session.delegation.created',
    delegation: { id, type: 'delegation', target },
  });
}

test('a delegation dispatches the speech that preceded it', () => {
  const { bridge, calls } = setup();
  say(bridge, 'check ');
  say(bridge, 'the build');
  assert.equal(delegate(bridge, 'd1'), 'dispatched');
  assert.deepEqual(calls.dispatched, [{ delegationId: 'd1', text: 'check the build', raw: 'check the build' }]);
  assert.equal(bridge.busy, true);
});

test('speech is consumed by a delegation, so the next one starts fresh', () => {
  const { bridge, calls } = setup();
  say(bridge, 'run the tests');
  delegate(bridge, 'd1');
  bridge.turnFinished({ text: 'all green' });
  say(bridge, 'now lint');
  delegate(bridge, 'd2');
  assert.deepEqual(calls.dispatched.map((task) => task.text), ['run the tests', 'now lint']);
});

test('an empty or one-word delegation is answered with a quiet note, not a task', () => {
  const { bridge, calls } = setup();
  say(bridge, 'yes');
  assert.equal(delegate(bridge, 'd1'), 'ignored');
  assert.equal(calls.dispatched.length, 0);
  assert.equal(calls.thinking.length, 1);
  assert.equal(calls.thinking[0].id, 'd1');
});

test('a repeated delegation id never runs twice', () => {
  const { bridge, calls } = setup();
  say(bridge, 'run the tests');
  delegate(bridge, 'd1');
  bridge.turnFinished({ text: 'green' });
  say(bridge, 'run the tests');
  assert.equal(delegate(bridge, 'd1'), 'ignored');
  assert.equal(calls.dispatched.length, 1);
});

test('the same request repeated inside the dedupe window is dropped', () => {
  const { bridge, calls } = setup();
  say(bridge, 'run the tests');
  delegate(bridge, 'd1');
  bridge.turnFinished({ text: 'green' });
  say(bridge, 'run the tests');
  assert.equal(delegate(bridge, 'd2'), 'ignored');
  assert.equal(calls.dispatched.length, 1);
});

test('a delegation arriving while one runs is queued, then dispatched', () => {
  const { bridge, calls } = setup();
  say(bridge, 'run the tests');
  delegate(bridge, 'd1');
  say(bridge, 'also check the flaky one');
  assert.equal(delegate(bridge, 'd2'), 'queued');
  assert.equal(calls.dispatched.length, 1);
  bridge.turnFinished({ text: 'green' });
  assert.deepEqual(calls.dispatched.map((task) => task.delegationId), ['d1', 'd2']);
});

test('the result is answered against the delegation that asked for it', () => {
  const { bridge, calls } = setup();
  say(bridge, 'run the tests');
  delegate(bridge, 'd1');
  bridge.turnFinished({ text: '340 passed, 2 skipped.' });
  assert.deepEqual(calls.commentary, [{ id: 'd1', content: '340 passed, 2 skipped.' }]);
  assert.equal(bridge.busy, false);
});

test('a failed turn is reported as failed, not as output', () => {
  const { bridge, calls } = setup();
  say(bridge, 'run the tests');
  delegate(bridge, 'd1');
  bridge.turnFinished({ ok: false, text: 'command exited 1' });
  assert.equal(calls.commentary[0].content, 'That failed. command exited 1');
});

test('a closed live session stops answering', () => {
  const { bridge, calls } = setup();
  say(bridge, 'run the tests');
  delegate(bridge, 'd1');
  bridge.handleLiveEvent({ type: 'session.closed', reason: 'close_requested' });
  bridge.turnFinished({ text: 'green' });
  assert.equal(calls.commentary.length, 0);
  assert.equal(bridge.closed, true);
});

test('responses-targeted delegations are not client tasks', () => {
  const { bridge, calls } = setup();
  say(bridge, 'run the tests');
  delegate(bridge, 'd1', 'responses');
  assert.equal(calls.dispatched.length, 0);
});

test('summarize keeps short results intact and trims long ones', () => {
  assert.equal(summarize('  all   green '), 'all green');
  const long = `${'x'.repeat(50)}. ${'y'.repeat(50)}.`;
  assert.ok(summarize(long, 60).endsWith('…'));
});

test('session.start carries the model, voice, and client delegation', () => {
  const start = sessionStart();
  assert.equal(start.type, 'session.start');
  assert.equal(start.session.model, DEFAULT_MODEL);
  assert.equal(start.session.audio.output.voice, DEFAULT_VOICE);
  assert.deepEqual(start.session.delegation, { type: 'client' });
});

test('parseEvent rejects junk and accepts frames', () => {
  assert.equal(parseEvent('not json'), null);
  assert.equal(parseEvent('{"no":"type"}'), null);
  assert.deepEqual(parseEvent('{"type":"session.started"}'), { type: 'session.started' });
});

test('isDelegation requires a client-targeted id', () => {
  assert.equal(isDelegation({ type: 'session.delegation.created', delegation: { id: 'd1' } }), true);
  assert.equal(isDelegation({ type: 'session.delegation.created', delegation: { id: 'd1', target: 'responses' } }), false);
  assert.equal(isDelegation({ type: 'session.delegation.created' }), false);
});

test('unrelated leading talk is dropped from the task', () => {
  const { bridge, calls } = setup();
  say(bridge, `${'blah '.repeat(80)}. Can you check whether this conversation is logged?`);
  delegate(bridge, 'd1');
  assert.equal(calls.dispatched[0].text, 'Can you check whether this conversation is logged?');
});

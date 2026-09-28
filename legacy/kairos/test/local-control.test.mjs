import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createControlServer, parseLocalInstruction, validateGroundedGoal } from '../local-control.mjs';

const observation = { sequence: 7, self: { position: [1, 5, 3], yaw: 0, pitch: 0, properties: {} } };
const goal = () => ({ version: 'GroundedGoalV1', id: 'user-goal', expression: { kind: 'predicate', predicate: {
  version: 'GoalPredicateV1', id: 'x', subject: { kind: 'self' }, observable: 'position.0',
  comparator: 'within', lower: 2, upper: 2.2,
} } });

test('goal boundary rejects invalid algebra, duplicate predicates and non-finite values', () => {
  assert.deepEqual(validateGroundedGoal(goal()), goal());
  for (const mutate of [
    g => { g.expression.predicate.lower = Infinity; },
    g => { g.expression.predicate.lower = 3; },
    g => { g.expression.predicate.comparator = 'execute'; },
    g => { g.expression.predicate.observable = 'properties.constructor'; },
    g => { g.expression.predicate.observable = 'blockAt(6,7,0)'; },
    g => { g.expression.predicate.subject = { kind: 'server' }; },
    g => { g.expression.predicate.action = 'jump'; },
    g => { g.expression = { kind: 'all', children: [g.expression, structuredClone(g.expression)] }; },
    g => { g.expression = { kind: 'any', children: [] }; },
    g => { for (let i = 0; i < 10; i++) g.expression = { kind: 'all', children: [g.expression] }; },
  ]) {
    const g = goal(); mutate(g); assert.throws(() => validateGroundedGoal(g), { statusCode: 422 });
  }
  const detached = validateGroundedGoal(goal()); detached.expression.predicate.lower = -100;
  assert.equal(goal().expression.predicate.lower, 2);
});

test('local text grammar anchors goals to measured position and the current core yaw convention', () => {
  const forward = parseLocalInstruction('向前移动1米', observation);
  const [x, z] = forward.expression.children.map(value => value.predicate);
  assert.equal((x.lower + x.upper) / 2, 1);
  assert.equal((z.lower + z.upper) / 2, 2);
  const rightFacing = parseLocalInstruction('向前移动2米', { ...observation, self: { ...observation.self, yaw: Math.PI / 2 } });
  assert.equal(rightFacing.expression.children[0].predicate.lower, -1.2);
  const absolute = parseLocalInstruction('到 x=2', null);
  assert.equal(absolute.expression.predicate.lower, 1.8);
  const jump = parseLocalInstruction('跳高0.5米', observation);
  assert.equal(jump.expression.predicate.target, 5.5);
  assert.equal(jump.expression.predicate.observable, 'position.1');
  assert.throws(() => parseLocalInstruction('把箱子摞两层', observation), { statusCode: 422, code: 'unsupported-instruction' });
  assert.throws(() => parseLocalInstruction('向前移动1米', null), { statusCode: 409 });
  assert.throws(() => parseLocalInstruction('向前移动1米', { ...observation, predictionSupport: [] }), { statusCode: 409 });
  assert.throws(() => parseLocalInstruction('向前移动0米', observation), { statusCode: 422 });
  assert.throws(() => parseLocalInstruction('向前移动65米', observation), { statusCode: 422 });
});

test('loopback API validates all input before submitting, reports queue results, and survives malformed input', async t => {
  const submitted = [], pauses = [];
  const server = await createControlServer({ port: 0, getStatus: () => ({ observation, ready: true }),
    submit: value => { if (submitted.some(item => item.id === value.id)) throw new Error('duplicate-session-goal'); submitted.push(value); },
    pause: value => pauses.push(value),
  });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, headers = {}) => fetch(base + route, { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  assert.equal((await fetch(base + '/status')).status, 200);
  assert.equal((await fetch(base + '/state')).status, 200);
  assert.equal((await post('/goals', '{broken')).status, 400);
  assert.equal((await post('/goals', '[]')).status, 400);
  assert.equal((await post('/goals', { goal: goal() }, { origin: 'https://evil.example' })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/goals', method: 'POST',
      headers: { host: `evil.example:${server.address().port}`, 'content-type': 'application/json' } },
    res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end(JSON.stringify({ goal: goal() }));
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await post('/goals', { goal: goal() }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post('/goals', { goal: goal() }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post('/goals', { goal: goal(), action: 'jump' })).status, 422);
  assert.equal((await post('/goals', JSON.stringify({ goal: goal() }).replace('"lower":2', '"lower":1e309'))).status, 422);
  assert.equal((await post('/instruct', { text: '清空堆垛' })).status, 422);
  assert.equal((await post('/instruct', { text: 123 })).status, 422);
  assert.equal((await post('/instruct', { text: '中'.repeat(3000) })).status, 413);
  assert.equal(submitted.length, 0);
  const accepted = await post('/goals', { goal: goal() }, { origin: base });
  assert.equal(accepted.status, 202); assert.deepEqual((await accepted.json()).goal, goal());
  assert.equal((await post('/goals', { goal: goal() })).status, 409);
  assert.equal((await post('/instruct', { text: '向前移动1米' })).status, 202);
  assert.equal(submitted.length, 2);
  assert.equal((await post('/pause', {})).status, 200);
  assert.equal((await post('/pause', { paused: true })).status, 200);
  assert.equal((await post('/pause', { paused: false })).status, 422);
  assert.deepEqual(pauses, [true, true]);
  assert.equal((await post('/pause', { paused: 'false' })).status, 422);
  assert.equal((await fetch(base + '/goals')).status, 405);
  assert.equal((await fetch(base + '/missing')).status, 404);
  assert.equal((await fetch(base + '/status')).status, 200);
});

test('chunked requests enforce the byte limit without invoking submission', async t => {
  let submits = 0;
  const server = await createControlServer({ port: 0, getStatus: () => ({}), submit: () => { submits++; }, pause: () => {} });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/goals', method: 'POST',
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.write(' '.repeat(5000)); req.end(' '.repeat(4000));
  });
  assert.equal(status, 413); assert.equal(submits, 0);
});

test('capacity and shutdown errors stay machine-readable, and non-loopback binding is rejected', async t => {
  await assert.rejects(createControlServer({ host: '0.0.0.0', getStatus: () => ({}), submit: () => {}, pause: () => {} }), /loopback/u);
  let failure = 'pending-goal-capacity-exceeded';
  const server = await createControlServer({ port: 0, getStatus: () => ({}),
    submit: () => { throw new Error(failure); }, pause: () => {} });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/goals`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: goal() }) });
  assert.equal(res.status, 429); assert.equal((await res.json()).error, 'pending-goal-capacity-exceeded');
  failure = 'session-pausing';
  const stopped = await fetch(`http://127.0.0.1:${server.address().port}/goals`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: goal() }) });
  assert.equal(stopped.status, 503); assert.equal((await stopped.json()).error, 'session-pausing');
});

import http from 'node:http';
import { randomUUID } from 'node:crypto';

const MAX_BODY_BYTES = 8 * 1024;
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const FORBIDDEN_NAMES = new Set(['__proto__', 'prototype', 'constructor']);
const OBSERVABLES = new Set(['position.0', 'position.1', 'position.2', 'yaw', 'pitch',
  'type', 'visible', 'relativePosition.0', 'relativePosition.1', 'relativePosition.2', 'relativeDistance']);

export class ControlError extends Error {
  constructor(statusCode, code, message = code) {
    super(message); this.statusCode = statusCode; this.code = code;
  }
}

function invalid(message) { throw new ControlError(422, 'invalid-goal', message); }
function record(value, name, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(`${name} must be an object`);
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key)))
    invalid(`${name} has missing or unsupported fields`);
}
function string(value, name, limit = 128) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u001f]/u.test(value))
    invalid(`${name} must be a nonempty string of at most ${limit} characters`);
}
function number(value, name, minimum = -Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) invalid(`${name} must be finite and >= ${minimum}`);
}

/** Validate the public goal algebra only. Goals contain no motor commands or learned effects. */
export function validateGroundedGoal(goal) {
  record(goal, 'goal', ['version', 'id', 'expression']);
  if (goal.version !== 'GroundedGoalV1') invalid('unsupported goal version');
  string(goal.id, 'goal.id');
  const ids = new Set();
  let nodes = 0;
  function expression(value, depth = 0) {
    if (++nodes > 64 || depth > 8) invalid('goal expression exceeds 64 nodes or depth 8');
    if (value?.kind === 'all' || value?.kind === 'any') {
      record(value, 'expression', ['kind', 'children']);
      if (!Array.isArray(value.children) || value.children.length === 0 || value.children.length > 32)
        invalid('all/any requires 1 to 32 children');
      for (const child of value.children) expression(child, depth + 1);
      return;
    }
    record(value, 'expression', ['kind', 'predicate']);
    if (value.kind !== 'predicate') invalid('unsupported expression kind');
    const p = value.predicate;
    const fields = {
      equals: ['target'], 'not-equals': ['target'], 'greater-than': ['target', 'tolerance'],
      'less-than': ['target', 'tolerance'], within: ['lower', 'upper'], increase: ['minimumDelta'], decrease: ['minimumDelta'],
    };
    if (!p || !Object.hasOwn(fields, p.comparator)) invalid('unsupported comparator');
    const base = ['version', 'id', 'subject', 'observable', 'comparator'];
    record(p, 'predicate', [...base, 'residualScale', ...fields[p.comparator]],
      [...base, ...fields[p.comparator].filter(key => key !== 'tolerance')]);
    if (p.version !== 'GoalPredicateV1') invalid('unsupported predicate version');
    string(p.id, 'predicate.id');
    if (ids.has(p.id)) invalid('duplicate predicate id');
    ids.add(p.id);
    if (p.subject?.kind === 'public-object') {
      record(p.subject, 'subject', ['kind', 'id', 'expectedType']);
      string(p.subject.id, 'subject.id'); string(p.subject.expectedType, 'subject.expectedType');
    } else {
      record(p.subject, 'subject', ['kind']);
      if (!['self', 'crosshair'].includes(p.subject.kind)) invalid('unsupported subject kind');
    }
    const property = typeof p.observable === 'string' && /^properties\.([A-Za-z][A-Za-z0-9_]{0,63})$/u.exec(p.observable);
    if (!OBSERVABLES.has(p.observable) && (!property || FORBIDDEN_NAMES.has(property[1]))) invalid('unsupported observable');
    if (p.subject.kind === 'self' && p.observable.startsWith('relative')) invalid('self has no relative position observable');
    if (p.subject.kind !== 'self' && (p.observable.startsWith('position.') || ['yaw', 'pitch'].includes(p.observable)))
      invalid('only self exposes position/yaw/pitch');
    if (p.residualScale !== undefined) { number(p.residualScale, 'residualScale', Number.MIN_VALUE); }
    if (p.comparator === 'equals' || p.comparator === 'not-equals') {
      if (p.target !== null && !['string', 'number', 'boolean'].includes(typeof p.target)) invalid('target must be a public scalar');
      if (typeof p.target === 'number') number(p.target, 'target');
      if (typeof p.target === 'string' && (p.target.length > 256 || /[\u0000-\u001f]/u.test(p.target))) invalid('invalid string target');
      if (p.observable === 'visible' && typeof p.target !== 'boolean') invalid('visible target must be boolean');
      if (p.observable === 'type' && p.target !== null && typeof p.target !== 'string') invalid('type target must be string or null');
      if (!property && !['visible', 'type'].includes(p.observable)) number(p.target, 'numeric observable target');
    } else {
      if (['visible', 'type'].includes(p.observable)) invalid('numeric comparator requires a numeric observable');
      if (p.comparator === 'within') {
        number(p.lower, 'lower'); number(p.upper, 'upper');
        if (p.lower > p.upper) invalid('lower must not exceed upper');
      } else if (['increase', 'decrease'].includes(p.comparator)) {
        number(p.minimumDelta, 'minimumDelta', Number.MIN_VALUE);
      } else {
        number(p.target, 'target');
        if (p.tolerance !== undefined) number(p.tolerance, 'tolerance', 0);
      }
    }
  }
  expression(goal.expression);
  return structuredClone(goal);
}

const NUM = '([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+))';
const absolutePattern = new RegExp(`^(?:到|走到)\\s*([xyz])\\s*=\\s*${NUM}\\s*(?:米)?[。！!]?\u0024`, 'iu');
const forwardPattern = new RegExp(`^向前(?:移动|走)\\s*${NUM}\\s*米[。！!]?\u0024`, 'u');
const jumpPattern = new RegExp(`^(?:跳高|升高)\\s*${NUM}\\s*米[。！!]?\u0024`, 'u');

/** Explicit local grammar, not a general natural-language or box-task interpreter. */
export function parseLocalInstruction(text, observation) {
  if (typeof text !== 'string' || !text.trim() || text.length > 256)
    throw new ControlError(422, 'invalid-instruction', 'text 必须是 1 到 256 字符的指令');
  const input = text.trim();
  const id = `local-${randomUUID()}`;
  const predicate = (axis, lower, upper, suffix = axis) => ({ kind: 'predicate', predicate: {
    version: 'GoalPredicateV1', id: `${id}-${suffix}`, subject: { kind: 'self' },
    observable: `position.${axis}`, comparator: 'within', lower, upper,
  } });
  const absolute = absolutePattern.exec(input);
  if (absolute) {
    const axis = 'xyz'.indexOf(absolute[1].toLowerCase()), target = Number(absolute[2]);
    return validateGroundedGoal({ version: 'GroundedGoalV1', id, expression: predicate(axis, target - .2, target + .2) });
  }
  const forward = forwardPattern.exec(input), jump = jumpPattern.exec(input);
  if (!forward && !jump) throw new ControlError(422, 'unsupported-instruction',
    '本地语法仅支持“到 x=2”（或 y/z）、“向前移动1米”、“跳高0.5米”。箱子、堆垛、物品和先后步骤尚无接地支持；请使用明确的 GroundedGoalV1。');
  const self = observation?.self;
  if (!self || !Array.isArray(self.position) || self.position.length !== 3 || !self.position.every(Number.isFinite)
    || (forward && !Number.isFinite(self.yaw)) || observation.predictionSupport !== undefined || observation.predictionBounds !== undefined)
    throw new ControlError(409, 'observation-unavailable', '相对目标需要当前实际观测中的位置和朝向');
  const distance = Number((forward ?? jump)[1]);
  if (!Number.isFinite(distance) || distance <= 0 || distance > 64)
    throw new ControlError(422, 'invalid-distance', '相对距离必须大于 0 且不超过 64 米');
  if (jump) {
    // A measurable height target; the core still chooses and verifies its own motor actions.
    return validateGroundedGoal({ version: 'GroundedGoalV1', id, expression: { kind: 'predicate', predicate: {
      version: 'GoalPredicateV1', id: `${id}-height`, subject: { kind: 'self' }, observable: 'position.1',
      comparator: 'greater-than', target: self.position[1] + distance, tolerance: 1e-6,
    } } });
  }
  const targets = [self.position[0] - Math.sin(self.yaw) * distance, self.position[2] - Math.cos(self.yaw) * distance];
  const tolerance = Math.min(.2, distance / 4);
  return validateGroundedGoal({ version: 'GroundedGoalV1', id, expression: { kind: 'all', children: [
    predicate(0, targets[0] - tolerance, targets[0] + tolerance),
    predicate(2, targets[1] - tolerance, targets[1] + tolerance),
  ] } });
}

async function readBody(req) {
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    req.resume(); throw new ControlError(413, 'body-too-large', 'request body limit is 8 KiB');
  }
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    req.resume(); throw new ControlError(415, 'json-content-type-required');
  }
  return new Promise((resolve, reject) => {
    let bytes = 0, chunks = [], rejected = false;
    req.on('data', chunk => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        rejected = true; chunks = []; reject(new ControlError(413, 'body-too-large', 'request body limit is 8 KiB'));
      } else chunks.push(chunk);
    });
    req.once('aborted', () => reject(new ControlError(400, 'request-aborted')));
    req.once('error', reject);
    req.once('end', () => {
      if (rejected) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
        resolve(body);
      } catch { reject(new ControlError(400, 'invalid-json', 'body must be a JSON object')); }
    });
  });
}

function localAuthority(authority, port) {
  if (typeof authority !== 'string') return false;
  try {
    const parsed = new URL(`http://${authority}`);
    return !parsed.username && !parsed.password && parsed.pathname === '/' && !parsed.search && !parsed.hash
      && LOOPBACK_NAMES.has(parsed.hostname) && Number(parsed.port || 80) === port;
  } catch { return false; }
}
function checkRequestOrigin(req, port) {
  if (!localAuthority(req.headers.host, port)) throw new ControlError(403, 'invalid-host');
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new ControlError(403, 'cross-site-request');
  const origin = req.headers.origin;
  if (origin === undefined) return; // Native game clients and local CLI requests have no browser origin.
  try {
    const parsed = new URL(origin);
    if (parsed.protocol === 'http:' && parsed.origin === origin && localAuthority(parsed.host, port)) return;
  } catch { /* Reject malformed origins, including opaque/null. */ }
  throw new ControlError(403, 'invalid-origin');
}
function invokeSync(fn, ...args) {
  const result = fn(...args);
  if (result && typeof result.then === 'function') {
    Promise.resolve(result).catch(() => {});
    throw new Error('control callbacks must be synchronous; run session.step only in the agent loop');
  }
  return result;
}
function errorResponse(error) {
  if (error instanceof ControlError) return { status: error.statusCode, code: error.code, message: error.message };
  const message = error instanceof Error ? error.message : 'control request failed';
  if (message === 'duplicate-session-goal') return { status: 409, code: message, message };
  if (message === 'pending-goal-capacity-exceeded') return { status: 429, code: message, message };
  if (['session-pausing', 'session-offline', 'session-not-ready'].includes(message)) return { status: 503, code: message, message };
  if (Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 600)
    return { status: error.statusCode, code: error.code ?? 'control-rejected', message };
  return { status: 500, code: 'control-error', message };
}

/** The API queues goals and toggles pause only. The owner serializes all body actions. */
export async function createControlServer({ getStatus, submit, pause, port = 3008, host = '127.0.0.1' }) {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('control server must bind to loopback');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid control port');
  if ([getStatus, submit, pause].some(fn => typeof fn !== 'function')) throw new Error('control callbacks are required');
  const server = http.createServer(async (req, res) => {
    const send = (status, value) => {
      if (res.destroyed || res.writableEnded) return;
      const body = JSON.stringify(value);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    };
    try {
      checkRequestOrigin(req, server.address().port);
      if (req.method === 'GET' && ['/status', '/state'].includes(req.url)) {
        send(200, invokeSync(getStatus)); return;
      }
      if (req.method === 'POST' && ['/goals', '/instruct', '/pause'].includes(req.url)) {
        const body = await readBody(req);
        if (req.url === '/pause') {
          if (Object.keys(body).some(key => key !== 'paused') || (body.paused !== undefined && body.paused !== true))
            throw new ControlError(422, 'invalid-pause', '暂停会保存检查点后退出。请重新运行 npm start -- --restore <checkpoint> 恢复；不支持 paused:false。');
          invokeSync(pause, true);
          send(200, { paused: true, checkpoint: 'pending-action-boundary',
            message: '将在当前动作结束后保存检查点并退出；完成状态以进程日志为准。' }); return;
        }
        const key = req.url === '/goals' ? 'goal' : 'text';
        if (Object.keys(body).length !== 1 || !Object.hasOwn(body, key)) throw new ControlError(422, 'invalid-request', `body requires only ${key}`);
        const goal = key === 'goal' ? validateGroundedGoal(body.goal) : parseLocalInstruction(body.text, invokeSync(getStatus)?.observation);
        invokeSync(submit, goal);
        send(202, { accepted: true, goal }); return;
      }
      send(['/status', '/state', '/goals', '/instruct', '/pause'].includes(req.url) ? 405 : 404,
        { error: 'unsupported-route', message: 'GET /status or /state; POST /goals, /instruct, /pause' });
    } catch (error) {
      const result = errorResponse(error);
      send(result.status, { error: result.code, message: result.message });
    }
  });
  server.requestTimeout = 10000; server.headersTimeout = 5000; server.keepAliveTimeout = 2000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  return server;
}

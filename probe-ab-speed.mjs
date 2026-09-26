/** A/B 测速探针：建引擎 → 10 集预测计时（定位 verify-ab 卡死环节）。 */
import fs from 'node:fs';
import { EpisodeBuffer } from './mind/r1-episodes.mjs';
import { DifferentialExtractor } from './mind/r2-diff.mjs';
import { FactorRuleNet } from './mind/r3-rules.mjs';
import { pathToFileURL } from 'node:url';
const ENS = 'D:/kimi_kairos/energy-network-sim';
const imp = (p) => import(pathToFileURL(`${ENS}/${p}`).href);
const { TransitionMemory } = await imp('dist/src/planning/transition-memory.js');
const CONCEPT_CAPS = { nearDist: 8, nearType: 13, belowType: 13, grip: 8, logGrip: 8, speed: 8, onGround: 2, viewWell: 14, itemDist: 9, itemType: 13, itemBearing: 9 };
const DIMS = Object.keys(CONCEPT_CAPS);
const plain = (k) => (k.startsWith('next') && k.length > 4 ? k[4].toLowerCase() + k.slice(5) : k);
const episodes = fs.readFileSync('runs/mind-episodes.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((e) => e.conditions && e.outcomes && e.conditions.act !== undefined)
  .map((e) => ({ conditions: Object.fromEntries(DIMS.map((d) => [d, e.conditions[d] ?? CONCEPT_CAPS[d]])), act: e.conditions.act, outcomes: Object.fromEntries(Object.entries(e.outcomes).map(([k, v]) => [plain(k), v])) }));
const cut = Math.floor(episodes.length * 0.8);
const train = episodes.slice(0, cut);
console.log(' episodes', episodes.length, 'train', train.length);
let t = performance.now();
const r1 = new EpisodeBuffer({}); const r2 = new DifferentialExtractor({ quorum: 3 });
for (const ep of train) { r1.record(ep.conditions, ep.act, ep.outcomes); }
for (const ep of r1.recent()) r2.ingest(ep);
console.log('r2 diff', (performance.now() - t).toFixed(0), 'ms,', r2.allRules().length, 'rules');
const r3 = new FactorRuleNet(CONCEPT_CAPS, 10);
const alt = new Map();
for (const ep of train) for (const [d, v] of Object.entries(ep.conditions)) { if (!alt.has(d)) alt.set(d, new Set()); alt.get(d).add(v); }
t = performance.now();
r3.rebuild(r2.allRules().filter((r) => Object.keys(r.factors).length > 0 && r.support >= 2), alt);
console.log('r3 rebuild', (performance.now() - t).toFixed(0), 'ms,', r3.rules.length, 'rules,', r3.net.neuronCount, 'neurons');
t = performance.now();
const SPACE = { states: DIMS.map((name) => ({ name, outcome: 'next' + name[0].toUpperCase() + name.slice(1), bins: CONCEPT_CAPS[name] + 1 })), actions: [{ name: 'act', bins: 10 }], diameter: 14 };
const mem = new TransitionMemory(SPACE);
for (const ep of train) { const o = {}; for (const d of SPACE.states) o[d.outcome] = ep.outcomes[d.name] !== undefined ? ep.outcomes[d.name] : ep.conditions[d.name]; mem.observe(ep.conditions, mem.actions.find((a) => a.values.act === ep.act), o); }
console.log('legacy build', (performance.now() - t).toFixed(0), 'ms,', mem.mem.ruleCount, 'rules,', mem.mem.net.neuronCount, 'neurons');
const test = episodes.slice(cut, cut + 10);
for (const [i, ep] of test.entries()) {
  t = performance.now(); const p3 = r3.predict(ep.conditions, ep.act, 7); const t3 = performance.now() - t;
  t = performance.now(); const pl = mem.predict(ep.conditions, mem.actions.find((a) => a.values.act === ep.act), 7); const tl = performance.now() - t;
  console.log(i, 'r3', p3.kind, t3.toFixed(0) + 'ms', '| legacy', pl.kind, tl.toFixed(0) + 'ms');
}
process.exit(0);

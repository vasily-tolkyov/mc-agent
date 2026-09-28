/** r123 vs legacy 泛化 A/B（用上一轮真机情节 runs/mind-episodes.jsonl，不再烧 MC 时间）：
 * 同一份经验喂两套引擎，同一批测试情节测"行动前预测"：
 *   - 敢答率（网络敢给确定答案的比例）
 *   - 逐维准确率（变化维命中 + 未变维不误报变化）
 *   - 泛化切片：只看"条件组合在训练集里没出现过"的测试情节（真·新情境泛化）
 * legacy = energy-network-sim 的样本登记 TransitionMemory：已从 mind-agent 移除，这里只作历史对照
 * （它就是设计原文反对的"往数据库里写记录"式规则记忆）。
 * 运行：node verify-ab.mjs [episodes路径]
 */
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EpisodeBuffer } from './mind/r1-episodes.mjs';
import { DifferentialExtractor, applyChange } from './mind/r2-diff.mjs';
import { FactorRuleNet } from './mind/r3-rules.mjs';

const ENS = process.env.ENS_PATH ?? fileURLToPath(new URL('../energy-network-sim', import.meta.url)); // 同级克隆 energy-network-sim，或用 ENS_PATH 指定
const imp = (p) => import(pathToFileURL(`${ENS}/${p}`).href);
const { TransitionMemory } = await imp('dist/src/planning/transition-memory.js');

const CONCEPT_CAPS = { nearDist: 8, nearType: 13, belowType: 13, grip: 8, logGrip: 8, speed: 8, onGround: 2, viewWell: 14, itemDist: 9, itemType: 13, itemBearing: 9 };
const DIMS = Object.keys(CONCEPT_CAPS);
const SPACE = {
  states: DIMS.map((name) => ({ name, outcome: 'next' + name[0].toUpperCase() + name.slice(1), bins: CONCEPT_CAPS[name] + 1 })),
  actions: [{ name: 'act', bins: 10 }],
  diameter: 14,
};

const file = process.argv[2] ?? 'runs/mind-episodes.jsonl';
const plain = (k) => (k.startsWith('next') && k.length > 4 ? k[4].toLowerCase() + k.slice(5) : k); // legacy 行 nextXxx → 裸名
const episodes = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((e) => e.conditions && e.outcomes && e.conditions.act !== undefined)
  .map((e) => ({
    conditions: Object.fromEntries(DIMS.map((d) => [d, e.conditions[d] ?? CONCEPT_CAPS[d]])), // 跨时代文件维度不齐：缺的如实补未知档
    act: e.conditions.act,
    outcomes: Object.fromEntries(Object.entries(e.outcomes).map(([k, v]) => [plain(k), v])),
  }));
console.log(`情节 ${episodes.length} 条（80% 训练 / 20% 测试）`);
const cut = Math.floor(episodes.length * 0.8);
const train = episodes.slice(0, cut);
// 测试集按 条件签名+动作 去重并限 300（重复签名测一万遍也是同一题；双引擎退火预测成本高）
const seen = new Set(), test = [];
for (const ep of episodes.slice(cut)) {
  const sig = Object.keys(ep.conditions).sort().map((d) => `${d}=${ep.conditions[d]}`).join(',') + '|' + ep.act;
  if (seen.has(sig)) continue;
  seen.add(sig);
  test.push(ep);
  if (test.length >= 60) break; // legacy 预测 5s/题（1022 核退火）——60 题已是分钟级，别再放大
}

// ── r123 引擎 ──
const r1 = new EpisodeBuffer({});
const r2 = new DifferentialExtractor();
for (const ep of train) { r1.record(ep.conditions, ep.act, ep.outcomes); }
for (const ep of r1.recent()) r2.ingest(ep);
const r3 = new FactorRuleNet(CONCEPT_CAPS, 10);
const alt = new Map();
for (const ep of train) for (const [d, v] of Object.entries(ep.conditions)) {
  if (!alt.has(d)) alt.set(d, new Set());
  alt.get(d).add(v);
}
r3.rebuild(r2.allRules(), alt); // 与 mind-agent.rebuildR3 同一口径
console.log(`r123：${r3.rules.length} 条物化规则`);

// ── legacy 引擎 ──
const mem = new TransitionMemory(SPACE);
for (const ep of train) {
  const outcomes = {};
  for (const d of SPACE.states) outcomes[d.outcome] = ep.outcomes[d.name] !== undefined ? ep.outcomes[d.name] : ep.conditions[d.name];
  mem.observe(ep.conditions, mem.actions.find((a) => a.values.act === ep.act), outcomes);
}
console.log(`legacy：${mem.mem.ruleCount} 条样本规则`);

const outcomeName = (d) => 'next' + d[0].toUpperCase() + d.slice(1);
function evalEngine(name, predictFn) {
  let usable = 0, hit = 0, tot = 0, novelUsable = 0, novelHit = 0, novelTot = 0, novelN = 0;
  for (const ep of test) {
    const pred = predictFn(ep.conditions, ep.act);
    // 测试情节的条件签名在训练集里出现过吗（真·新情境切片）
    const sig = Object.keys(ep.conditions).sort().map((d) => `${d}=${ep.conditions[d]}`).join(',') + '|' + ep.act;
    const isNovel = !trainSigs.has(sig);
    if (pred.kind !== 'usable' || !pred.next) { continue; }
    usable++;
    if (isNovel) { novelUsable++; novelN++; }
    for (const d of DIMS) {
      const want = ep.outcomes[d] !== undefined ? ep.outcomes[d] : ep.conditions[d]; // 未变维应预测不变
      tot++;
      if (pred.next[d] === want) hit++;
      if (isNovel) { novelTot++; if (pred.next[d] === want) novelHit++; }
    }
  }
  return {
    engine: name, testN: test.length, novelN,
    usableRate: +(usable / test.length).toFixed(2),
    accuracy: tot ? +(hit / tot).toFixed(2) : null,
    novelUsableRate: novelN ? +(novelUsable / novelN).toFixed(2) : null,
    novelAccuracy: novelTot ? +(novelHit / novelTot).toFixed(2) : null,
  };
}
const trainSigs = new Set(train.map((e) => Object.keys(e.conditions).sort().map((d) => `${d}=${e.conditions[d]}`).join(',') + '|' + e.act));

const r123Res = evalEngine('r123', (conds, act) => {
  const p = r3.predict(conds, act, 7);
  return p.kind === 'usable' // R3 结果是 Δ 类/新值：施加到当前值上才是"预测的下一帧"
    ? { kind: 'usable', next: Object.fromEntries(DIMS.map((d) => [d, p.outcomes[d] !== undefined ? applyChange(d, conds[d], p.outcomes[d]) : conds[d]])) }
    : { kind: p.kind };
});
const legacyRes = evalEngine('legacy', (conds, act) => mem.predict(conds, mem.actions.find((a) => a.values.act === act), 7));

console.log('\n── A/B 结果（同一训练集、同一测试集）──');
for (const r of [r123Res, legacyRes]) {
  console.log(`${r.engine}：敢答率 ${r.usableRate}，逐维准确率 ${r.accuracy}｜新情境切片(n=${r.novelN})：敢答率 ${r.novelUsableRate}，准确率 ${r.novelAccuracy}`);
}

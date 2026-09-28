/** R1/R2/R3/规划链 离线单元验证 v2（合成情节，不连 MC）：
 * v2 重写：噪声生成器按真实流实测谱（复审教训：旧版"结果签名完全相同"是真实世界
 * 永不满足的前提，绿灯但不保护）——每情节随机 2–4 个共变结果维、计数维跨情节累加、
 * speed 浮点抖动、无关动作噪声。
 * 期望：① R2 v3 双臂对照把无关维降出 hard（规则泛化：dig→logGrip Δ+1 的 hard 只有
 *      nearType±nearDist）；② R3 在没见过的新组合上下文照样预测；③ Δ 规则重复应用
 *      拼出 logGrip 0→2 两节链；④ 不满足 hard 因素时返回 evidence-gap 并点名 nearType；
 *      ⑤ 无规则触及的维返回 missing-rule。
 * 运行：node verify-r123.mjs
 */
import { EpisodeBuffer } from './mind/r1-episodes.mjs';
import { DifferentialExtractor } from './mind/r2-diff.mjs';
import { FactorRuleNet } from './mind/r3-rules.mjs';
import { planBackward } from './mind/plan-back.mjs';

const CONCEPT_CAPS = { nearDist: 8, nearType: 13, belowType: 13, grip: 8, logGrip: 8, speed: 8, onGround: 2, viewWell: 14 };
const DIG = 5, FORWARD = 0, TURN = 2, OAK = 4, STONE = 3, AIR = 0;

// 确定性伪随机（可复现）
let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const r1 = new EpisodeBuffer({});
let grip = 0, logGrip = 0; // 计数维跨情节累加（真实流的绝对值漂移源）

/** 噪声共变：每情节随机 2–4 个结果维附带变化（真实流实测：平均每次背包变化伴随 4.1 个共变维） */
function noiseOutcomes(cond) {
  const out = {};
  const dims = ['nearDist', 'speed', 'viewWell', 'onGround'];
  const k = 2 + Math.floor(rnd() * 3);
  const shuffled = [...dims].sort(() => rnd() - 0.5).slice(0, k);
  for (const d of shuffled) {
    if (d === 'nearDist') out.nearDist = Math.max(0, Math.min(8, cond.nearDist + (rnd() < 0.5 ? -1 : 1) * Math.ceil(rnd() * 2)));
    if (d === 'speed') out.speed = Math.min(8, cond.speed + (rnd() - 0.5)); // 浮点抖动
    if (d === 'viewWell') out.viewWell = rnd() < 0.7 ? 14 : Math.floor(rnd() * 3);
    if (d === 'onGround') out.onGround = 1;
  }
  return out;
}
const base = () => ({ nearDist: 1 + Math.floor(rnd() * 4), belowType: Math.floor(rnd() * 3), speed: rnd() < 0.3 ? 1 : 0, viewWell: rnd() < 0.6 ? 14 : Math.floor(rnd() * 3), onGround: 1 });

// 挖原木 18 次（nearType=原木，nearDist ≤3）：logGrip/grip 各 +1，噪声共变
for (let i = 0; i < 18; i++) {
  const cond = { ...base(), nearType: OAK, nearDist: 1 + Math.floor(rnd() * 3), grip, logGrip };
  const out = { ...noiseOutcomes(cond), logGrip: ++logGrip, grip: ++grip };
  r1.record(cond, DIG, out);
}
// 对照：挖石头 10 次（grip+1，无 logGrip）；挖空气 8 次（什么都没挖到，仅噪声）
for (let i = 0; i < 10; i++) {
  const cond = { ...base(), nearType: STONE, nearDist: 1 + Math.floor(rnd() * 3), grip, logGrip };
  r1.record(cond, DIG, { ...noiseOutcomes(cond), grip: ++grip });
}
for (let i = 0; i < 8; i++) {
  const cond = { ...base(), nearType: AIR, nearDist: 8, grip, logGrip };
  r1.record(cond, DIG, noiseOutcomes(cond));
}
// 无关动作噪声：前进/转向各 12 次（speed/nearDist/viewWell 变，与背包无关）
for (let i = 0; i < 12; i++) {
  const cond = { ...base(), nearType: rnd() < 0.3 ? OAK : AIR, grip, logGrip };
  r1.record(cond, rnd() < 0.5 ? FORWARD : TURN, noiseOutcomes(cond));
}
// 侥幸污染（真实流的 junk 来源）：2 条 slotNext 情节里 logGrip 恰好 +2（吸入延迟张冠李戴）——
// 机制检验点：这种 2 情节的巧合模式在退火地形上应弱到点不燃，绝不能劫持预测/规划
const SLOT = 7;
for (let i = 0; i < 2; i++) {
  const cond = { ...base(), nearType: AIR, grip, logGrip };
  r1.record(cond, SLOT, { ...noiseOutcomes(cond), logGrip: logGrip + 2, grip: grip + 2 });
  logGrip += 2; grip += 2;
}

const r2 = new DifferentialExtractor({});
r2.ingestAll(r1.recent());
const rules = r2.allRules();
console.log(`── R2 v3 差分（${r1.size} 情节 → ${rules.length} 规则）──`);
const lgRules = rules.filter((r) => r.outcome.logGrip === 1 && r.action === DIG);
for (const r of lgRules) console.log(`  dig→logGrip Δ+1：hard=${JSON.stringify(r.hard)} soft=${JSON.stringify(Object.fromEntries(Object.entries(r.soft).map(([d, s]) => [d, s.conf])))} n=${r.n} ρ=${r.rho}`);
const lg = lgRules[0];
const t1 = lg && lg.n >= 12 && Object.keys(lg.hard).length > 0 && Object.keys(lg.hard).length <= 2
  && (lg.hard.nearType === OAK || lg.hard.nearDist !== undefined);
console.log(`① 双臂对照剔薄：hard 因素 ${lg ? Object.keys(lg.hard).length : '-'} 个（要求 1–2 且含 nearType/nearDist，n≥12）→ ${t1 ? '✓' : '✗'}`);
// 反面：挖石头规则不该把 logGrip 当结果
const bad = rules.some((r) => r.action === DIG && r.outcome.logGrip !== undefined && r.hard.nearType === STONE);
console.log(`② 对照臂生效：无"挖石头→logGrip"伪规则 → ${!bad ? '✓' : '✗'}`);

// R3 物化 + 泛化预测
const altValues = new Map();
for (const ep of r1.recent()) for (const [d, v] of Object.entries(ep.conditions)) {
  if (!altValues.has(d)) altValues.set(d, new Set());
  altValues.get(d).add(v);
}
const r3 = new FactorRuleNet(CONCEPT_CAPS, 10);
r3.rebuild(rules, altValues);
console.log(`\nR3 网络：${r3.net.neuronCount} 神经元，${rules.length} 条规则物化`);

const novel = { nearDist: 2, nearType: OAK, belowType: 0, grip: 5, logGrip: 3, speed: 1, onGround: 1, viewWell: 14 };
const p1 = r3.predict(novel, DIG, 7);
console.log(`── 泛化：新组合上下文（belowType=0/speed=1 没见过）+ nearType=原木，dig ──`);
console.log(`kind=${p1.kind} 结果=${JSON.stringify(p1.outcomes)} 能量=${p1.energy.toFixed(1)} → ${p1.kind === 'usable' && p1.outcomes?.logGrip === 1 ? '✓ 泛化成功（Δ+1）' : '✗'}`);

const p2 = r3.predict({ ...novel, nearType: STONE }, DIG, 7);
console.log(`── 否决：nearType=石头时不许报原木 ──`);
console.log(`kind=${p2.kind} 结果=${JSON.stringify(p2.outcomes)} → ${p2.outcomes?.logGrip === undefined ? '✓ 没有错误泛化' : '✗ 错误泛化'}`);

// 规划链：Δ 规则重复应用（logGrip 0→2 = dig×2）——走网络退火读出（candidatesFn），
// 同时检验侥幸规则（slotNext Δ+2，2 情节巧合）不会浮上来劫持规划
const plan = planBackward({ rules, current: { ...novel, logGrip: 0 }, goalDims: { logGrip: 2 }, maxDepth: 6, candidatesFn: (t, f) => r3.planCandidates(f, t, 3) });
console.log(`── 规划链 ③：目标 logGrip=2，当前 nearType=原木 logGrip=0 ──`);
console.log(`status=${plan.status} 链 ${plan.steps.length} 节（${plan.steps.map((r) => `${r.action === DIG ? 'dig' : '?' } Δ+1`).join(' → ')}）→ ${plan.status === 'found' && plan.steps.length === 2 && plan.steps.every((r) => r.action === DIG) ? '✓ Δ 规则重复应用成链（侥幸规则未劫持）' : '✗'}`);

// 侥幸抑制单测：planCandidates 的返回里不许出现 slotNext 侥幸规则
const surfaced = r3.planCandidates({ ...novel, logGrip: 0 }, { logGrip: 2 }, 3);
const flukeSurfaced = surfaced.some((r) => r.action === SLOT);
console.log(`── 侥幸抑制 ⑥：浮上候选的规则 ${surfaced.length} 条（${surfaced.map((r) => `act${r.action}`).join(',') || '无'}）→ ${!flukeSurfaced ? '✓ slotNext 侥幸未浮出' : '✗ 侥幸劫持'}`);

// 证据缺口：nearType=石头时应有 evidence-gap 且点名 nearType
const plan2 = planBackward({ rules, current: { ...novel, nearType: STONE, logGrip: 0 }, goalDims: { logGrip: 1 }, maxDepth: 6 });
const named = plan2.gaps?.some((g) => g.missing.some((m) => m.dim === 'nearType'));
console.log(`── 缺口上报 ④：nearType=石头，目标 logGrip=1 ──`);
console.log(`status=${plan2.status} 缺口=${JSON.stringify(plan2.gaps?.[0]?.missing ?? [])} → ${plan2.status === 'evidence-gap' && named ? '✓ 点名 nearType' : '✗'}`);

// 缺失规则：goalDist 无任何规则触及
const plan3 = planBackward({ rules, current: novel, goalDims: { belowType: 7 }, maxDepth: 6 });
console.log(`── 缺失规则 ⑤：目标 belowType=7（没挖过/没踩过）──`);
console.log(`status=${plan3.status} → ${['missing-rule', 'evidence-gap', 'found'].includes(plan3.status) ? `✓ 如实上报（${plan3.status}）` : '✗'}`);

const pass = t1 && !bad && p1.kind === 'usable' && p1.outcomes?.logGrip === 1 && p2.outcomes?.logGrip === undefined
  && plan.status === 'found' && plan.steps.length === 2 && plan.steps.every((r) => r.action === DIG)
  && plan2.status === 'evidence-gap' && named && !flukeSurfaced;
console.log(`\n${pass ? '✓✓ 全部通过' : '✗✗ 有未通过项'}`);
process.exit(pass ? 0 : 1);

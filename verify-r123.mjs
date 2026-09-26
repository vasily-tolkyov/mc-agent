/** R1/R2/R3/规划链 离线单元验证（合成情节，不连 MC）：
 * 场景：挖原木 → logGrip+1，但上下文（nearDist/belowType/speed/viewWell）每次都不同。
 * 期望：① R2B 差分把这些无关维从因素集剔除（规则泛化）；
 *      ② R3 在没见过的新组合上下文里照样预测（满足影响因素即可）；
 *      ③ 反向链接规划 logGrip 0→1→2 成链；
 *      ④ 不满足因素（面前是石头）时如实 unknown。
 * 运行：node verify-r123.mjs
 */
import { EpisodeBuffer } from './mind/r1-episodes.mjs';
import { DifferentialExtractor } from './mind/r2-diff.mjs';
import { FactorRuleNet } from './mind/r3-rules.mjs';
import { planBackward } from './mind/plan-back.mjs';

const CONCEPT_CAPS = { nearDist: 8, nearType: 13, belowType: 13, grip: 8, logGrip: 8, speed: 8, onGround: 2, viewWell: 14 };
const r1 = new EpisodeBuffer({});
const r2 = new DifferentialExtractor({ quorum: 3 });
const DIG = 5, OAK = 4, STONE = 3;

// 挖原木 0→1：12 条，上下文全变
const varies = [
  { nearDist: 1, belowType: 1, speed: 0, viewWell: 0 }, { nearDist: 2, belowType: 1, speed: 0, viewWell: 0 },
  { nearDist: 3, belowType: 2, speed: 0, viewWell: 2 }, { nearDist: 2, belowType: 1, speed: 1, viewWell: 0 },
  { nearDist: 1, belowType: 2, speed: 0, viewWell: 14 }, { nearDist: 4, belowType: 1, speed: 0, viewWell: 0 },
];
// 结果要如实记全部变化维：挖原木 grip 和 logGrip 一起变！只记 logGrip 会让规划校验
// 正确地发现"grip 无来源"（上版失败是测试数据造假，规划器是对的）
for (let i = 0; i < 12; i++) {
  const v = varies[i % varies.length];
  r1.record({ ...v, nearType: OAK, grip: 0, logGrip: 0, onGround: 1 }, DIG, { logGrip: 1, grip: 1 });
}
// 挖原木 1→2：6 条（规划链第二节）
for (let i = 0; i < 6; i++) {
  const v = varies[i % varies.length];
  r1.record({ ...v, nearType: OAK, grip: 1, logGrip: 1, onGround: 1 }, DIG, { logGrip: 2, grip: 2 });
}
// 对照：挖石头 → grip+1（nearType 不同，不该和原木合并）
for (let i = 0; i < 8; i++) {
  const v = varies[i % varies.length];
  r1.record({ ...v, nearType: STONE, grip: 0, logGrip: 0, onGround: 1 }, DIG, { grip: 1 });
}
// 噪声：随机游走速度变化（动作 0 改变 speed——无关规则）
for (let i = 0; i < 4; i++) r1.record({ ...varies[0], nearType: 0, grip: 0, logGrip: 0, onGround: 1 }, 0, { speed: 1 });

r2.ingestAll(r1.recent());
const rules = r2.allRules().filter((r) => Object.keys(r.factors).length > 0 && r.support >= 2);
console.log('── R2 差分出的规则 ──');
for (const r of rules) console.log(`  act=${r.action} 因素=${JSON.stringify(r.factors)} → 结果=${JSON.stringify(r.outcomes)} support=${r.support}`);

// 已观察替代值（否决源）
const altValues = new Map();
for (const ep of r1.recent()) for (const [d, v] of Object.entries(ep.conditions)) {
  if (!altValues.has(d)) altValues.set(d, new Set());
  altValues.get(d).add(v);
}

const r3 = new FactorRuleNet(CONCEPT_CAPS, 10);
r3.rebuild(rules, altValues);
console.log(`\nR3 网络：${r3.net.neuronCount} 神经元，${rules.length} 条规则物化（第 ${r3.refreshCount} 次重建）`);

console.log('\n── 泛化测试 ①：没见过的新组合上下文（nearDist=8/belowType=0/speed=1），但 nearType=原木 ──');
const novel = { nearDist: 8, nearType: OAK, belowType: 0, grip: 0, logGrip: 0, speed: 1, onGround: 1, viewWell: 14 };
const p1 = r3.predict(novel, DIG, 7);
console.log(`kind=${p1.kind} 结果=${JSON.stringify(p1.outcomes)} 能量=${p1.energy.toFixed(1)} → ${p1.kind === 'usable' && p1.outcomes?.logGrip === 1 ? '✓ 泛化成功' : '✗'}`);

console.log('── 泛化测试 ②：不满足因素（nearType=石头），挖 → 应该走石头规则或 unknown，不许报原木 ──');
const p2 = r3.predict({ ...novel, nearType: STONE }, DIG, 7);
console.log(`kind=${p2.kind} 结果=${JSON.stringify(p2.outcomes)} → ${p2.outcomes?.logGrip === undefined ? '✓ 没有错误泛化' : '✗ 错误泛化成原木！'}`);

console.log('── 规划链测试 ③：目标 logGrip=2，当前 nearType=原木 logGrip=0 ──');
const plan = planBackward({ rules, current: novel, goalDims: { logGrip: 2 }, maxDepth: 6 });
console.log(`status=${plan.status} 链=${plan.steps.map((r) => `dig(logGrip ${r.factors.logGrip}→${r.outcomes.logGrip})`).join(' → ')} → ${plan.status === 'found' && plan.steps.length === 2 ? '✓ 两节链' : '✗'}`);

console.log('── 规划链测试 ④：目标 logGrip=1，但当前 nearType=石头（无规则可满足因素）──');
const plan2 = planBackward({ rules, current: { ...novel, nearType: STONE }, goalDims: { logGrip: 1 }, maxDepth: 6 });
console.log(`status=${plan2.status} → ${plan2.status === 'no-known-route' ? '✓ 如实无路线（因素无法满足）' : '✗'}`);

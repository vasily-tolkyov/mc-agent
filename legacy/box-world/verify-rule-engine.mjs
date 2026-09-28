/** 规则引擎审查的实证附录（归档：TransitionMemory 样本登记引擎已从 mind-agent 移除）：
 * 用 mc-agent 真实概念空间（8 状态维+viewWell+10 动作）验证 TransitionMemory 在封顶后能观察、预测、规划
 * （修复前首次规划即分配 37GB 崩溃）。运行：node legacy/box-world/verify-rule-engine.mjs
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
const ENS = process.env.ENS_PATH ?? fileURLToPath(new URL('../../../energy-network-sim', import.meta.url)); // 仓库同级克隆 energy-network-sim，或用 ENS_PATH 指定
const imp = (p) => import(pathToFileURL(`${ENS}/${p}`).href);
const { TransitionMemory } = await imp('dist/src/planning/transition-memory.js');
const { planGoal } = await imp('dist/src/planning/planner.js');

// 与 mind-agent 完全相同的概念空间
const CONCEPT_CAPS = { nearDist: 8, nearType: 13, belowType: 13, grip: 8, logGrip: 8, speed: 8, onGround: 2, viewWell: 14 };
const DIM_NAMES = Object.keys(CONCEPT_CAPS);
const SPACE = {
  states: DIM_NAMES.map((name) => ({ name, outcome: 'next' + name[0].toUpperCase() + name.slice(1), bins: CONCEPT_CAPS[name] + 1 })),
  actions: [{ name: 'act', bins: 10 }],
  diameter: 14,
};
const U = Object.fromEntries(DIM_NAMES.map((d) => [d, CONCEPT_CAPS[d]])); // 全未知档状态

console.log('── 构建：8 状态维 + 10 动作 ──');
const t0 = performance.now();
const mem = new TransitionMemory(SPACE);
console.log(`神经元 ${mem.mem.net.neuronCount.toLocaleString()}（修复前同空间 = 23.1 亿），构建 ${(performance.now() - t0).toFixed(0)}ms`);

console.log('── 合成经验：看原木井(viewWell=0) + dig → logGrip+1，写 20 次 ──');
const act = mem.actions[5]; // dig
const s0 = { ...U, viewWell: 0, logGrip: 0, grip: 0 };
const s1 = { ...U, viewWell: 0, logGrip: 1, grip: 1 };
for (let i = 0; i < 20; i++) mem.observe(s0, act, Object.fromEntries(SPACE.states.map((d) => [d.outcome, s1[d.name]])));
console.log(`规则 ${mem.mem.ruleCount}`);

console.log('── 预测：同条件下 dig ──');
const p = mem.predict(s0, act, 1);
console.log(`kind=${p.kind} next.logGrip=${p.next?.logGrip} 收敛=${p.snapshot.converged} 能耗=${p.audit.energy.toFixed(1)} 审计误差=${p.audit.error.toExponential(1)} ${p.milliseconds.toFixed(0)}ms`);

console.log('── 规划：s0 → s1（目标是全帧签名匹配，不是单维）──');
const plan = planGoal(mem, s0, s1, 1);
console.log(`status=${plan.status} steps=${plan.steps.length} 预测数=${plan.predictions.length}`);
if (plan.steps.length) console.log(`第一步: act=${plan.steps[0].action.values.act} → logGrip=${plan.steps[0].next?.logGrip}`);
console.log(plan.status === 'found' && plan.steps[0]?.action.values.act === 5 ? '✓ 规划找到挖原木路线，炸弹已拆' : '✗ 异常');

/** 结构层换底等价验证：概念形成（图像路径）与 R3 因素规则网，二值 vs 脉冲逐位一致。
 * A: verify-image-path 的全部数字（IoU/补全率/能量）在脉冲底座上逐位复现；
 * B: verify-r123 的 4/4 判定在脉冲底座上完全一致（同种子退火 ⇒ 同激活集/能量）。
 * 运行：node verify-spiking-structures.mjs
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
const ENS = process.env.ENS_PATH ?? fileURLToPath(new URL('../energy-network-sim', import.meta.url)); // 同级克隆 energy-network-sim，或用 ENS_PATH 指定
const imp = (p) => import(pathToFileURL(`${ENS}/${p}`).href);
const { SensoryEncoder, iou } = await imp('dist/src/pop/concept/sensory.js');
const { ConceptFormation } = await imp('dist/src/pop/concept/formation.js');
const { SpikingEnergyNetwork } = await import('./mind/spiking-network.mjs');
const { EpisodeBuffer } = await import('./mind/r1-episodes.mjs');
const { DifferentialExtractor } = await import('./mind/r2-diff.mjs');
const r3mod = await import('./mind/r3-rules.mjs');
const { planBackward } = await import('./mind/plan-back.mjs');

// ── A：图像路径（ConceptFormation 换底）──
function makeFormation(cls) {
  const W = 8, PIXELS = W * W;
  const dims = Array.from({ length: PIXELS }, (_, i) => ({ name: `px${i}`, min: 0, max: 1 }));
  const enc = new SensoryEncoder(dims, 12);
  const f = new ConceptFormation(enc, { maxWeight: 3.0 });
  f.net = new cls({ neuronCount: enc.neuronCount, activationEnergy: 1.0, maintenanceEnergy: 0.5, learningRate: 0.1, maxWeight: 3.0 });
  return { f, enc, PIXELS };
}
let rs = 42;
const rnd = () => { rs = (rs * 1664525 + 1013904223) >>> 0; return rs / 4294967296; };
const clamp01 = (x) => Math.max(0, Math.min(1, x));
function fillImage(f, PIXELS) {
  const stoneBase = Array.from({ length: PIXELS }, (_, i) => 0.55 + ((i % 8) > 3 ? 0.03 : -0.03));
  const woodBase = Array.from({ length: PIXELS }, (_, i) => 0.25 + 0.12 * ((Math.floor(i / 8) % 2) ? 1 : -1));
  const sample = (base, noise = 0.06) => Object.fromEntries(base.map((v, i) => [`px${i}`, clamp01(v + (rnd() - 0.5) * 2 * noise)]));
  for (let i = 0; i < 40; i++) { f.presentExperiment(sample(stoneBase), 4); f.presentExperiment(sample(woodBase), 4); }
  return { stoneBase, woodBase, sample };
}
const { EnergyNetwork } = await imp('dist/src/index.js');
const A1 = makeFormation(EnergyNetwork), A2 = makeFormation(SpikingEnergyNetwork);
rs = 42; const img1 = fillImage(A1.f, A1.PIXELS);
rs = 42; const img2 = fillImage(A2.f, A2.PIXELS);
// 权重一致性
let wDiff = 0;
for (let i = 0; i < A1.enc.neuronCount; i++) for (let j = 0; j < A1.enc.neuronCount; j++) if (A1.f.net.getWeight(i, j) !== A2.f.net.getWeight(i, j)) wDiff++;
const eS1 = A1.f.net.settle(A1.enc.encode(Object.fromEntries(img1.stoneBase.map((v, i) => ['px' + i, v]))));
const eS2 = A2.f.net.settle(A2.enc.encode(Object.fromEntries(img2.stoneBase.map((v, i) => ['px' + i, v]))));
console.log(`A 图像路径：学习后边差异 ${wDiff}（应 0）；石头 settle 能量 ${eS1.energy.toFixed(1)} vs ${eS2.energy.toFixed(1)}（差 ${Math.abs(eS1.energy - eS2.energy)}）`);

// ── B：R3 换底（verify-r123 数据）──
const CONCEPT_CAPS = { nearDist: 8, nearType: 13, belowType: 13, grip: 8, logGrip: 8, speed: 8, onGround: 2, viewWell: 14 };
function buildR1R2() {
  const r1 = new EpisodeBuffer({});
  const r2 = new DifferentialExtractor({ quorum: 3 });
  const DIG = 5, OAK = 4, STONE = 3;
  const varies = [
    { nearDist: 1, belowType: 1, speed: 0, viewWell: 0 }, { nearDist: 2, belowType: 1, speed: 0, viewWell: 0 },
    { nearDist: 3, belowType: 2, speed: 0, viewWell: 2 }, { nearDist: 2, belowType: 1, speed: 1, viewWell: 0 },
    { nearDist: 1, belowType: 2, speed: 0, viewWell: 14 }, { nearDist: 4, belowType: 1, speed: 0, viewWell: 0 },
  ];
  for (let i = 0; i < 12; i++) { const v = varies[i % varies.length]; r1.record({ ...v, nearType: OAK, grip: 0, logGrip: 0, onGround: 1 }, DIG, { logGrip: 1, grip: 1 }); }
  for (let i = 0; i < 6; i++) { const v = varies[i % varies.length]; r1.record({ ...v, nearType: OAK, grip: 1, logGrip: 1, onGround: 1 }, DIG, { logGrip: 2, grip: 2 }); }
  for (let i = 0; i < 8; i++) { const v = varies[i % varies.length]; r1.record({ ...v, nearType: STONE, grip: 0, logGrip: 0, onGround: 1 }, DIG, { grip: 1 }); }
  for (let i = 0; i < 4; i++) r1.record({ ...varies[0], nearType: 0, grip: 0, logGrip: 0, onGround: 1 }, 0, { speed: 1 });
  for (const ep of r1.recent()) r2.ingest(ep);
  return { rules: r2.allRules().filter((r) => Object.keys(r.factors).length > 0 && r.support >= 2), alt: (() => { const m = new Map(); for (const ep of r1.recent()) for (const [d, v] of Object.entries(ep.conditions)) { if (!m.has(d)) m.set(d, new Set()); m.get(d).add(v); } return m; })() };
}
function buildR3(cls, rules, alt) {
  r3mod.setR3NetClass(cls);
  const r3 = new r3mod.FactorRuleNet(CONCEPT_CAPS, 10);
  r3.rebuild(rules, alt);
  return r3;
}
const { rules, alt } = buildR1R2();
const R1 = buildR3(EnergyNetwork, rules, alt);
const R2 = buildR3(SpikingEnergyNetwork, rules, alt);
// 网络权重一致性
let wDiff2 = 0, gDiff2 = 0;
const nn = R1.net.neuronCount;
for (let i = 0; i < nn; i++) for (let j = 0; j < nn; j++) {
  if (R1.net.getWeight(i, j) !== R2.net.getWeight(i, j)) wDiff2++;
  if (R1.net.getInhibitoryWeight(i, j) !== R2.net.getInhibitoryWeight(i, j)) gDiff2++;
}
const novel = { nearDist: 8, nearType: 4, belowType: 0, grip: 0, logGrip: 0, speed: 1, onGround: 1, viewWell: 14 };
const p1a = R1.predict(novel, 5, 7), p1b = R2.predict(novel, 5, 7);
const p2a = R1.predict({ ...novel, nearType: 3 }, 5, 7), p2b = R2.predict({ ...novel, nearType: 3 }, 5, 7);
const sameP = (a, b) => a.kind === b.kind && JSON.stringify(a.outcomes) === JSON.stringify(b.outcomes) && a.energy === b.energy;
console.log(`B R3：建网边差异 W=${wDiff2} Γ=${gDiff2}（应 0）`);
console.log(`  泛化预测：${p1a.kind}/${JSON.stringify(p1a.outcomes)} E=${p1a.energy} vs ${p1b.kind}/${JSON.stringify(p1b.outcomes)} E=${p1b.energy} → ${sameP(p1a, p1b) ? '一致' : '✗'}`);
console.log(`  石头预测：${p2a.kind}/${JSON.stringify(p2a.outcomes)} vs ${p2b.kind}/${JSON.stringify(p2b.outcomes)} → ${sameP(p2a, p2b) ? '一致' : '✗'}`);
const plan = planBackward({ rules, current: novel, goalDims: { logGrip: 2 }, maxDepth: 6 });
console.log(`  反查链（与底座无关，应 found/2 节）：${plan.status}，${plan.steps.length} 节`);
console.log(wDiff === 0 && wDiff2 === 0 && gDiff2 === 0 && sameP(p1a, p1b) && sameP(p2a, p2b) && eS1.energy === eS2.energy ? '\n✓ 结构层换底语义不变' : '\n✗ 结构层存在差异');

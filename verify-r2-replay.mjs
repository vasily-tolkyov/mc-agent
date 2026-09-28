/** R2 新旧差分器对拍（v2 快照 vs v3 双臂对照）：同一条真实噪声谱合成流，喂两个版本。
 * 对照指标（复审建议）：簇大小中位数、规则总数、logGrip 规则的 hard 因素数、
 * 从 L3 起始态（nearType=原木, logGrip=0, 目标 logGrip≥1）能否出真规划链。
 * v2 快照存于 test/fixtures/r2-diff-v2.snapshot.mjs（git show 30a08e1:mind/r2-diff.mjs 产生）。
 * 运行：node verify-r2-replay.mjs
 */
import { EpisodeBuffer } from './mind/r1-episodes.mjs';
import { DifferentialExtractor as DiffV3 } from './mind/r2-diff.mjs';
import { DifferentialExtractor as DiffV2 } from './test/fixtures/r2-diff-v2.snapshot.mjs';
import { planBackward } from './mind/plan-back.mjs';

const DIG = 5, FORWARD = 0, TURN = 2, OAK = 4, STONE = 3, AIR = 0;

/** 真实噪声谱合成流（与 verify-r123 同一发生器，种子独立可复现） */
function makeStream(seed0 = 42) {
  let seed = seed0;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const r1 = new EpisodeBuffer({});
  let grip = 0, logGrip = 0;
  const noiseOutcomes = (cond) => {
    const out = {};
    const dims = ['nearDist', 'speed', 'viewWell', 'onGround'];
    const k = 2 + Math.floor(rnd() * 3);
    const shuffled = [...dims].sort(() => rnd() - 0.5).slice(0, k);
    for (const d of shuffled) {
      if (d === 'nearDist') out.nearDist = Math.max(0, Math.min(8, cond.nearDist + (rnd() < 0.5 ? -1 : 1) * Math.ceil(rnd() * 2)));
      if (d === 'speed') out.speed = Math.min(8, cond.speed + (rnd() - 0.5));
      if (d === 'viewWell') out.viewWell = rnd() < 0.7 ? 14 : Math.floor(rnd() * 3);
      if (d === 'onGround') out.onGround = 1;
    }
    return out;
  };
  const base = () => ({ nearDist: 1 + Math.floor(rnd() * 4), belowType: Math.floor(rnd() * 3), speed: rnd() < 0.3 ? 1 : 0, viewWell: rnd() < 0.6 ? 14 : Math.floor(rnd() * 3), onGround: 1 });
  for (let i = 0; i < 18; i++) {
    const cond = { ...base(), nearType: OAK, nearDist: 1 + Math.floor(rnd() * 3), grip, logGrip };
    r1.record(cond, DIG, { ...noiseOutcomes(cond), logGrip: ++logGrip, grip: ++grip });
  }
  for (let i = 0; i < 10; i++) {
    const cond = { ...base(), nearType: STONE, nearDist: 1 + Math.floor(rnd() * 3), grip, logGrip };
    r1.record(cond, DIG, { ...noiseOutcomes(cond), grip: ++grip });
  }
  for (let i = 0; i < 8; i++) r1.record({ ...base(), nearType: AIR, nearDist: 8, grip, logGrip }, DIG, noiseOutcomes({ ...base(), nearType: AIR }));
  for (let i = 0; i < 12; i++) {
    const cond = { ...base(), nearType: rnd() < 0.3 ? OAK : AIR, grip, logGrip };
    r1.record(cond, rnd() < 0.5 ? FORWARD : TURN, noiseOutcomes(cond));
  }
  return r1.recent();
}

const episodes = makeStream();
console.log(`回放 ${episodes.length} 条真实噪声谱情节\n`);

// ── v2 旧差分器（快照类；只比对因素宽度——它的规则形态 {factors,outcomes} 已不被当前规划器消费）──
const v2 = new DiffV2({ quorum: 3 });
for (const ep of episodes) v2.ingest(ep);
const v2Rules = v2.allRules();
const v2Lg = v2Rules.filter((r) => r.outcomes.logGrip !== undefined && r.action === DIG);
const v2FactorCounts = v2Lg.map((r) => Object.keys(r.factors).length);
console.log(`── v2（动作+完整结果签名簇）──`);
console.log(`  规则总数 ${v2Rules.length}，logGrip 结果规则 ${v2Lg.length} 条，因素数分布 [${v2FactorCounts.join(',')}]`);

// ── v3 双臂对照 ──
const v3 = new DiffV3();
for (const ep of episodes) v3.ingest(ep);
const v3Rules = v3.allRules();
const v3Lg = v3Rules.filter((r) => r.outcomes.logGrip !== undefined && r.action === DIG);
const v3HardCounts = v3Lg.map((r) => Object.keys(r.hard).length);
console.log(`\n── v3（动作+单结果维+Δ类簇，双臂对照）──`);
console.log(`  规则总数 ${v3Rules.length}，logGrip Δ 规则 ${v3Lg.length} 条，hard 因素数分布 [${v3HardCounts.join(',')}]`);
for (const r of v3Lg) console.log(`    ${JSON.stringify(r.outcomes)} hard=${JSON.stringify(r.hard)} n=${r.n} ρ=${r.rho}`);
const v3Plan = planBackward({ rules: v3Rules, current: { nearDist: 2, nearType: OAK, belowType: 0, grip: 0, logGrip: 0, speed: 1, onGround: 1, viewWell: 14 }, goalDims: { logGrip: { min: 0.7, max: 8.4 } }, maxDepth: 6 });
console.log(`  L3 起始态出链：${v3Plan.status}${v3Plan.steps.length ? `（${v3Plan.steps.length} 节）` : ''}${v3Plan.gaps ? ` 缺口=${JSON.stringify(v3Plan.gaps[0]?.missing ?? [])}` : ''}`);

const pass = v3Plan.status === 'found' && v3Plan.steps.length >= 1
  && v3Lg.length > 0 && v3HardCounts.every((n) => n <= 2)
  && v2FactorCounts.some((n) => n >= 5); // v2 复现"因素集过宽"旧病（对照成立）
console.log(`\n${pass ? '✓✓ 对拍成立：v2 复现宽因素旧病，v3 剔薄并出链' : '✗✗ 对拍不成立'}`);
process.exit(pass ? 0 : 1);

/** 退火对拍：同图同种子，二值 vs 脉冲 settleAnnealed 的终态/能量/轨迹/提议数逐位一致。
 * 覆盖：① 默认退火（带 wells）② fallbackQuietOnly+quenchCandidatesOnly（池 DI，WTA 场景）
 * ③ 多种子 ④ 含交换移动的 quietOnly 路径。运行：node verify-spiking-anneal.mjs
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
const ENS = process.env.ENS_PATH ?? fileURLToPath(new URL('../energy-network-sim', import.meta.url)); // 同级克隆 energy-network-sim，或用 ENS_PATH 指定
const imp = (p) => import(pathToFileURL(`${ENS}/${p}`).href);
const { EnergyNetwork } = await imp('dist/src/index.js');
const { mulberry32 } = await imp('dist/src/prng.js');
const { SpikingEnergyNetwork } = await import('./mind/spiking-network.mjs');

const N = 40;
const cfg = { neuronCount: N, activationEnergy: 1.0, maintenanceEnergy: 0.5, learningRate: 0.1, maxWeight: 3.0, maxDirectedWeight: 20.0 };

function buildPair(seed) {
  const rand = mulberry32(seed);
  const bin = new EnergyNetwork(cfg);
  const spk = new SpikingEnergyNetwork({ ...cfg });
  // 两个竞争核 + 池（FactorRuleNet 的 WTA 拓扑）
  const cores = [[20, 21, 22, 23], [24, 25, 26, 27]];
  for (const c of cores) {
    for (let a = 0; a < c.length; a++) for (let b = a + 1; b < c.length; b++) { bin.setWeight(c[a], c[b], 2.5); spk.setWeight(c[a], c[b], 2.5); }
    for (const x of c) for (let k = 0; k < 2; k++) { bin.strengthen(x, 38 + k, 0.3 / (k + 1)); spk.strengthen(x, 38 + k, 0.3 / (k + 1)); bin.strengthenDirectedInhibitory(38 + k, x, 20, 20); spk.strengthenDirectedInhibitory(38 + k, x, 20, 20); }
  }
  // 输入场 → 核（不同强度制造竞争）
  for (const f of [0, 1, 2, 3]) for (const c of cores[0]) { bin.strengthen(f, c, 0.8, 3); spk.strengthen(f, c, 0.8, 3); }
  for (const f of [0, 1]) for (const c of cores[1]) { bin.strengthen(f, c, 0.7, 3); spk.strengthen(f, c, 0.7, 3); }
  // 随机散边
  for (let k = 0; k < 60; k++) {
    const i = Math.floor(rand() * N), j = Math.floor(rand() * N);
    if (i === j) continue;
    const w = rand() * 1.5;
    bin.setWeight(i, j, w); spk.setWeight(i, j, w);
  }
  return { bin, spk };
}

function cmp(tag, r1, r2) {
  const sameSet = r1.activeNeurons.length === r2.activeNeurons.length && r1.activeNeurons.every((v, k) => v === r2.activeNeurons[k]);
  const sameE = r1.energy === r2.energy;
  const sameTrace = r1.trace.energies.length === r2.trace.energies.length && r1.trace.energies.every((v, k) => v === r2.trace.energies[k]);
  const sameMeta = r1.terminationReason === r2.terminationReason && r1.proposals === r2.proposals && r1.acceptedUphill === r2.acceptedUphill;
  console.log(`${tag}：终态 ${sameSet} 能量 ${sameE}(${r1.energy.toFixed(2)}) 轨迹 ${sameTrace}(${r1.trace.energies.length}点) 元信息 ${sameMeta}(${r1.terminationReason}, 提议${r1.proposals}, 上坡${r1.acceptedUphill})`);
  return sameSet && sameE && sameTrace && sameMeta;
}

let allOk = true;
for (const seed of [1, 7, 42]) {
  const { bin, spk } = buildPair(1000 + seed);
  const input = [0, 1, 2, 3];
  const extra = Array.from({ length: N }, (_, i) => i);
  allOk &= cmp(`默认退火 seed=${seed}`,
    bin.settleAnnealed(input, [], { seed, extraCandidates: extra, quenchCandidatesOnly: true, levels: 8, sweepsPerLevel: 16 }),
    spk.settleAnnealed(input, [], { seed, extraCandidates: extra, quenchCandidatesOnly: true, levels: 8, sweepsPerLevel: 16 }));
  const p2 = buildPair(1000 + seed);
  allOk &= cmp(`quietOnly seed=${seed}`,
    p2.bin.settleAnnealed(input, [], { seed, extraCandidates: extra, quenchCandidatesOnly: true, fallbackQuietOnly: true, levels: 8, sweepsPerLevel: 16, quenchMaxFlips: 8 * N }),
    p2.spk.settleAnnealed(input, [], { seed, extraCandidates: extra, quenchCandidatesOnly: true, fallbackQuietOnly: true, levels: 8, sweepsPerLevel: 16, quenchMaxFlips: 8 * N }));
}
// wells 路径
{
  const { bin, spk } = buildPair(7);
  const wells = [{ memberNeuronIds: [20, 21, 22, 23] }, { memberNeuronIds: [24, 25, 26, 27] }];
  allOk &= cmp('带 wells',
    bin.settleAnnealed([0, 1], wells, { seed: 3, levels: 8, sweepsPerLevel: 16 }),
    spk.settleAnnealed([0, 1], wells, { seed: 3, levels: 8, sweepsPerLevel: 16 }));
}
console.log(allOk ? '\n✓ 退火同种子逐位复现' : '\n✗ 退火存在差异');

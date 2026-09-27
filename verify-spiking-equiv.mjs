/** 脉冲网络 ≡ 二值网络 对拍验证（逐位相等才算过）：
 * 同一随机图、同一钳制集，settle 的最终态、能量、能量轨迹数组逐位一致；
 * hebbianLearn 后全部边一致；runStep 账本一致；载体场断言全程开启（自证恒等）。
 * 运行：node verify-spiking-equiv.mjs
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
const ENS = process.env.ENS_PATH ?? fileURLToPath(new URL('../energy-network-sim', import.meta.url)); // 同级克隆 energy-network-sim，或用 ENS_PATH 指定
const imp = (p) => import(pathToFileURL(`${ENS}/${p}`).href);
const { EnergyNetwork, hebbianLearn } = await imp('dist/src/index.js');
const { mulberry32 } = await imp('dist/src/prng.js');
const { SpikingEnergyNetwork, hebbianLearnSpiking } = await import('./mind/spiking-network.mjs');

const rand = mulberry32(20260926);
const N = 60;
const cfg = { neuronCount: N, activationEnergy: 1.0, maintenanceEnergy: 0.5, learningRate: 0.1, maxWeight: 3.0, maxDirectedWeight: 1.0 };

// 同一随机图（W/Γ/DI 都撒）
const bin = new EnergyNetwork(cfg);
const spk = new SpikingEnergyNetwork({ ...cfg, debugAssert: true });
for (let k = 0; k < 200; k++) {
  const i = Math.floor(rand() * N), j = Math.floor(rand() * N);
  if (i === j) continue;
  const kind = rand();
  if (kind < 0.6) { bin.setWeight(i, j, rand() * 2); spk.setWeight(i, j, bin.getWeight(i, j)); }
  else if (kind < 0.8) { bin.strengthenInhibitory(i, j, rand()); spk.strengthenInhibitory(i, j, rand() * 0 + bin.getInhibitoryWeight(i, j) - spk.getInhibitoryWeight(i, j)); }
  else { bin.strengthenDirectedInhibitory(i, j, rand() * 0.8, 1); spk.strengthenDirectedInhibitory(i, j, rand() * 0 + bin.getDirectedInhibitoryWeight(i, j) - spk.getDirectedInhibitoryWeight(i, j), 1); }
}
// 校验图一致
let edgeDiff = 0;
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
  if (bin.getWeight(i, j) !== spk.getWeight(i, j)) edgeDiff++;
  if (bin.getInhibitoryWeight(i, j) !== spk.getInhibitoryWeight(i, j)) edgeDiff++;
  if (bin.getDirectedInhibitoryWeight(i, j) !== spk.getDirectedInhibitoryWeight(i, j)) edgeDiff++;
}
console.log(`图一致性：边差异 ${edgeDiff}（应为 0）`);

// 同一钳制集
const clamped = [];
for (let i = 0; i < N; i++) if (rand() < 0.25) clamped.push(i);
console.log(`钳制 ${clamped.length} 个神经元`);

const r1 = bin.settle(clamped);
const r2 = spk.settle(clamped);
const sameSet = r1.activeNeurons.length === r2.activeNeurons.length && r1.activeNeurons.every((v, k) => v === r2.activeNeurons[k]);
const sameEnergy = r1.energy === r2.energy;
const sameTrace = r1.trace.energies.length === r2.trace.energies.length && r1.trace.energies.every((v, k) => v === r2.trace.energies[k]);
console.log(`settle：终态一致 ${sameSet}，能量一致 ${sameEnergy}（${r1.energy}），轨迹逐位一致 ${sameTrace}（${r1.trace.energies.length} 点），终止原因 ${r1.terminationReason}/${r2.terminationReason}`);

// hebbianLearn 等价
const pattern = r1.activeNeurons.slice(0, 12);
hebbianLearn(bin, pattern, 4, undefined, 0.4);
hebbianLearnSpiking(spk, pattern, 4, undefined, 0.4);
let wDiff = 0;
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (bin.getWeight(i, j) !== spk.getWeight(i, j)) wDiff++;
console.log(`hebbianLearn：写后边差异 ${wDiff}（应为 0）`);

// runStep 账本等价
bin.resetLedger(); spk.resetLedger();
for (let k = 0; k < 20; k++) {
  const p = [];
  for (let i = 0; i < N; i++) if (rand() < 0.3) p.push(i);
  bin.runStep(p); spk.runStep(p);
}
const l1 = bin.ledger(), l2 = spk.ledger();
console.log(`runStep 账本：${JSON.stringify(l1)} vs ${JSON.stringify(l2)} → ${l1.activationCost === l2.activationCost && l1.maintenanceCost === l2.maintenanceCost && l1.activationCount === l2.activationCount ? '一致' : '✗ 不一致'}`);
console.log(`载体层：${spk.spikeLog.length} 条脉冲事件（容量 ${spk.spikeLogCap}），断言全程无异常`);
console.log(sameSet && sameEnergy && sameTrace && edgeDiff === 0 && wDiff === 0 ? '\n✓ 脉冲载体 ≡ 二值语义（逐位）' : '\n✗ 存在差异');

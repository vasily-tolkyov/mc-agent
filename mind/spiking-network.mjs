/** 脉冲能量网络（Tier-2 研究主线）：EnergyNetwork 的脉冲载体等价实现。
 *
 * 语义地基（与主 agent 对齐过的选项 A，无工程近似）：
 * 二值 EnergyNetwork 在数学上 ≡ 异步 Glauber 动力学的玻尔兹曼机。本实现只换
 * 信号载体——局部场 h_i = Σ(W−Γ−DI)·s 不再瞬时求和，而是以**带符号脉冲事件**
 * 在神经元之间传递（激活即对全部出边发 +W/−Γ/−DI 脉冲，目标神经元泄漏积分），
 * 决策（异步 Glauber，T=0 阈值 / T>0 logistic）读取脉冲累计场。调试模式逐点
 * 断言脉冲场 ≡ 语义场（|差| < 1e-9）——等价性由机器自证，不是口头宣称。
 *
 * 语义与二值版逐点一致：E(s) = θΣs − ΣW + ΣΓ（θ=Ea+Em）；settle 异步贪心
 * （同一扫描顺序、同一 EPS、同一最优回退）⇒ 轨迹逐位相同（有对拍测试）；
 * 退火 = Metropolis 温度曲线 + 淬火（同 mulberry32 种子逐位复现）。
 * Lyapunov 保证成立的条件与二值版相同：异步更新（事件调度器一次评估一个神经元）。
 *
 * 载体参数（不改变计算语义，只改变脉冲的物理走时，全部公开）：
 * - propDelay：脉冲传播延迟 δ（必须 ≪ 两次相邻评估的间隔，等价性约束）；
 * - refractory：发放后不应期（该窗内该神经元不再被调度评估）；
 * - tauLeak：膜电压泄漏时间常数（只影响示波层 V 的读数，不进决策）。
 * 示波层（V/脉冲事件流）是语义翻转的物理承载与观察窗，可导出做放电光栅分析。
 */
import { fileURLToPath, pathToFileURL } from 'node:url';

const ENS = process.env.ENS_PATH ?? fileURLToPath(new URL('../../energy-network-sim', import.meta.url)); // 同级克隆 energy-network-sim，或用 ENS_PATH 指定
const { mulberry32 } = await import(pathToFileURL(`${ENS}/dist/src/prng.js`).href);

/** 稀疏边存储（语义与 energy-network-sim/src/sparse.ts 逐位一致） */
class SparseMatrix {
  constructor() { this.rows = new Map(); }
  get(i, j) { return this.rows.get(i)?.get(j) ?? 0; }
  set(i, j, v) {
    if (v === 0) {
      const r = this.rows.get(i);
      if (r) { r.delete(j); if (r.size === 0) this.rows.delete(i); }
      return;
    }
    let r = this.rows.get(i);
    if (!r) { r = new Map(); this.rows.set(i, r); }
    r.set(j, v);
  }
  clearNeuron(id) {
    this.rows.delete(id);
    for (const r of this.rows.values()) r.delete(id);
  }
  *rowEntries(i) { const r = this.rows.get(i); if (r) for (const [j, w] of r) yield [j, w]; }
  *entries() { for (const [i, r] of this.rows) for (const [j, w] of r) yield [i, j, w]; }
  get edgeCount() { let n = 0; for (const r of this.rows.values()) n += r.size; return n; }
}

export class SpikingEnergyNetwork {
  constructor(configInput) {
    const cfg = {
      activationEnergy: configInput.activationEnergy ?? 1.0,
      maintenanceEnergy: configInput.maintenanceEnergy ?? 0.5,
      learningRate: configInput.learningRate ?? 0.1,
      maxWeight: configInput.maxWeight ?? 1.0,
      maxDirectedWeight: configInput.maxDirectedWeight ?? 1.0,
      wellRatio: configInput.wellRatio ?? 0.8,
      readoutThreshold: configInput.readoutThreshold ?? 0.5,
      neuronCount: configInput.neuronCount,
      // 载体参数（不属二值版配置；只影响脉冲走时，不进决策语义）
      propDelay: configInput.propDelay ?? 0.05,
      refractory: configInput.refractory ?? 0.5,
      tauLeak: configInput.tauLeak ?? 5.0,
    };
    if (!Number.isInteger(cfg.neuronCount) || cfg.neuronCount < 2) throw new Error(`neuronCount must be an integer >= 2, got ${cfg.neuronCount}`);
    this.config = cfg;
    const n = cfg.neuronCount;
    this.weights = new SparseMatrix();
    this.directed = new SparseMatrix();
    this.inhibitory = new SparseMatrix();
    this.directedInhibitory = new SparseMatrix();
    this.inhibitionOwners = new Map();
    this.state = new Uint8Array(n);
    // ── 脉冲载体层（示波/承载；决策不读它，等价性由 assertFieldEquivalence 自证）──
    this.V = new Float64Array(n);            // 膜电压（泄漏积分带符号脉冲）
    this.refUntil = new Float64Array(n);     // 不应期截止（事件时间）
    this.spikeLog = [];                      // {t, from, to, w} 已派发脉冲（有容量上限）
    this.spikeLogCap = configInput.spikeLogCap ?? 200000;
    this.clock = 0;                          // 事件时间（评估步进）
    this.debugAssert = configInput.debugAssert ?? false;
    this.ledgerActivationCost = 0;
    this.ledgerMaintenanceCost = 0;
    this.ledgerActivationCount = 0;
  }

  get neuronCount() { return this.config.neuronCount; }
  /** 模式选择阈值：从静息启动一个神经元，场强须覆盖启动+单位维持成本 */
  get threshold() { return this.config.activationEnergy + this.config.maintenanceEnergy; }

  // ── 权重 API（语义与二值版逐位一致）──
  checkEdge(i, j, value) {
    for (const k of [i, j]) {
      if (!Number.isInteger(k) || k < 0 || k >= this.neuronCount) throw new Error(`neuron index out of range: ${k}`);
    }
    if (!Number.isFinite(value)) throw new Error(`weight delta must be finite, got ${value}`);
  }
  getWeight(i, j) { return this.weights.get(i, j); }
  strengthen(i, j, delta, cap) {
    this.checkEdge(i, j, delta);
    if (cap !== undefined && !(cap >= 0)) throw new Error(`cap must be nonnegative, got ${cap}`);
    if (i === j || delta <= 0) return;
    const limit = cap ?? this.config.maxWeight;
    const cur = this.weights.get(i, j);
    if (cur >= limit) return;
    const next = Math.min(limit, cur + delta);
    this.weights.set(i, j, next);
    this.weights.set(j, i, next);
  }
  setWeight(i, j, value) {
    this.checkEdge(i, j, value);
    if (i === j) return;
    const v = Math.max(0, Math.min(this.config.maxWeight, value));
    this.weights.set(i, j, v);
    this.weights.set(j, i, v);
  }
  getDirectedWeight(from, to) { return this.directed.get(from, to); }
  strengthenDirected(from, to, delta) {
    this.checkEdge(from, to, delta);
    if (from === to || delta <= 0) return;
    this.directed.set(from, to, Math.min(this.config.maxDirectedWeight, this.directed.get(from, to) + delta));
  }
  getInhibitoryWeight(i, j) { return this.inhibitory.get(i, j); }
  strengthenInhibitory(i, j, delta) {
    this.checkEdge(i, j, delta);
    if (i === j || delta <= 0) return;
    const n = this.neuronCount;
    const owned = this.inhibitionOwners.get(Math.min(i, j) * n + Math.max(i, j));
    if (owned) {
      owned.base = Math.min(this.config.maxWeight, owned.base + delta);
      this.writeOwnedInhibition(i, j, owned);
      return;
    }
    const next = Math.min(this.config.maxWeight, this.inhibitory.get(i, j) + delta);
    this.inhibitory.set(i, j, next);
    this.inhibitory.set(j, i, next);
  }
  decayInhibition(i, j, delta) {
    this.checkEdge(i, j, delta);
    if (delta < 0) throw new Error('inhibition decay must be nonnegative');
    const owned = this.inhibitionOwners.get(Math.min(i, j) * this.neuronCount + Math.max(i, j));
    if (owned) {
      owned.base = Math.max(0, owned.base - delta);
      this.writeOwnedInhibition(i, j, owned);
      return;
    }
    const next = Math.max(0, this.getInhibitoryWeight(i, j) - delta);
    this.inhibitory.set(i, j, next);
    this.inhibitory.set(j, i, next);
  }
  setInhibitionContribution(i, j, owner, value) {
    this.checkEdge(i, j, value);
    if (value < 0) throw new Error('inhibition contribution must be nonnegative');
    if (i === j) return;
    const key = Math.min(i, j) * this.neuronCount + Math.max(i, j);
    const entry = this.inhibitionOwners.get(key) ?? { base: this.getInhibitoryWeight(i, j), values: new Map() };
    if (value === 0) entry.values.delete(owner); else entry.values.set(owner, value);
    this.writeOwnedInhibition(i, j, entry);
    if (entry.values.size) this.inhibitionOwners.set(key, entry); else this.inhibitionOwners.delete(key);
  }
  writeOwnedInhibition(i, j, entry) {
    const value = Math.min(this.config.maxWeight, entry.base + [...entry.values.values()].reduce((a, b) => a + b, 0));
    this.inhibitory.set(i, j, value);
    this.inhibitory.set(j, i, value);
  }
  clearSynapses(ids) {
    const list = [...ids];
    const n = this.neuronCount;
    for (const id of list) {
      if (!Number.isInteger(id) || id < 0 || id >= n) throw new Error(`neuron index out of range: ${id}`);
    }
    for (const id of list) {
      this.weights.clearNeuron(id);
      this.directed.clearNeuron(id);
      this.inhibitory.clearNeuron(id);
      this.directedInhibitory.clearNeuron(id);
    }
    for (const key of [...this.inhibitionOwners.keys()]) {
      const i = Math.floor(key / n), j = key % n;
      if (list.includes(i) || list.includes(j)) this.inhibitionOwners.delete(key);
    }
    this.diSourceCache = null;
  }
  getDirectedInhibitoryWeight(from, to) { return this.directedInhibitory.get(from, to); }
  strengthenDirectedInhibitory(from, to, delta, cap) {
    this.checkEdge(from, to, delta);
    if (cap !== undefined && !(cap >= 0)) throw new Error(`cap must be nonnegative, got ${cap}`);
    if (from === to || delta <= 0) return;
    this.diSourceCache = null;
    const limit = cap ?? this.config.maxDirectedWeight;
    this.directedInhibitory.set(from, to, Math.min(limit, this.directedInhibitory.get(from, to) + delta));
  }

  // ── 场（语义版：瞬时求和；脉冲版：读脉冲累计——调试断言两者恒等）──
  localField(i, pattern) {
    const n = this.neuronCount;
    let h = 0;
    for (let j = 0; j < n; j++) if (pattern[j] === 1) h += this.weights.get(i, j);
    return h;
  }
  inhibitoryField(i, pattern) {
    const n = this.neuronCount;
    let g = 0;
    for (let j = 0; j < n; j++) if (pattern[j] === 1) g += this.inhibitory.get(i, j);
    return g;
  }
  directedField(i, pattern) {
    const n = this.neuronCount;
    let g = 0;
    for (let j = 0; j < n; j++) if (pattern[j] === 1) g += this.directed.get(j, i);
    return g;
  }
  directedInhibitoryField(i, pattern) {
    const n = this.neuronCount;
    let g = 0;
    for (let j = 0; j < n; j++) if (pattern[j] === 1) g += this.directedInhibitory.get(j, i);
    return g;
  }
  symmetricField(i, pattern) {
    return this.localField(i, pattern) - this.inhibitoryField(i, pattern) - this.directedInhibitoryField(i, pattern);
  }

  /** 脉冲派发：神经元 i 状态翻转 → 对其全部出边派发带符号脉冲（事件时间 t=clock） */
  emitSpikes(i, sign) {
    const t = this.clock, delta = this.config.propDelay;
    const deliver = (matrix, sgn) => {
      for (const [j, w] of matrix.rowEntries(i)) {
        this.V[j] += sgn * sign * w; // 传播延迟 δ 并入事件时间；δ≪评估间隔 ⇒ 下次评估前必达（等价性约束）
        if (this.spikeLog.length < this.spikeLogCap) this.spikeLog.push({ t: t + delta, from: i, to: j, w: sgn * sign * w });
      }
    };
    deliver(this.weights, +1);
    deliver(this.inhibitory, -1);
    deliver(this.directedInhibitory, -1); // DI 与 W/Γ 同向承载（方向由矩阵自身定向性保证）
    this.V[i] += sign > 0 ? this.threshold : -this.threshold; // 自体膜压（示波层）
    this.refUntil[i] = this.clock + this.config.refractory;
  }

  /** 脉冲累计场（载体读数）：等价于 Σ(W−Γ)·s − ΣDI[入]·s——DI 不对称，必须按入边计
   * （初版按出边行读被断言当场抓包——自证机制开工了） */
  spikedField(i) {
    const n = this.neuronCount;
    let h = 0;
    for (let j = 0; j < n; j++) {
      if (this.state[j] !== 1) continue;
      h += this.weights.get(i, j) - this.inhibitory.get(i, j) - this.directedInhibitory.get(j, i);
    }
    return h;
  }
  assertFieldEquivalence(i) {
    if (!this.debugAssert) return;
    const a = this.spikedField(i), b = this.symmetricField(i, this.state);
    if (Math.abs(a - b) > 1e-9) throw new Error(`载体场/语义场不一致: neuron ${i} spiked=${a} semantic=${b}`);
  }

  /** 状态翻转（语义）+ 脉冲派发（载体） */
  flip(i) {
    this.state[i] = this.state[i] === 1 ? 0 : 1;
    this.emitSpikes(i, this.state[i] === 1 ? +1 : -1);
  }

  isActive(i) { return this.state[i] === 1; }
  activeNeurons() {
    const out = [];
    for (let i = 0; i < this.state.length; i++) if (this.state[i] === 1) out.push(i);
    return out;
  }
  reset() { this.state.fill(0); this.V.fill(0); }

  /** 模式总能量 E(s) = θΣs − ΣW·s·s + ΣΓ·s·s（与二值版逐位一致） */
  energy(pattern) {
    const s = pattern ?? this.state;
    const n = this.neuronCount;
    const theta = this.threshold;
    let e = 0;
    for (let i = 0; i < n; i++) {
      if (s[i] !== 1) continue;
      e += theta;
      for (let j = i + 1; j < n; j++) {
        if (s[j] === 1) {
          e -= this.weights.get(i, j);
          e += this.inhibitory.get(i, j);
        }
      }
    }
    return e;
  }

  /**
   * settle（要求 5、7、10）：输入钳制 → 异步 Glauber 扫描至局部极小。
   * 与二值版同一扫描顺序、同一 EPS、同一最优回退、同一预算 ⇒ 轨迹逐位相同（对拍验证）。
   */
  settle(inputNeurons) {
    const n = this.neuronCount;
    const clamped = new Uint8Array(n);
    for (const i of inputNeurons) {
      if (!Number.isInteger(i) || i < 0 || i >= n) throw new Error(`input neuron index out of range: ${i}`);
      clamped[i] = 1;
    }
    this.state.fill(0);
    this.V.fill(0);
    for (let i = 0; i < n; i++) if (clamped[i] === 1) { this.state[i] = 1; this.emitSpikes(i, +1); }

    const theta = this.threshold;
    const energies = [this.energy()];
    let currentEnergy = energies[0];
    let flipCount = 0;
    let driveWork = 0;
    const EPS = 1e-4;
    const maxFlips = 100 * n;
    let bestEnergy = currentEnergy;
    const bestState = Uint8Array.from(this.state);
    let terminated = 'fixed-point';
    outer: for (;;) {
      let flippedThisSweep = false;
      for (let i = 0; i < n; i++) {
        if (clamped[i] === 1) continue;
        this.clock++; // 事件时间推进（一次评估一个神经元：异步是 Lyapunov 的成立条件）
        this.assertFieldEquivalence(i);
        const hCons = this.localField(i, this.state) - this.inhibitoryField(i, this.state);
        const di = this.directedInhibitoryField(i, this.state);
        const active = this.state[i] === 1;
        const dEDecision = active ? -(theta - (hCons - di)) : theta - (hCons - di);
        if (dEDecision >= -EPS) continue;
        const dECons = active ? -(theta - hCons) : theta - hCons;
        this.flip(i);
        flipCount++;
        flippedThisSweep = true;
        currentEnergy += dECons;
        driveWork += dEDecision - dECons;
        energies.push(currentEnergy);
        if (currentEnergy < bestEnergy) {
          bestEnergy = currentEnergy;
          bestState.set(this.state);
        }
        if (flipCount >= maxFlips) {
          terminated = 'flip-budget';
          this.state.set(bestState);
          energies.push(bestEnergy);
          break outer;
        }
      }
      if (!flippedThisSweep) break;
    }
    return {
      activeNeurons: this.activeNeurons(),
      energy: this.energy(),
      trace: { energies, flipCount, driveWork },
      converged: terminated === 'fixed-point',
      terminationReason: terminated,
      residualFlips: this.countResidualFlips((i) => clamped[i] === 1, null, EPS),
    };
  }

  countResidualFlips(isClamped, scope, eps) {
    const theta = this.threshold;
    const n = this.neuronCount;
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (scope !== null && !scope.has(i)) continue;
      if (isClamped(i)) continue;
      const h = this.symmetricField(i, this.state);
      const dE = this.state[i] === 0 ? theta - h : -(theta - h);
      if (dE < -eps) count++;
    }
    return count;
  }

  /** 时序记账（要求 1–4，与二值版逐位一致） */
  runStep(nextActive) {
    const n = this.neuronCount;
    const next = new Uint8Array(n);
    for (const i of nextActive) {
      if (!Number.isInteger(i) || i < 0 || i >= n) throw new Error(`input neuron index out of range: ${i}`);
      next[i] = 1;
    }
    for (let i = 0; i < n; i++) {
      const was = this.state[i] === 1;
      const will = next[i] === 1;
      if (!was && will) {
        this.ledgerActivationCost += this.config.activationEnergy;
        this.ledgerActivationCount++;
      } else if (was && will) {
        this.ledgerMaintenanceCost += this.config.maintenanceEnergy;
      }
    }
    this.state.set(next);
    return this.ledger();
  }
  ledger() {
    return {
      activationCost: this.ledgerActivationCost,
      maintenanceCost: this.ledgerMaintenanceCost,
      activationCount: this.ledgerActivationCount,
    };
  }
  resetLedger() {
    this.ledgerActivationCost = 0;
    this.ledgerMaintenanceCost = 0;
    this.ledgerActivationCount = 0;
  }

  /** DI 源神经元缓存（有出向 DI 边的神经元）；写 DI 边时失效重建 */
  diSourceCache = null;
  diDriveEngaged() {
    if (this.diSourceCache === null) {
      const src = [];
      for (const [from] of this.directedInhibitory.entries()) {
        if (src.length === 0 || src[src.length - 1] !== from) src.push(from);
      }
      src.sort((a, b) => a - b);
      this.diSourceCache = src;
    }
    if (this.diSourceCache.length === 0) return false;
    const theta = this.threshold;
    for (const j of this.diSourceCache) {
      if (this.state[j] === 1) return true;
      const h = this.localField(j, this.state) - this.inhibitoryField(j, this.state);
      if (h > theta) return true; // 即将点燃
    }
    return false;
  }

  /** 恢复状态后同步脉冲载体：清空膜压并重发全部激活神经元的脉冲（示波层与语义态对齐） */
  resyncCarrier() {
    this.V.fill(0);
    for (let i = 0; i < this.neuronCount; i++) if (this.state[i] === 1) this.emitSpikes(i, +1);
  }

  /**
   * 局部退火模式选择（语义与二值版 settleAnnealed 逐位一致：同 mulberry32 种子、
   * 同一洗牌/提议/接受顺序、同一淬火与最优回退 ⇒ 同种子下轨迹逐位复现——对拍验证）。
   * 唯一增量：每次翻转经 flip 闭包派发载体脉冲（不进任何账本与决策）。
   */
  settleAnnealed(inputNeurons, wells, options = {}) {
    const n = this.neuronCount;
    const clamped = new Set();
    for (const i of inputNeurons) {
      if (!Number.isInteger(i) || i < 0 || i >= n) throw new Error(`input neuron index out of range: ${i}`);
      clamped.add(i);
    }

    const theta = this.threshold;
    const coolingFactor = options.coolingFactor ?? 0.7;
    const levels = options.levels ?? 20;
    const sweepsPerLevel = options.sweepsPerLevel ?? 30;
    if (!(coolingFactor > 0 && coolingFactor < 1)) throw new Error(`coolingFactor must be in (0, 1), got ${coolingFactor}`);
    if (!Number.isInteger(levels) || levels < 1) throw new Error(`levels must be an integer >= 1, got ${levels}`);
    if (!Number.isInteger(sweepsPerLevel) || sweepsPerLevel < 1) throw new Error(`sweepsPerLevel must be an integer >= 1, got ${sweepsPerLevel}`);
    if (!Number.isInteger(options.quenchMaxFlips ?? 100 * n)) throw new Error('quenchMaxFlips must be an integer');
    const quietOnly = options.fallbackQuietOnly ?? false;
    let temperature = options.initialTemperature ?? theta;
    if (!(temperature > 0)) throw new Error(`initialTemperature must be positive, got ${temperature}`);
    const extraCandidates = options.extraCandidates ? [...options.extraCandidates] : [];
    for (const id of extraCandidates) {
      if (!Number.isInteger(id) || id < 0 || id >= n) throw new Error(`neuron index out of range: ${id}`);
    }
    for (const well of wells) for (const id of well.memberNeuronIds) {
      if (!Number.isInteger(id) || id < 0 || id >= n) throw new Error(`neuron index out of range: ${id}`);
    }
    this.state.fill(0);
    for (const i of clamped) { this.state[i] = 1; this.emitSpikes(i, +1); }
    const initialEnergy = this.energy();
    let activeIds = this.activeNeurons();
    const consF = new Float64Array(n);
    const diF = new Float64Array(n);
    const recomputeFields = () => {
      consF.fill(0);
      diF.fill(0);
      for (const j of activeIds) {
        for (const [k, w] of this.weights.rowEntries(j)) consF[k] += w;
        for (const [k, g] of this.inhibitory.rowEntries(j)) consF[k] -= g;
        for (const [k, d] of this.directedInhibitory.rowEntries(j)) diF[k] += d;
      }
    };
    recomputeFields();
    const flip = (id) => {
      const sign = this.state[id] === 1 ? -1 : 1;
      for (const [k, w] of this.weights.rowEntries(id)) consF[k] += sign * w;
      for (const [k, g] of this.inhibitory.rowEntries(id)) consF[k] -= sign * g;
      for (const [k, d] of this.directedInhibitory.rowEntries(id)) diF[k] += sign * d;
      if (sign === 1) {
        this.state[id] = 1;
        const at = activeIds.findIndex((j) => j > id);
        activeIds.splice(at < 0 ? activeIds.length : at, 0, id);
      } else {
        this.state[id] = 0;
        activeIds.splice(activeIds.indexOf(id), 1);
      }
      this.emitSpikes(id, sign); // 载体派发（不进账本/决策）
    };
    const restore = (snapshot) => {
      this.state.set(snapshot);
      activeIds = this.activeNeurons();
      recomputeFields();
      this.resyncCarrier();
    };
    const fields = (i) => ({ cons: consF[i], di: diF[i] });
    this.diDriveEngaged();
    const quietNow = () => this.diSourceCache.every((j) => this.state[j] === 0 && fields(j).cons <= this.threshold);
    const quietAfterMoves = (ids) => {
      for (const j of this.diSourceCache) {
        let active = this.state[j] === 1;
        let cons = consF[j];
        for (const x of ids) {
          const sign = this.state[x] === 1 ? -1 : 1;
          cons += sign * (this.weights.get(x, j) - this.inhibitory.get(x, j));
          if (x === j) active = !active;
        }
        if (active || cons > this.threshold) return false;
      }
      return true;
    };

    const candidate = new Set(clamped);
    for (const well of wells) {
      if (well.memberNeuronIds.some((id) => clamped.has(id))) {
        for (const id of well.memberNeuronIds) if (id >= 0 && id < n) candidate.add(id);
      }
    }
    if (extraCandidates) {
      for (const id of extraCandidates) if (id >= 0 && id < n) candidate.add(id);
    }
    const freeCandidates = [...candidate].filter((id) => !clamped.has(id)).sort((a, b) => a - b);

    const freeRank = new Int32Array(n).fill(-1);
    const rand = mulberry32(options.seed ?? 1);
    let proposals = 0;
    let acceptedUphill = 0;
    let driveWork = 0;
    let flipCount = 0;
    const deltas = (i) => {
      const { cons: hCons, di } = fields(i);
      const active = this.state[i] === 1;
      return {
        decision: active ? -(theta - (hCons - di)) : theta - (hCons - di),
        cons: active ? -(theta - hCons) : theta - hCons,
      };
    };
    let currentEnergy = initialEnergy;
    let hasQuietCandidate = !quietOnly || quietNow();
    let bestEnergy = hasQuietCandidate ? initialEnergy : Infinity;
    const bestState = Uint8Array.from(this.state);
    const maxFlips = options.quenchMaxFlips ?? 100 * n;
    const EPS = 1e-4;
    let quenchScopeSet = new Set();
    const quenchEnergies = [];
    let quenchEnergy = initialEnergy;
    let quenchBestEnergy = initialEnergy;
    const quenchBestState = Uint8Array.from(this.state);
    let terminated = 'fixed-point';
    let annealEndEnergy = initialEnergy;
    for (let cycle = 0; ; cycle++) {
      if (cycle > 0) {
        temperature = options.initialTemperature ?? theta;
        restore(bestState);
        currentEnergy = this.energy();
      }
      for (let level = 0; level < levels; level++, temperature *= coolingFactor) {
        for (let sweep = 0; sweep < sweepsPerLevel; sweep++) {
          for (let k = freeCandidates.length - 1; k > 0; k--) {
            const j = Math.floor(rand() * (k + 1));
            const tmp = freeCandidates[k];
            freeCandidates[k] = freeCandidates[j];
            freeCandidates[j] = tmp;
          }
          for (let k = 0; k < freeCandidates.length; k++) freeRank[freeCandidates[k]] = k;
          for (const i of freeCandidates) {
            const { decision, cons } = deltas(i);
            proposals++;
            let move = [i];
            let decisionDelta = decision;
            let conservativeDelta = cons;
            if (quietOnly) {
              const legal = quietAfterMoves([i]);
              if (!legal) {
                if (this.state[i] === 1) continue;
                const activeFree = activeIds.filter((j) => freeRank[j] >= 0).sort((a, b) => freeRank[a] - freeRank[b]);
                if (!activeFree.length) continue;
                const j = activeFree[Math.floor(rand() * activeFree.length)];
                conservativeDelta += deltas(j).cons + this.getWeight(i, j) - this.getInhibitoryWeight(i, j);
                decisionDelta = conservativeDelta;
                const exchangeLegal = quietAfterMoves([i, j]);
                if (!exchangeLegal) continue;
                move = [j, i];
              }
            }
            if (decisionDelta >= 0 && rand() >= Math.exp(-decisionDelta / temperature)) continue;
            if (decisionDelta >= 0) acceptedUphill++;
            for (const id of move) flip(id);
            flipCount += move.length;
            currentEnergy += conservativeDelta;
            driveWork += decisionDelta - conservativeDelta;
            if (currentEnergy < bestEnergy && !(quietOnly && !quietNow())) {
              hasQuietCandidate = true;
              bestEnergy = currentEnergy;
              bestState.set(this.state);
            }
          }
        }
      }
      if (!hasQuietCandidate) {
        this.state.fill(0);
        return { activeNeurons: [], energy: 0, trace: { energies: [0], flipCount, driveWork },
          converged: false, terminationReason: 'no-quiet-candidate', residualFlips: 0,
          candidateSet: [...candidate], initialEnergy, annealEndEnergy: 0, proposals, acceptedUphill };
      }
      if (quietOnly || bestEnergy < currentEnergy) restore(bestState);
      annealEndEnergy = this.energy();

      quenchEnergy = annealEndEnergy;
      quenchBestEnergy = annealEndEnergy;
      quenchBestState.set(this.state);
      const quenchScope = options.quenchCandidatesOnly
        ? freeCandidates
        : Array.from({ length: n }, (_, i) => i);
      quenchScopeSet = new Set(quenchScope);
      let quenchFlips = 0;
      if (quietOnly) {
        for (;;) {
          const quietAfter = quietAfterMoves;
          const proposalsQ = quenchScope.filter((i) => !clamped.has(i)).map((i) => ({ i, delta: deltas(i).cons }));
          let move = [];
          let improvement = -EPS;
          for (const { i, delta } of proposalsQ) if (delta < improvement && quietAfter([i])) {
            move = [i]; improvement = delta;
          }
          if (!move.length) {
            const on = proposalsQ.filter((p) => this.state[p.i] === 1);
            const off = proposalsQ.filter((p) => this.state[p.i] === 0);
            for (const x of on) for (const y of off) {
              const delta = x.delta + y.delta + this.getWeight(x.i, y.i) - this.getInhibitoryWeight(x.i, y.i);
              if (delta < improvement && quietAfter([x.i, y.i])) { move = [x.i, y.i]; improvement = delta; }
            }
          }
          if (!move.length) {
            terminated = this.countResidualFlips((i) => clamped.has(i), quenchScopeSet, EPS) ? 'quiet-constraint' : 'fixed-point';
            break;
          }
          if (quenchFlips + move.length > maxFlips) { terminated = 'flip-budget'; break; }
          for (const i of move) {
            const { decision, cons } = deltas(i);
            flip(i);
            flipCount++; quenchFlips++;
            quenchEnergy += cons; driveWork += decision - cons;
            quenchEnergies.push(quenchEnergy);
          }
          quenchBestEnergy = quenchEnergy;
          quenchBestState.set(this.state);
        }
      } else {
        outer: for (;;) {
          let flipped = false;
          for (const i of quenchScope) {
            if (clamped.has(i)) continue;
            const { decision, cons } = deltas(i);
            if (decision < -EPS) {
              if (quenchFlips >= maxFlips) {
                terminated = 'flip-budget';
                restore(quenchBestState);
                quenchEnergies.push(quenchBestEnergy);
                break outer;
              }
              flip(i);
              flipCount++;
              quenchFlips++;
              quenchEnergy += cons;
              driveWork += decision - cons;
              quenchEnergies.push(quenchEnergy);
              if (quenchEnergy < quenchBestEnergy && !(quietOnly && !quietNow())) {
                quenchBestEnergy = quenchEnergy;
                quenchBestState.set(this.state);
              }
              flipped = true;
              if (quenchFlips >= maxFlips) {
                terminated = 'flip-budget';
                restore(quenchBestState);
                quenchEnergies.push(quenchBestEnergy);
                break outer;
              }
            }
          }
          if (!flipped) break;
        }
      }
      const cycleEndEnergy = this.energy();
      if (quietOnly && quietNow() && cycleEndEnergy < bestEnergy) {
        bestEnergy = cycleEndEnergy;
        bestState.set(this.state);
      }
      if (!(quietOnly && terminated === 'quiet-constraint' && cycle < 2)) break;
    }

    if (quietOnly) {
      restore(bestState);
      quenchEnergies.push(this.energy());
    }
    const energies = [annealEndEnergy, ...quenchEnergies];
    return {
      activeNeurons: this.activeNeurons(),
      energy: this.energy(),
      trace: { energies, flipCount, driveWork },
      converged: terminated === 'fixed-point',
      terminationReason: terminated,
      residualFlips: this.countResidualFlips((i) => clamped.has(i), quenchScopeSet, EPS),
      candidateSet: [...candidate].sort((a, b) => a - b),
      initialEnergy,
      annealEndEnergy,
      proposals,
      acceptedUphill,
    };
  }
}

/** 赫布学习（语义与二值版 hebbianLearn 逐位一致：全批校验后逐对 strengthen） */
export function hebbianLearnSpiking(network, activePattern, repeats = 1, eta, cap) {
  const neurons = [...new Set(activePattern)].sort((a, b) => a - b);
  const step = eta ?? network.config.learningRate;
  const capEff = cap ?? network.config.maxWeight;
  if (!(Number.isInteger(repeats) && repeats > 0)) throw new Error(`repeats must be a positive integer, got ${repeats}`);
  if (!(step > 0)) throw new Error(`learningRate must be positive, got ${step}`);
  if (!(capEff > 0)) throw new Error(`cap must be positive, got ${capEff}`);
  for (const id of neurons) {
    if (!Number.isInteger(id) || id < 0 || id >= network.neuronCount) throw new Error(`neuron index out of range: ${id}`);
  }
  for (let r = 0; r < repeats; r++) {
    for (let a = 0; a < neurons.length; a++) {
      for (let b = a + 1; b < neurons.length; b++) {
        network.strengthen(neurons[a], neurons[b], step, cap);
      }
    }
  }
}

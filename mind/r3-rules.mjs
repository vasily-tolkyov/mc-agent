/** R3 因素规则库：R2B 差分出的抽象规则，物化进同一个二值能量网络基质
 * （模拟神经网络存规则——不是查表）。周期性从差分器全量重建（确定性物化视图：
 * 用 setWeight 绝对写入，强度 ∝ 支持度；结构变化即整网重建，无标签迁移问题）。
 *
 * 网络语义（与 FieldRuleMemory 同一家族但条件语义反转）：
 * - 因素场 → 核：W ∝ log(支持度)（因素维是规则参赛资格，缺一无点火资格）；
 * - 核 → 结果场：星型驱动边（只写实际变化的结果维——结果侧不稀释）；
 * - 否决 Γ：因素维的"已观察替代值"感受野 → 核（该维取别的值时本规则被压下）；
 * - WTA 池：2 池神经元，联盟越大压制越强，逐淘汰至单核胜出（沿用 wireNewCore 拓扑）。
 *
 * 读出 = 规划链的"反查"接口：钳置查询帧 → 退火 → 获胜核 → 读其规则的因素与结果。
 */
import { fileURLToPath, pathToFileURL } from 'node:url';

const ENS = process.env.ENS_PATH ?? fileURLToPath(new URL('../../energy-network-sim', import.meta.url)); // 同级克隆 energy-network-sim，或用 ENS_PATH 指定
const imp = (p) => import(pathToFileURL(`${ENS}/${p}`).href);
const { EnergyNetwork } = await imp('dist/src/network.js');
const { SensoryEncoder } = await imp('dist/src/pop/concept/sensory.js');

const CORE_SIZE = 4;
const POOL_SIZE = 2;
const POOL_GAMMA = 20;
const outName = (d) => 'next' + d[0].toUpperCase() + d.slice(1); // 结果维独立命名空间（条件/结果同名字段会跨维接力，FieldRuleMemory 幻影块教训）

/** 基质注入点：默认二值 EnergyNetwork；NET_SUBSTRATE=spiking 时换 SpikingEnergyNetwork
 * （脉冲载体与二值语义逐位等价——对拍测试在 verify-spiking-equiv/anneal.mjs） */
let netClassOverride = null;
export function setR3NetClass(cls) { netClassOverride = cls; }

export class FactorRuleNet {
  /**
   * @param conceptCaps 每维概念容量（bins = cap+1 含未知档）
   * @param actionBins 动作维档数
   */
  constructor(conceptCaps, actionBins) {
    this.conceptCaps = conceptCaps;
    this.stateDims = Object.keys(conceptCaps);
    const pad = (bins) => ({ min: -0.5, max: bins - 0.5, sigma: 0.225 }); // 离散档不相交（长链渗色教训）
    const dims = [
      ...this.stateDims.map((name) => ({ name, ...pad(conceptCaps[name] + 1) })),
      { name: 'act', ...pad(actionBins) },
      ...this.stateDims.map((name) => ({ name: 'next' + name[0].toUpperCase() + name.slice(1), ...pad(conceptCaps[name] + 1) })),
    ];
    this.outcomeDims = this.stateDims.map((d) => 'next' + d[0].toUpperCase() + d.slice(1));
    this.enc = new SensoryEncoder(dims, Math.max(2, 5 * (actionBins + 1)));
    this.rules = [];
    this.net = null;
    this.refreshCount = 0;
  }

  /** 从 R2 差分器全量重建（规则集 → 网络物化视图） */
  rebuild(rules, altValues) {
    this.rules = rules.map((r) => ({ ...r }));
    const coreBase = this.enc.neuronCount;
    const n = coreBase + Math.max(1, rules.length) * CORE_SIZE + POOL_SIZE;
    this.net = new (netClassOverride ?? EnergyNetwork)({ neuronCount: n, activationEnergy: 1.0, maintenanceEnergy: 0.5, learningRate: 0.1, maxWeight: 3.0 });
    const poolBase = n - POOL_SIZE;
    this.poolBase = poolBase;
    this.rules.forEach((rule, i) => { // 注意：核要挂在副本上（挂原数组上 predict 读不到——实测 bug）
      const core = Array.from({ length: CORE_SIZE }, (_, k) => coreBase + i * CORE_SIZE + k);
      rule.core = core;
      // 因素场 → 核：强度随支持度对数增长
      const w = Math.min(2.5, 0.8 + 0.15 * Math.log2(1 + rule.support));
      for (const [dim, v] of Object.entries(rule.factors)) {
        for (const f of this.enc.encodeDimension(dim, v)) for (const c of core) this.net.setWeight(f, c, w);
        // 该因素维的已观察替代值 → 核 否决
        for (const alt of altValues.get(dim) ?? []) {
          if (alt === v) continue;
          for (const f of this.enc.encodeDimension(dim, alt)) for (const c of core) this.net.strengthenInhibitory(f, c, 1.2);
        }
      }
      // 动作场 → 核（规则属于某动作，动作也是参赛条件）
      for (const f of this.enc.encodeDimension('act', rule.action)) for (const c of core) this.net.setWeight(f, c, w);
      // 核 → 结果场（星型，只写实际变化的结果维；写入独立的 nextXxx 命名空间）
      for (const [dim, v] of Object.entries(rule.outcomes)) {
        for (const f of this.enc.encodeDimension(outName(dim), v)) for (const c of core) this.net.setWeight(c, f, 0.7);
      }
      // WTA 池接线（沿用 wireNewCore 拓扑：单核沉睡，联盟点燃压制）
      for (const x of core) {
        for (let k = 0; k < POOL_SIZE; k++) {
          this.net.strengthen(x, poolBase + k, 0.3 / (k + 1));
          this.net.strengthenDirectedInhibitory(poolBase + k, x, POOL_GAMMA, POOL_GAMMA);
        }
      }
    });
    this.refreshCount++;
  }

  /** 反查预测：查询帧(全维概念索引)+动作 → 获胜规则与读出。门反转：核的每个条件维须在查询中有支持。 */
  predict(query, action, seed = 1) {
    if (!this.net || !this.rules.length) return { kind: 'empty', rule: null, outcomes: null, energy: 0, converged: true };
    const input = [...this.enc.encode(query), ...this.enc.encodeDimension('act', action)];
    // 反转点火门：核的每个因素维，都要在查询场里有 W 支持（满足影响因素即可，不论其余情境）
    // 两级制：全满足=严格；≥0.75=近似（冷启动期因素集还很宽——少量经验里"恒定"的维很多，
    // 严格门会全灭（实测 L2 敢答率 0），近似层如实标注不装无知，与 FieldRuleMemory 稀疏回退同一家族）
    const scored = [];
    for (const rule of this.rules) {
      const dims = Object.keys(rule.factors);
      let sat = 0;
      for (const dim of dims) {
        const has = this.enc.encodeDimension(dim, query[dim]).some((f) => rule.core.some((c) => this.net.getWeight(f, c) > 0));
        if (has) sat++;
      }
      scored.push({ rule, ratio: dims.length === 0 ? 0 : sat / dims.length });
    }
    let pool = scored.filter((s) => s.ratio >= 1);
    let approximate = false;
    if (!pool.length) {
      pool = scored.filter((s) => s.ratio >= 0.75).sort((a, b) => b.ratio - a.ratio || b.rule.support - a.rule.support).slice(0, 8);
      approximate = true;
    }
    if (!pool.length) return { kind: 'unknown', rule: null, outcomes: null, energy: 0, converged: true };
    const supported = pool.map((s) => s.rule);
    const outcomeFields = this.outcomeDims.flatMap((d) => {
      const off = this.enc.dimensionOffset(d);
      return Array.from({ length: this.enc.fieldsPerDim }, (_, k) => off + k);
    });
    const result = this.net.settleAnnealed(input, [], {
      seed,
      extraCandidates: [...supported.flatMap((r) => r.core), ...outcomeFields, ...Array.from({ length: POOL_SIZE }, (_, k) => this.poolBase + k)],
      quenchCandidatesOnly: true,
      quenchMaxFlips: 8 * this.net.neuronCount,
      fallbackQuietOnly: true,
      levels: 12,
      sweepsPerLevel: 24,
    });
    const active = new Set(result.activeNeurons);
    let winner = null, bestOn = 0;
    for (const rule of supported) {
      const on = rule.core.filter((c) => active.has(c)).length;
      if (on > bestOn) { bestOn = on; winner = rule; }
    }
    if (!winner || bestOn < 3) return { kind: 'ambiguous', rule: null, outcomes: null, energy: result.energy, converged: result.converged, approximate };
    return { kind: 'usable', rule: winner, outcomes: { ...winner.outcomes }, energy: result.energy, converged: result.converged, terminationReason: result.terminationReason, approximate };
  }

  /** 轻量匹配（不退火）：规则因素在当前查询中的满足率，供探索打分用——
   * 语义如实标注为近似（不经过退火竞争，只做因素覆盖统计），用于"哪个动作有戏"的
   * 自适应偏好打分：偏好随规则库更新自动更新，不是手工写死。
   * 中心值语义：因素与查询按中心值容差（0.6）匹配，不按索引号。 */
  matchRules(query, action) {
    return this.rules.filter((r) => r.action === action).map((r) => {
      const dims = Object.keys(r.factors);
      const sat = dims.filter((d) => Number.isFinite(query[d]) && Math.abs(query[d] - r.factors[d]) <= 0.6).length;
      return { rule: r, ratio: dims.length === 0 ? 1 : sat / dims.length, support: r.support };
    }).filter((x) => x.ratio >= 0.75).sort((a, b) => b.ratio - a.ratio || b.rule.support - a.rule.support);
  }
}

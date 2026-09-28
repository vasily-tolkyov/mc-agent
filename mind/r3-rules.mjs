/** R3 因素规则库：R2B 差分出的抽象规则，物化进同一个二值能量网络基质
 * （模拟神经网络存规则——不是查表）。周期性从差分器全量重建（确定性物化视图：
 * 用 setWeight 绝对写入，强度 ∝ 支持度；结构变化即整网重建，无标签迁移问题）。
 *
 * 网络语义（与 FieldRuleMemory 同一家族但条件语义反转，v3 适配三态因素）：
 * - 因素场 → 核：置信度归一化 W_tot·conf_d/Σconf（W_tot ∝ log 证据数 n）——核驱动与因素数无关；
 * - 核 → 结果场：星型驱动边（序数/方位维写 Δ 档，类别维写新值——Δ 语义见 r2-diff v3）；
 * - 否决 Γ：只挂 hard 维的"已观察替代值"感受野（soft 维证据不足，不压整条规则）；
 * - WTA 池：2 池神经元，联盟越大压制越强，逐淘汰至单核胜出（沿用 wireNewCore 拓扑）。
 *
 * 读出 = 规划链的"反查"接口：钳置查询帧 → 退火 → 获胜核 → 读其规则的因素与结果。
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { kindOf, factorValues } from './r2-diff.mjs';

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
      // 因素场 → 核：w_d = W_tot·conf_d/|F|——按因素数归一化（宽规则不再天然更深），
      // 但保留 conf 作权重：强 hard 因素的规则 > 弱 soft 因素的规则（特异性决胜），
      // 实测教训：conf/Σconf 归一化把置信差异抹平，grip 噪声规则反超 logGrip 真规则
      // 证据深度（赫布本义：连接强度 ∝ 共现证据）：E=support·ρ（效价加权证据×复现率下界）。
      // support = Σ效价权重（设计第 8 条"重要事件单次顶多次"——多巴胺广播的记账版；
      // 滞后归因的衰减副本 ×0.5/×0.25 也在这里如实少算，此前用裸计数 n 把两者都抹平了）。
      // 侥幸模式（support=2, ρ=0.005 → E≈0.01）的连接弱到物理上点不燃一个 4 神经元核
      // （驱动 ≪ θ=Ea+Em=1.5）——"反复出现才成规则"由地形深度自然带来，不是计数闸门。
      const evidence = rule.support ?? rule.n ?? 1;
      const depth = 0.12 + 0.88 * Math.min(1, (evidence * (rule.rho ?? 0.5)) / 2.5);
      const W_tot = Math.min(2.5, 0.8 + 0.15 * Math.log2(1 + evidence)) * depth;
      const factorEntries = Object.entries(factorValues(rule));
      const nF = Math.max(1, factorEntries.length);
      for (const [dim, v] of factorEntries) {
        const wd = W_tot * (rule.conf?.[dim] ?? 0.3) / nF;
        for (const f of this.enc.encodeDimension(dim, v)) for (const c of core) this.net.setWeight(f, c, wd);
        // 否决 Γ 只挂 hard 维（soft 维证据不足，压下整条规则太狠）
        if (rule.hard[dim] === undefined) continue;
        for (const alt of altValues.get(dim) ?? []) {
          if (Math.abs(alt - v) <= 0.5) continue;
          for (const f of this.enc.encodeDimension(dim, alt)) for (const c of core) this.net.strengthenInhibitory(f, c, 1.2);
        }
      }
      // 动作场 → 核（参赛条件；同样乘证据深度——无 hard 因素的侥幸规则唯一的驱动来源
      // 就是动作边，不乘深度它会在任何该动作的查询里点燃，实测垃圾规则躺赢退火的根因）
      const wAct = 0.4 * (1 + 0.15 * Math.log2(1 + evidence)) * depth;
      for (const f of this.enc.encodeDimension('act', rule.action)) for (const c of core) this.net.setWeight(f, c, wAct);
      // 核 → 结果场（星型；序数/方位维写 Δ 档（v+4 ∈ 0..8），类别维写新值——Δ 语义见 r2-diff v3；
      // 结果边也乘深度：核侥幸点燃时结果场也不该亮，读出层就压得住）
      for (const [dim, v] of Object.entries(rule.outcomes)) {
        const encV = kindOf(dim) === 'cat' ? v : v + 4;
        for (const f of this.enc.encodeDimension(outName(dim), encV)) for (const c of core) this.net.setWeight(c, f, 0.7 * depth);
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

  /** 反转点火门（结构读取，不退火）：规则 hard 因素维中，在查询场里有 W 边支持核的比例。
   * 满足影响因素即可参赛，不论其余情境（规则泛化定义）；hard 为空 = 无先决条件，恒有资格。 */
  gateRatio(rule, query) {
    const dims = Object.keys(rule.hard);
    if (!dims.length) return 1;
    let sat = 0;
    for (const dim of dims) {
      if (this.enc.encodeDimension(dim, query[dim]).some((f) => rule.core.some((c) => this.net.getWeight(f, c) > 0))) sat++;
    }
    return sat / dims.length;
  }

  /** 共变档案读出（v3 单结果维簇的配套）：获胜核的 co 副作用只在"该副作用自己的规则
   * （同动作、同 Δ）也通过了本次查询的点火门"时并入——否则挖石头会把原木簇里学到的
   * "logGrip 也 +1"漏进石头情境（verify-spiking-structures 的石头查询此前就误报 logGrip:1）。 */
  mergeCo(winner, gated) {
    const merged = { ...winner.outcomes };
    for (const [h, c] of Object.entries(winner.co ?? {})) {
      if (merged[h] !== undefined) continue;
      if (gated.some((r) => r !== winner && r.action === winner.action && r.outcomes[h] === c.delta)) merged[h] = c.delta;
    }
    return merged;
  }

  /** 反查预测：查询帧(全维概念索引)+动作 → 获胜规则与读出。门反转：核的每个条件维须在查询中有支持。 */
  predict(query, action, seed = 1) {
    if (!this.net || !this.rules.length) return { kind: 'empty', rule: null, outcomes: null, energy: 0, converged: true };
    const input = [...this.enc.encode(query), ...this.enc.encodeDimension('act', action)];
    // 两级制：全满足=严格；≥0.75=近似（冷启动期因素集还很宽——少量经验里"恒定"的维很多，
    // 严格门会全灭（实测 L2 敢答率 0），近似层如实标注 approximate，不装无知）
    const scored = this.rules.map((rule) => ({ rule, ratio: this.gateRatio(rule, query) }));
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
    // 共变档案合并读出（v3）：挖原木时 logGrip/grip 一起变——它们是两条等深规则，
    // 退火任选一个核都合法（WTA 池只留一个胜者），读出时把共变 Δ 并入结果——但只并入
    // 本次查询也点火合格的规则（mergeCo），不让别的情境学到的副作用漏进来
    return { kind: 'usable', rule: winner, outcomes: this.mergeCo(winner, supported), energy: result.energy, converged: result.converged, terminationReason: result.terminationReason, approximate };
  }

  /** 规划候选的退火读出（机制本义：候选由地形浮出，不由符号数组过滤）：
   * 钳置当前状态（因素场）+ 目标维的结果场（能产生产生进展的 Δ 类/新值），
   * 结果场经对称 W 反向驱动触及目标的核——退火后浮上来（≥3/4 核激活）的才是候选。
   * 浅井（低证据侥幸规则）物理上浮不上来：它们的核边弱到点不燃（见 rebuild 的 depth）。
   * 返回按证据强度排序的规则（结果已合并共变档案）。 */
  planCandidates(query, goalTargets, seed = 1) {
    if (!this.net || !this.rules.length) return [];
    // 结果场钳置：目标维 → 能进展的 Δ 类（序数/方位）或目标新值（类别）
    const goalClamps = [];
    for (const [d, want] of Object.entries(goalTargets)) {
      const dimName = outName(d);
      const cur = query[d];
      if (kindOf(d) === 'cat') {
        if (Number.isFinite(want)) goalClamps.push(...this.enc.encodeDimension(dimName, want));
        continue;
      }
      if (!Number.isFinite(cur)) continue;
      // 进展钳制（不是命中钳制）：Δ+1 让 logGrip 0→1 虽没到 2，但距目标更近——
      // 只钳"一步到位"的 Δ 会让 dig Δ+1 永远拿不到结果场驱动（实测 0→2 目标断链的根因）
      const d0 = want && typeof want === 'object' && 'min' in want
        ? (cur < want.min ? want.min - cur : cur > want.max ? cur - want.max : 0)
        : Math.abs(cur - want);
      for (let dl = -3; dl <= 3; dl++) {
        const after = cur + dl;
        const d1 = want && typeof want === 'object' && 'min' in want
          ? (after < want.min ? want.min - after : after > want.max ? after - want.max : 0)
          : Math.abs(after - want);
        if (d1 < d0) goalClamps.push(...this.enc.encodeDimension(dimName, dl + 4));
      }
    }
    if (!goalClamps.length) return [];
    const input = [...this.enc.encode(query), ...goalClamps];
    // 规划不设因素门（与 predict 相反）：hard 不满足正是要递归成子目标的——设门会把
    // "因素未满足的真规则"挡在候选外，反向链接永远拼不出第一节（实测：ρ=0.68 的
    // forward→logGrip 规则因 hard 缺 viewWell/itemType 被门杀，链全灭的根因）。
    // 侥幸抑制由证据深度承担（浅井点不燃）；共变合并仍按门过滤（mergeCo 的门义是
    // "副作用自己的规则在本查询成立"，与候选资格不冲突）。
    const gatePassed = this.rules.filter((rule) => this.gateRatio(rule, query) >= 1);
    const gated = this.rules;
    if (!gated.length) return [];
    const result = this.net.settleAnnealed(input, [], {
      seed,
      extraCandidates: [...gated.flatMap((r) => r.core), ...goalClamps, ...Array.from({ length: POOL_SIZE }, (_, k) => this.poolBase + k)],
      quenchCandidatesOnly: true,
      quenchMaxFlips: 8 * this.net.neuronCount,
      fallbackQuietOnly: true,
      levels: 12,
      sweepsPerLevel: 24,
    });
    const active = new Set(result.activeNeurons);
    return gated
      .map((r) => ({ rule: r, on: r.core.filter((c) => active.has(c)).length }))
      .filter((x) => x.on >= 3)
      .map((x) => ({ ...x.rule, outcomes: this.mergeCo(x.rule, gatePassed) }))
      .sort((a, b) => (b.rho ?? 0.5) * Math.log2(2 + (b.n ?? 1)) - (a.rho ?? 0.5) * Math.log2(2 + (a.n ?? 1)));
  }

  /** 轻量匹配（不退火）：规则因素在当前查询中的满足率，供探索打分用——
   * 语义如实标注为近似（不经过退火竞争，只做因素覆盖统计），用于"哪个动作有戏"的
   * 自适应偏好打分：偏好随规则库更新自动更新，不是手工写死。
   * 中心值语义 + 三态因素（v3）：hard 维缺一即出局（ratio=0）；soft 维计入满足率。 */
  matchRules(query, action) {
    return this.rules.filter((r) => r.action === action).map((r) => {
      const hard = Object.entries(r.hard);
      const soft = Object.entries(r.soft ?? {});
      const sat = (v) => (x) => Number.isFinite(x) && Math.abs(x - v) <= 0.6;
      if (!hard.every(([d, v]) => sat(v)(query[d]))) return { rule: r, ratio: 0, support: r.support };
      const softSat = soft.filter(([d, s]) => sat(s.v)(query[d])).length;
      const total = hard.length + soft.length;
      return { rule: r, ratio: total === 0 ? 1 : (hard.length + softSat) / total, support: r.support };
    }).filter((x) => x.ratio >= 0.75).sort((a, b) => b.ratio - a.ratio || b.rule.support - a.rule.support);
  }
}

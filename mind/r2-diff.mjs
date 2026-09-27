/** R2A/R2B 差分器：从 R1 情节里提取"一组影响因素 → 一个结果"的抽象规则。
 *
 * R2A（分组）：按 动作 × 结果变化模式 把情节分组——变化结果相似的条件组。
 * R2B（组内差分）：组内恒定维 = 候选影响因素；某维在组内出现新值 → 该维是
 * 背景（从因素集剔除）。规则从严格开始（全维恒定）、随反例泛化（维逐个豁免）——
 * 这是控制变量实验的在线连续版：不需要预先设计实验，共变/不共变本身就是证据。
 *
 * 语义地基（大修后）：情节的条件/结果全部是**概念中心值**（含义），不是索引号——
 * 索引会随概念形成顺序漂移，中心值是物理意义本身（实测根因：同一"掉落物在旁"
 * 拿过 5 号和 9 号，按编号匹配链就断）。分簇/恒定判定用 0.5 网格容差
 * （= 编码分辨率级），不再用严格相等。
 *
 * 输出规则形态：{ action, factors: {dim: 中心值}, outcomes: {dim: 中心值},
 * support, lastTick }。factors 是 R2B 当前相信的相关子集（只会随证据缩小）。
 */

const Q = 0.5; // 中心值量化网格（编码分辨率级）
const qv = (v) => Math.round(v / Q) * Q; // 网格化
const sameVal = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Q;

/** 分组键：动作 + 变化的结果维集合（模式，不含具体值——值在组内分析） */
const groupKey = (ep) => `${ep.act}|${Object.keys(ep.outcomes).sort().join(',')}`;

export class DifferentialExtractor {
  constructor({ quorum = 3 } = {}) {
    this.quorum = quorum;
    /** groupKey → { action, outcomeDims: [], episodes: [] } */
    this.groups = new Map();
    /** 全部规则（按 (动作, 结果签名, 因素签名) 索引） */
    this.rules = new Map();
    this.processed = 0; // 已差分到的情节 tick（增量差分）
  }

  /** 全量重差分前复位（回填路径：R1 裸值经当前概念透镜重新解析后从头 ingest） */
  reset() {
    this.groups.clear();
    this.rules.clear();
    this.processed = 0;
  }

  /** 规则签名：动作+结果维值+因素维值（中心值 0.5 网格化） */
  static ruleSig(rule) {
    const f = Object.keys(rule.factors).sort().map((d) => `${d}=${qv(rule.factors[d])}`).join(',');
    const o = Object.keys(rule.outcomes).sort().map((d) => `${d}=${qv(rule.outcomes[d])}`).join(',');
    return `${rule.action}|${o}|${f}`;
  }

  /** 增量喂入新情节（R1 每次记录后调用） */
  ingest(ep) {
    const key = groupKey(ep);
    const g = this.groups.get(key) ?? { action: ep.act, outcomeDims: Object.keys(ep.outcomes), episodes: [] };
    g.episodes.push(ep);
    this.groups.set(key, g);
    this.processed = Math.max(this.processed, ep.tick);
    this.diffGroup(g);
  }

  /** 批量差分（周期调用；增量已处理过的不会重复） */
  ingestAll(episodes) {
    for (const ep of episodes) if (ep.tick > this.processed) this.ingest(ep);
  }

  /** 组内差分：同结果维值（0.5 网格容差）聚类 → 每簇提取因素集 */
  diffGroup(g) {
    // 先按结果维的具体值再分簇（同动作同变化模式但结果值不同 = 不同规则）
    const clusters = new Map(); // outcomeSig(网格化) → eps
    for (const ep of g.episodes) {
      const osig = g.outcomeDims.map((d) => `${d}=${qv(ep.outcomes[d])}`).join(',');
      const arr = clusters.get(osig) ?? [];
      arr.push(ep);
      clusters.set(osig, arr);
    }
    for (const [osig, eps] of clusters) {
      const outcomes = Object.fromEntries(g.outcomeDims.map((d) => [d, qv(eps[0].outcomes[d])]));
      // 候选因素：簇内恒定维（中心值容差下同值）；随反例自动缩小
      const dims = Object.keys(eps[0].conditions).filter((d) => d !== 'act');
      const factors = {};
      for (const d of dims) {
        const v = eps[0].conditions[d];
        if (eps.every((e) => sameVal(e.conditions[d], v))) factors[d] = qv(v);
      }
      const rule = { action: g.action, factors, outcomes, support: eps.reduce((s, e) => s + (e.weight ?? 1), 0), lastTick: eps.at(-1).tick }; // 支持度 = Σ效价权重（果蝇多巴胺记账：重要事件单次顶多次）
      const sig = DifferentialExtractor.ruleSig(rule);
      // 因素集随反例缩小时签名漂移：同动作同结果、因素集 ⊋ 新规则的陈旧严格版被泛化版取代
      for (const [k, old] of this.rules) {
        if (k === sig || old.action !== rule.action) continue;
        const sameOutcome = JSON.stringify(old.outcomes) === JSON.stringify(rule.outcomes);
        if (!sameOutcome) continue;
        const oldIsSuperset = Object.keys(old.factors).every((d) => rule.factors[d] !== undefined && sameVal(rule.factors[d], old.factors[d]));
        if (oldIsSuperset && Object.keys(old.factors).length > Object.keys(rule.factors).length) this.rules.delete(k);
      }
      this.rules.set(sig, rule);
    }
  }

  /** 当前全部规则（按支持度降序） */
  allRules() {
    return [...this.rules.values()].sort((a, b) => b.support - a.support);
  }

  /** 反查：结果维命中目标维的规则（规划链反查用） */
  rulesFor(goalDims) {
    return this.allRules().filter((r) => goalDims.some((d) => r.outcomes[d] !== undefined));
  }
}

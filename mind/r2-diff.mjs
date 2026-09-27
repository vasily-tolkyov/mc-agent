/** R2A/R2B 差分器 v3：从 R1 情节里提取"一组影响因素 → 一个结果"的抽象规则。
 *
 * v3 重建（高级模型复审 Q8，回到 RESEARCH-R2 P1 原设计的双臂对照版）：
 * - 簇 = (动作, 单个结果维, Δ类)——不再用"完整结果签名"（真实流 69–83% 单例簇、
 *   因素集必然过宽的根因；v2 的教训是簇键里焊死了整帧共变）。
 * - 因素 = 效应臂 vs 对照臂的对比得分：效应臂 = 簇内条件直方图；
 *   对照臂 = 同动作、无此效应的全部情节（v2 丢了对照臂，只有"簇内恒定"单臂判定）。
 * - 因素三态：hard（conf≥0.5）/ soft（conf>0）/ untested（该动作下全历史未变的维）。
 *   conf = Wilson下界(效应臂) − Wilson上界(对照臂)——小样本自动保守。
 * - n（证据数）与 support（效价显著性 Σweight）分离：一次重要事件不等于三次独立观察。
 * - 变化判定概念级：|Δ中心值| 经 Δ类量化后非零才算变化（浮点抖动伪结果根因修复）。
 * - 共变档案 co：同时变化的其他维（freq≥0.5）挂规则上，供规划器前向仿真校验副作用。
 *
 * Δ类语义（结果侧的值）：序数维 = 饱和±3 的有向整数差（"挖原木→logGrip Δ+1"，
 * 与绝对位置无关——规则可迁移的地基）；方位维 = 模 9 环绕 Δ∈[-4,4]；类别维 = 新值。
 *
 * 输出规则：{ action, outcome:{dim:Δ类}, hard, soft, untested, n, support, rho, co,
 *            outcomes/factors（过渡别名，旧消费者兼容——factors=hard∪soft 值视图） }。
 */

const Q = 0.5; // 中心值量化网格（编码分辨率级；概念中心间距≈1.0 已实测，0.5 足够）
const qv = (v) => Math.round(v / Q) * Q;

/** 维度类型：序数（Δ）/ 环绕（模 9 Δ）/ 类别（新值）。感知先验，不是世界知识。 */
export const DIM_KIND = {
  grip: 'ord', logGrip: 'ord', nearDist: 'ord', itemDist: 'ord', goalDist: 'ord', speed: 'ord',
  itemBearing: 'circ', goalBearing: 'circ',
  nearType: 'cat', belowType: 'cat', itemType: 'cat', viewWell: 'cat', onGround: 'cat',
};
export const kindOf = (d) => DIM_KIND[d] ?? 'cat';

/** 环绕差：9 档方位（扇区 -4..4 → 0..8），Δ 收进 [-4,4] */
const wrapCirc = (d) => { let x = Math.round(d) % 9; if (x > 4) x -= 9; if (x < -4) x += 9; return x; };

/** 变化分类：ord→饱和 ±3 整数 Δ；circ→环绕 Δ；cat→新值（四舍五入） */
export function classifyChange(dim, c0, c1) {
  const kind = kindOf(dim);
  if (kind === 'cat') return Math.round(c1);
  if (kind === 'circ') return wrapCirc(c1 - c0);
  const d = Math.round(c1 - c0);
  return Math.sign(d) * Math.min(3, Math.abs(d));
}

/** 概念级变化门：Δ类非零（类别维 = 中心值差超网格） */
export function isChange(dim, c0, c1) {
  if (!Number.isFinite(c0) || !Number.isFinite(c1)) return false;
  if (kindOf(dim) === 'cat') return Math.abs(c1 - c0) > Q;
  return classifyChange(dim, c0, c1) !== 0;
}

/** Wilson 记分区间（z=1.96）：小样本自动宽区间 → 保守 */
const ZW = 1.96;
function wilson(k, n) {
  if (n <= 0) return { lo: 0, hi: 1 };
  const z2 = ZW * ZW;
  const center = (k + z2 / 2) / (n + z2);
  const half = (ZW * Math.sqrt((k * (n - k)) / n + z2 / 4)) / (n + z2);
  return { lo: center - half, hi: center + half };
}

const bump = (map, dim, key) => {
  if (!map.has(dim)) map.set(dim, new Map());
  const m = map.get(dim);
  m.set(key, (m.get(key) ?? 0) + 1);
};

class Cluster {
  constructor(action, dim, delta) {
    this.action = action; this.dim = dim; this.delta = delta;
    this.n = 0; this.salience = 0;
    this.hist = new Map(); // 效应臂：dim → qv(条件值) → 次数
    this.co = new Map();   // 共变档案：其他结果维 → Δ类 → 次数
    this.lastTick = 0;
  }
}

export class DifferentialExtractor {
  constructor({ quorum = 3 } = {}) {
    this.quorum = quorum; // 保留参数外形；v3 的小样本保守由 Wilson 承担
    /** 簇：(动作|结果维|Δ类) → Cluster */
    this.clusters = new Map();
    /** 对照臂总账：action → { n, hist(dim→qv→次数), frames(qv 条件帧，ρ 计算用) } */
    this.actions = new Map();
    this.processed = 0;
  }

  /** 全量重差分前复位（回填路径：R1 裸值经当前概念透镜重新解析后从头 ingest） */
  reset() {
    this.clusters.clear();
    this.actions.clear();
    this.processed = 0;
  }

  /** 规则签名（实验台账兼容接口）：动作+结果维值+hard 因素（中心值 0.5 网格化） */
  static ruleSig(rule) {
    const f = Object.keys(rule.hard ?? rule.factors ?? {}).sort()
      .map((d) => `${d}=${qv((rule.hard ?? rule.factors)[d])}`).join(',');
    const o = Object.keys(rule.outcomes ?? {}).sort().map((d) => `${d}=${qv(rule.outcomes[d])}`).join(',');
    return `${rule.action}|${o}|${f}`;
  }

  /** 增量喂入新情节。ep = { conditions(中心值全维), act, outcomes(变化维→新中心值), tick, weight? } */
  ingest(ep) {
    const w = ep.weight ?? 1;
    const act = ep.act;
    let A = this.actions.get(act);
    if (!A) { A = { n: 0, hist: new Map(), frames: [], outHist: new Map() }; this.actions.set(act, A); }
    A.n++;
    const frame = {};
    for (const [d, v] of Object.entries(ep.conditions)) {
      if (d === 'act' || !Number.isFinite(v)) continue;
      const q = qv(v);
      frame[d] = q;
      bump(A.hist, d, q);
    }
    A.frames.push(frame);
    if (A.frames.length > 1500) A.frames.splice(0, A.frames.length - 1500);

    for (const [g, c1] of Object.entries(ep.outcomes)) {
      const c0 = ep.conditions[g];
      if (!isChange(g, c0, c1)) continue; // 概念级变化门：伪结果在此拦截
      const delta = classifyChange(g, c0, c1);
      bump(A.outHist, g, delta); // 动作级结果基线（co 档案的对照臂）
      const key = `${act}|${g}|${delta}`;
      let c = this.clusters.get(key);
      if (!c) { c = new Cluster(act, g, delta); this.clusters.set(key, c); }
      c.n++;
      c.salience += w;
      for (const [d, v] of Object.entries(frame)) if (d !== g) bump(c.hist, d, v);
      for (const [h, h1] of Object.entries(ep.outcomes)) {
        if (h === g) continue;
        const h0 = ep.conditions[h];
        if (!isChange(h, h0, h1)) continue;
        bump(c.co, h, classifyChange(h, h0, h1));
      }
      c.lastTick = ep.tick;
    }
    this.processed = Math.max(this.processed, ep.tick ?? 0);
  }

  /** 批量差分（周期调用；增量已处理过的不会重复） */
  ingestAll(episodes) {
    for (const ep of episodes) if (ep.tick > this.processed) this.ingest(ep);
  }

  /** 当前全部规则（可靠度×证据排序）。置信度在调用时现算（对照臂持续增长）。 */
  allRules() {
    const rules = [];
    for (const c of this.clusters.values()) {
      const A = this.actions.get(c.action);
      const hard = {}, soft = {}, untested = [], confMap = {};
      for (const [d, vals] of c.hist) {
        const totalVals = A.hist.get(d);
        if (!totalVals || totalVals.size <= 1) { untested.push(d); continue; } // 该动作下全历史未变 → 未经检验
        let bestV = null, bestConf = -Infinity;
        for (const [v, kE] of vals) {
          const kN = (totalVals.get(v) ?? 0) - kE; // 对照臂：同动作、无此效应时该值出现次数
          const conf = wilson(kE, c.n).lo - wilson(kN, A.n - c.n).hi;
          if (conf > bestConf) { bestConf = conf; bestV = v; }
        }
        if (bestConf >= 0.5) { hard[d] = bestV; confMap[d] = +bestConf.toFixed(3); }
        else if (bestConf > 0) { soft[d] = { v: bestV, conf: +bestConf.toFixed(3) }; confMap[d] = +bestConf.toFixed(3); }
      }
      // ρ：hard 因素全满足的同动作情节中，产生本效应比例的 Wilson 下界
      let nCtx = 0;
      const hardEntries = Object.entries(hard);
      for (const f of A.frames) {
        let ok = true;
        for (const [d, v] of hardEntries) if (f[d] !== v) { ok = false; break; }
        if (ok) nCtx++;
      }
      const rho = +wilson(c.n, Math.max(nCtx, c.n)).lo.toFixed(3);
      // untested 带上模态值（轭式探针要拿它当"被扰动的基准值"）
      const untestedMap = {};
      for (const d of untested) {
        const vals = c.hist.get(d);
        if (vals) untestedMap[d] = [...vals.entries()].sort((a, b) => b[1] - a[1])[0][0];
      }
      const co = {};
      for (const [h, m] of c.co) {
        const total = [...m.values()].reduce((a, b) => a + b, 0);
        const [cls, cnt] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
        if (!total) continue;
        // 共变归档的双臂对照（与因素同一逻辑）：簇内共现率的下界要显著高于
        // 该动作下 h 维发生此变化的基线上界——否则是"该动作下的普通共变"，
        // 挂上来会把情境特异效应漏进别的情境（挖石头误报原木的实测 bug）
        const baseCnt = A.outHist.get(h)?.get(cls) ?? 0;
        if (wilson(cnt, c.n).lo > wilson(baseCnt, A.n).hi) co[h] = { delta: cls, freq: +(cnt / total).toFixed(2) };
      }
      rules.push({
        action: c.action, outcome: { [c.dim]: c.delta },
        hard, soft, untested: untestedMap, conf: confMap, n: c.n, support: c.salience, rho, co,
        // 过渡别名（旧消费者兼容期）：outcomes = 单维结果；factors = hard∪soft 合并值视图
        outcomes: { [c.dim]: c.delta },
        factors: { ...hard, ...Object.fromEntries(Object.entries(soft).map(([d, s]) => [d, s.v])) },
        lastTick: c.lastTick,
      });
    }
    return rules.sort((a, b) => (b.rho * Math.log2(2 + b.n)) - (a.rho * Math.log2(2 + a.n)) || b.support - a.support);
  }

  /** 反查：结果维命中目标维的规则（规划链反查用） */
  rulesFor(goalDims) {
    return this.allRules().filter((r) => goalDims.some((d) => r.outcome[d] !== undefined));
  }
}

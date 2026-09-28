/** 反向链接规划器 v3（用户设计原文的直译实现 + 三态因素与 Δ 结果语义适配）：
 * 从阶段性目标反查"哪个规则的结果能满足它"→ 该规则的 hard 因素中当前未满足的部分
 * 成为新的阶段性子目标 → 继续反查，直到因素被当前状态满足为止。
 * soft 因素不满足不阻塞——记为假设列表（assumptions），执行即实验，失败被抓回当反例。
 *
 * v3 语义地基：
 * - 规则结果 = Δ 类（r2-diff v3）：序数/方位维是相对变化，类别维是绝对新值。
 *   Δ 规则天然可重复："logGrip Δ+1" 应用两次 = 0→2（重复应用受深度限，
 *   且每节后检查 hard 因素仍被仿真状态满足——共变副作用可能拆掉前提，如实断链）。
 * - 命中判定 = 朝目标有进展（距目标更近），不必一步到位（重复应用补完剩余距离）。
 * - 前向仿真 applyChain 应用 结果 Δ + 共变档案 co（freq≥0.5 的副作用）——副作用拆台
 *   照样被链尾校验抓住（STRIPS 假设的诚实校验）。
 * - 失败不再是裸 pass/fail：返回 evidence-gap（有规则触及目标但因素/证据不足，
 *   点名缺哪条证据）或 missing-rule（无规则触及目标维——L4 情形，给前沿探索指路）。
 * 环检测路径局部（当前递归栈上判环，回溯即移除——全局 visited 误剪替代路径的教训）。
 */
import { kindOf, applyChange } from './r2-diff.mjs';

const TOL = 0.6; // 中心值容差：编码分辨率级
const sat1 = (frameVal, want) => {
  if (want && typeof want === 'object' && 'min' in want) return frameVal >= want.min - 1e-9 && frameVal <= want.max + 1e-9;
  return Number.isFinite(frameVal) && Number.isFinite(want) && Math.abs(frameVal - want) <= TOL;
};
const satisfied = (frame, dims) => Object.entries(dims).every(([d, v]) => sat1(frame[d], v));
const keyOf = (dims) => Object.keys(dims).sort()
  .map((d) => { const v = dims[d]; return `${d}=${v && typeof v === 'object' ? `${v.min}..${v.max}` : v}`; }).join(',');

/** 距目标的距离（区间取到边界的距离，单值取绝对差） */
const distTo = (x, want) => {
  if (!Number.isFinite(x)) return Infinity;
  if (want && typeof want === 'object' && 'min' in want) return x < want.min ? want.min - x : x > want.max ? x - want.max : 0;
  return Math.abs(x - want);
};

/** 结果命中目标：类别维按绝对值；序数/方位维按"应用 Δ 后距目标更近"（状态相对 + 可重复） */
const outcomeHits = (r, d, frameVal, want) => {
  const out = r.outcomes[d];
  if (out === undefined || !Number.isFinite(frameVal)) return false;
  if (kindOf(d) === 'cat') return sat1(out, want);
  return distTo(frameVal + out, want) < distTo(frameVal, want);
};

/** 应用一条规则：结果 Δ/新值 + 共变档案副作用（Δ 语义只在 r2-diff.applyChange 一处定义）。
 * 退火候选（planCandidates）返回的 outcomes 已并入通过点火门的共变维——这些维不再按 co 重复施加
 * （此前 outcomes 与 co 各施加一次，仿真里 grip 会 +2）。 */
const applyRule = (r, frame) => {
  const s = { ...frame };
  for (const [d, out] of Object.entries(r.outcomes)) s[d] = applyChange(d, s[d], out);
  for (const [h, c] of Object.entries(r.co ?? {})) if (r.outcomes[h] === undefined) s[h] = applyChange(h, s[h], c.delta);
  return s;
};
const applyChain = (chain, frame) => chain.reduce((s, r) => applyRule(r, s), frame);

/** 规则的证据强度（排序用）：ρ × log(2+n) */
const ruleScore = (r) => (r.rho ?? 0.5) * Math.log2(2 + (r.n ?? 1));
const hardOf = (r) => r.hard ?? {};
const softOf = (r) => r.soft ?? {};
const hardSat = (r, frame) => Object.entries(hardOf(r)).every(([d, v]) => sat1(frame[d], v));

export function planBackward({ rules, current, goalDims, maxDepth = 6, exclude = null, candidatesFn = null }) {
  const visited = new Set();
  const excluded = exclude ?? new Set();
  const ruleKey = (r) => `${r.action}|${JSON.stringify(r.outcomes)}`;
  const search = (targets, frame, depth) => {
    if (satisfied(frame, targets)) return { steps: [], assumptions: [] };
    if (depth >= maxDepth) return null;
    const key = keyOf(targets);
    if (visited.has(key)) return null;
    visited.add(key);
    // 反查候选：默认走网络退火读出（candidatesFn——钳置当前状态+目标结果场，浮上来的核才是候选；
    // 浅井侥幸规则物理上浮不上来）；无网络时退回符号过滤（离线测试兜底）。
    // 执行禁忌表：本次尝试里刚物理失败的规则不再重复选（反例的长期命运由 R2 统计决定）
    const cands = (candidatesFn ? candidatesFn(targets, frame) : rules
      .filter((r) => Object.entries(targets).some(([d, v]) => outcomeHits(r, d, frame[d], v))))
      .filter((r) => !excluded.has(ruleKey(r)))
      .sort((a, b) => ruleScore(b) - ruleScore(a));
    for (const rule of cands) {
      const assumptions = [];
      const sub = {};
      for (const [d, v] of Object.entries(hardOf(rule))) if (!sat1(frame[d], v)) sub[d] = v; // hard 不满足 → 真子目标
      for (const [d, s] of Object.entries(softOf(rule))) { // soft 分层：中置信(≥0.2)→子目标（疑似因果，先建立它——L3 实测 dig 缺 nearType=4 的教训）；低置信→假设
        if (sat1(frame[d], s.v)) continue;
        if (s.conf >= 0.2) sub[d] = s.v;
        else assumptions.push({ dim: d, cur: frame[d] ?? null, want: s.v, conf: s.conf, action: rule.action, outcomes: rule.outcomes });
      }
      let chain = [];
      if (Object.keys(sub).length) {
        const r = search(sub, frame, depth + 1);
        if (!r) continue;
        chain = r.steps;
        assumptions.push(...r.assumptions);
      }
      // Δ 规则可重复：应用到目标达成 / 不再进展 / hard 前提被共变副作用拆掉 / 深度耗尽
      const full = [...chain];
      let sim = applyChain(chain, frame);
      const budget = maxDepth - depth - chain.length;
      for (let k = 0; k < Math.max(1, budget); k++) {
        if (k > 0 && !hardSat(rule, sim)) break; // 前提被拆（如挖掉原木后 nearType 变空气）——如实停
        const before = sim;
        sim = applyRule(rule, sim);
        full.push(rule);
        if (satisfied(sim, targets)) { visited.delete(key); return { steps: full, assumptions }; } // 前向仿真校验
        if (Object.keys(targets).every((d) => sim[d] === before[d])) break; // 不再进展
      }
    }
    visited.delete(key);
    return null;
  };
  const res = search(goalDims, current, 0);
  if (res) return { status: 'found', steps: res.steps, depth: res.steps.length, assumptions: res.assumptions };
  // 失败：区分"无规则触及目标维"（missing-rule，L4 探索指路）与"有规则但因素/证据不足"（evidence-gap）
  const touching = rules.filter((r) => Object.keys(goalDims).some((d) => r.outcomes[d] !== undefined));
  if (!touching.length) return { status: 'missing-rule', steps: [], need: Object.keys(goalDims), gaps: [] };
  // 缺口清单：每条触及目标维的规则缺哪些 hard 因素（按缺口数升序、证据强度降序）
  const gaps = touching.map((r) => {
    const missing = Object.entries(hardOf(r))
      .filter(([d, v]) => !sat1(current[d], v))
      .map(([d, v]) => ({ dim: d, want: v, cur: current[d] ?? null }));
    const assumptions = Object.entries(softOf(r))
      .filter(([d, s]) => !sat1(current[d], s.v))
      .map(([d, s]) => ({ dim: d, want: s.v, cur: current[d] ?? null, conf: s.conf }));
    return { action: r.action, outcomes: r.outcomes, rho: r.rho ?? null, n: r.n ?? null, missing, assumptions };
  }).sort((a, b) => a.missing.length - b.missing.length || ruleScore(b) - ruleScore(a)).slice(0, 5);
  return { status: 'evidence-gap', steps: [], gaps, rules: touching.length };
}

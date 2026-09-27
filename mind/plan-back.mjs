/** 反向链接规划器（用户设计原文的直译实现）：
 * 从阶段性目标反查"哪个规则的结果能满足它"→ 该规则的因素条件中当前未满足的部分
 * 成为新的阶段性子目标 → 继续反查，直到因素被当前状态满足为止。
 * 输出 = 正向执行的规则链（每条 = 一个动作 + 预期变化），执行时逐条核对（捕获）。
 * 环检测（目标签名 visited）+ 深度限 + 候选按支持度降序 + 链尾前向仿真校验
 * （后规则的副作用不得破坏先满足的因素——STRIPS 假设的诚实校验）。
 *
 * 语义地基（大修后）：所有值是**概念中心值**（含义），不是索引号——
 * 同一物理意义的概念索引会随时间漂移，按编号匹配会把规划图碎片化（实测根因）。
 * 目标维三种形态：{min,max} 区间（gte/lte/eq 语义的原生形态）或单值（精确含义）。
 * 单值与因素匹配均按中心值容差（|a−b| ≤ TOL）。
 */

const TOL = 0.6; // 中心值容差：编码分辨率级
const sat1 = (frameVal, want) => {
  if (want && typeof want === 'object' && 'min' in want) return frameVal >= want.min - 1e-9 && frameVal <= want.max + 1e-9;
  return Number.isFinite(frameVal) && Number.isFinite(want) && Math.abs(frameVal - want) <= TOL;
};
const satisfied = (frame, dims) => Object.entries(dims).every(([d, v]) => sat1(frame[d], v));
const keyOf = (dims) => Object.keys(dims).sort()
  .map((d) => { const v = dims[d]; return `${d}=${v && typeof v === 'object' ? `${v.min}..${v.max}` : v}`; }).join(',');
const applyChain = (chain, frame) => {
  const s = { ...frame };
  for (const rule of chain) Object.assign(s, rule.outcomes);
  return s;
};

export function planBackward({ rules, current, goalDims, maxDepth = 6 }) {
  const visited = new Set();
  const search = (targets, frame, depth) => {
    if (satisfied(frame, targets)) return [];
    if (depth >= maxDepth) return null;
    const key = keyOf(targets);
    if (visited.has(key)) return null;
    visited.add(key);
    // 反查：结果命中任一目标维（区间或容差）的规则（支持度降序）
    const cands = rules
      .filter((r) => Object.entries(targets).some(([d, v]) => sat1(r.outcomes[d], v)))
      .sort((a, b) => b.support - a.support);
    for (const rule of cands) {
      const sub = {};
      for (const [d, v] of Object.entries(rule.factors)) if (!sat1(frame[d], v)) sub[d] = v;
      if (Object.keys(sub).length === 0) {
        if (satisfied(applyChain([rule], frame), targets)) return [rule];
        continue;
      }
      const chain = search(sub, frame, depth + 1);
      if (chain) {
        const full = [...chain, rule];
        if (satisfied(applyChain(full, frame), targets)) return full; // 前向仿真校验（防副作用拆台）
      }
    }
    return null;
  };
  const chain = search(goalDims, current, 0);
  return chain
    ? { status: 'found', steps: chain, depth: chain.length }
    : { status: 'no-known-route', steps: [] };
}

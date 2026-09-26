/** 反向链接规划器（用户设计原文的直译实现）：
 * 从阶段性目标反查"哪个规则的结果能满足它"→ 该规则的因素条件中当前未满足的部分
 * 成为新的阶段性子目标 → 继续反查，直到因素被当前状态满足为止。
 * 输出 = 正向执行的规则链（每条 = 一个动作 + 预期变化），执行时逐条核对（捕获）。
 * 环检测（目标签名 visited）+ 深度限 + 候选按支持度降序 + 链尾前向仿真校验
 * （后规则的副作用不得破坏先满足的因素——STRIPS 假设的诚实校验）。 */

const satisfied = (frame, dims) => Object.entries(dims).every(([d, v]) => frame[d] === v);
const keyOf = (dims) => Object.keys(dims).sort().map((d) => `${d}=${dims[d]}`).join(',');
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
    // 反查：结果命中任一目标维的规则（支持度降序）
    const cands = rules
      .filter((r) => Object.entries(targets).some(([d, v]) => r.outcomes[d] === v))
      .sort((a, b) => b.support - a.support);
    for (const rule of cands) {
      const sub = {};
      for (const [d, v] of Object.entries(rule.factors)) if (frame[d] !== v) sub[d] = v;
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

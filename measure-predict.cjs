/** 判别实验：同规模 mock 模型上跑 planGoal，包装 predict 计数。
 * 若 predict 数停在 480 以内而时间暴涨 → DFS 路径枚举卡死（结构性 bug）；
 * 若 predict 打满 480 且时间 ≈ 数量×单价 → 只是预测慢。 */
const path = require("path");
const REPO = path.resolve(__dirname, "..", "energy-network-sim");
const url = (p) => "file:///" + p.replace(/\\/g, "/");

const MC_BOX_SPACE = {
  states: [
    { name: "zone", outcome: "nextZone", bins: 7 },
    { name: "lane", outcome: "nextLane", bins: 2 },
    { name: "carry", outcome: "nextCarry", bins: 2 },
    { name: "stack", outcome: "nextStack", bins: 3 },
  ],
  actions: [{ name: "move", bins: 5 }, { name: "handle", bins: 3 }],
  diameter: 16,
};

async function main() {
  const { TransitionMemory } = await import(url(path.join(REPO, "dist/src/planning/transition-memory.js")));
  const { collectTransitions } = await import(url(path.join(REPO, "dist/src/planning/collect.js")));
  const { planGoal } = await import(url(path.join(REPO, "dist/src/planning/planner.js")));

  const bench = {
    async conduct(state, action) {
      let { zone, lane, carry, stack } = state;
      if (action.move === 0) zone = Math.max(0, zone - 1);
      if (action.move === 1) zone = Math.min(6, zone + 1);
      if (action.move === 2) lane = 0;
      if (action.move === 3) lane = 1;
      if (action.handle === 1 && zone === 0 && carry === 0) carry = 1;
      if (action.handle === 2 && zone === 6 && carry === 1 && stack < 2) { stack += 1; carry = 0; }
      return { nextZone: zone, nextLane: lane, nextCarry: carry, nextStack: stack };
    },
  };

  const model = new TransitionMemory(MC_BOX_SPACE);
  await collectTransitions(model, bench, 7 * 2 * 2 * 3 * 15, 1);
  console.log(`规则 ${model.mem.ruleCount}，模型就绪`);

  let predictCount = 0;
  const orig = model.predict.bind(model);
  model.predict = (s, a, seed) => { predictCount++; return orig(s, a, seed); };

  const t0 = performance.now();
  const heartbeat = setInterval(() => {
    console.log(`[心跳] ${((performance.now() - t0) / 1000).toFixed(0)}s，predict 调用 ${predictCount} 次`);
  }, 30000);

  // 先量单条 predict 单价（前 3 条）
  const probeAction = model.actions.find((a) => a.values.move === 1 && a.values.handle === 0);
  const tp = performance.now();
  model.predict({ zone: 0, lane: 1, carry: 0, stack: 0 }, probeAction, 1);
  model.predict({ zone: 2, lane: 1, carry: 1, stack: 0 }, probeAction, 2);
  model.predict({ zone: 5, lane: 1, carry: 1, stack: 1 }, probeAction, 3);
  console.log(`单条 predict 均价 ${((performance.now() - tp) / 3000).toFixed(2)}s`);

  const plan = planGoal(model, { zone: 0, lane: 1, carry: 0, stack: 0 }, { zone: 6, lane: 0, carry: 0, stack: 2 }, 1);
  clearInterval(heartbeat);
  console.log(`规划完成：status=${plan.status}，步数=${plan.steps.length}，predict 调用=${predictCount}，总耗时 ${((performance.now() - t0) / 1000).toFixed(0)}s`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

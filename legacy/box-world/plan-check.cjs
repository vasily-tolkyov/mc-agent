/** 离线验证（不修世界、不进 MC）：
 * 检查1：干净 mock（含墙/够不着/柱顶不可走进等物理限制，diameter 22）→ planGoal 必须找到路。
 * 检查2：place 坏的 mock（stack 永远 0，可达图 < 预算）→ 旧代码枚举洞永不完结；
 *         换位表修复后必须有界终止（no-known-route）。 */
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
  diameter: 22,
};

const makeBench = (placeBroken) => ({
  async conduct(state, action) {
    let { zone, lane, carry, stack } = state;
    const t = { zone, lane };
    if (action.move === 0) t.zone = Math.max(0, t.zone - 1);
    if (action.move === 1) t.zone = Math.min(6, t.zone + 1);
    if (action.move === 2) t.lane = 0;
    if (action.move === 3) t.lane = 1;
    // 墙：地板层 lane0 在 x=3 处挡住（2→3 与 4→3）；墙顶(3,0)可以走下
    if (lane === 0 && state.zone === 2 && action.move === 1) t.zone = 2;
    if (lane === 0 && state.zone === 4 && action.move === 0) t.zone = 4;
    // 柱顶走不进：箱源(0,0)永远挡住；堆垛(6,0)仅在 stack=0（跳上金垫一格）时可入
    if (t.zone === 0 && t.lane === 0 && !(state.zone === 0 && state.lane === 0)) { t.zone = state.zone; t.lane = state.lane; }
    if (t.zone === 6 && t.lane === 0 && stack >= 1 && !(state.zone === 6 && state.lane === 0)) { t.zone = state.zone; t.lane = state.lane; }
    if (t.zone === 3 && t.lane === 0 && !(state.zone === 3 && state.lane === 0)) { t.zone = state.zone; t.lane = state.lane; }
    zone = t.zone; lane = t.lane;
    if (action.handle === 1 && zone <= 4) carry = 1; // 挖掘：够得着箱源就成
    if (action.handle === 2 && !placeBroken && zone >= 5 && carry === 1 && stack < 2) { stack += 1; carry = 0; }
    return { nextZone: zone, nextLane: lane, nextCarry: carry, nextStack: stack };
  },
});

async function run(placeBroken, label) {
  const { TransitionMemory } = await import(url(path.join(REPO, "dist/src/planning/transition-memory.js")));
  const { collectTransitions } = await import(url(path.join(REPO, "dist/src/planning/collect.js")));
  const { planGoal } = await import(url(path.join(REPO, "dist/src/planning/planner.js")));
  const model = new TransitionMemory(MC_BOX_SPACE);
  await collectTransitions(model, makeBench(placeBroken), 7 * 2 * 2 * 3 * 15, 1);
  let predicts = 0;
  const orig = model.predict.bind(model);
  model.predict = (s, a, seed) => { predicts++; return orig(s, a, seed); };
  const t = performance.now();
  const plan = planGoal(model, { zone: 0, lane: 1, carry: 0, stack: 0 }, { zone: 6, lane: 1, carry: 0, stack: 2 }, 1);
  const secs = ((performance.now() - t) / 1000).toFixed(0);
  console.log(`[${label}] status=${plan.status} 步数=${plan.steps.length} predict=${predicts} 耗时=${secs}s`);
  if (plan.steps.length) console.log(`  路线: ${plan.steps.map((p) => JSON.stringify(p.action.values)).join(" → ")}`);
  return { status: plan.status, steps: plan.steps.length, predicts, secs: +secs };
}

async function main() {
  const bad = await run(true, "检查2: place 坏（枚举洞场景，必须有界终止）");
  const good = await run(false, "检查1: place 正常（必须找到路）");
  const ok = bad.steps === 0 && good.status === "found" && good.steps > 0 && good.steps <= 44;
  console.log(ok ? "✔ 离线验证通过" : "✘ 离线验证失败");
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });

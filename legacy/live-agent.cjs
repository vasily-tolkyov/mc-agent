/**
 * Minecraft 现场演示（第一人称直播）。
 * 协议：箱子世界同构状态空间；实验台 = 真实 Minecraft（传送设状态、生存物理执行、
 * 读出真实结果）。阶段：自由探索学习 → Jev 解析中文指令 → 规划 → 物理执行。
 * 启动：服务器先跑（server/），然后 node live-agent.cjs；
 * 浏览器打开 http://localhost:3007 即 ProtoAgent 的第一人称视角。
 *
 * 世界几何（冒烟测试标定）：
 *   地板行走面 y=-60；金块垫在 (6,-60,0)（永久，不得 fill 破坏）；
 *   木板堆垛在 y=-59（第一层）/y=-58（第二层）；箱源柱 (0,-60..-59,0)；墙柱 (3,-60..-59,0)。
 *   站在柱顶/墙顶/堆垛顶的传送高度相应抬升；走到这些格子在物理上不可达（爬不上两格），
 *   模型会如实学到"走不进"，目标因此定义为 lane=1（站在堆垛旁）。
 */
const mineflayer = require("mineflayer");
const { pathfinder, goals } = require("mineflayer-pathfinder");
const viewer = require("prismarine-viewer").mineflayer;
const Vec3 = require("vec3");
const path = require("path");
const fs = require("fs");

const REPO = path.resolve(__dirname, "..", "energy-network-sim");
const url = (p) => "file:///" + p.replace(/\\/g, "/");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const Y = -60;
const Z0 = 0, Z1 = 2;
const ZONE_MAX = 6;
const SRC_X = 0, TGT_X = 6;

const MC_BOX_SPACE = {
  states: [
    { name: "zone", outcome: "nextZone", bins: 7 },
    { name: "lane", outcome: "nextLane", bins: 2 },
    { name: "carry", outcome: "nextCarry", bins: 2 },
    { name: "stack", outcome: "nextStack", bins: 3 },
  ],
  actions: [{ name: "move", bins: 5 }, { name: "handle", bins: 3 }],
  diameter: 22, // 与箱子世界一致：双程往返 ~22 步；maxDepth=2×diameter，预算=maxDepth×15（实测 16 不够）
};

// 站立高度：箱源柱顶 / 墙顶 / 垫+堆垛顶，其余为地板
const feetY = (zone, lane, stack) => {
  if (lane === 0) {
    if (zone === 0) return Y + 2;
    if (zone === 3) return Y + 2;
    if (zone === ZONE_MAX) return Y + 1 + stack;
  }
  return Y;
};

async function main() {
  const { TransitionMemory } = await import(url(path.join(REPO, "dist/src/planning/transition-memory.js")));
  const { collectTransitions } = await import(url(path.join(REPO, "dist/src/planning/collect.js")));
  const { executeGoal } = await import(url(path.join(REPO, "dist/src/planning/execute.js")));
  const { JevApiBackend } = await import(url(path.join(REPO, "dist/src/perception/decision-backend.js")));
  const { SceneParser } = await import(url(path.join(REPO, "dist/src/perception/scene-parser.js")));
  const { BOX_GOAL_PERCEPTION } = await import(url(path.join(REPO, "dist/src/topics/box-world.js")));

  const bot = mineflayer.createBot({ host: "localhost", port: 25565, username: "ProtoAgent", version: "1.20.4" });
  bot.loadPlugin(pathfinder);
  const LOG = path.join(__dirname, "live-demo.log");
  fs.writeFileSync(LOG, "");
  const out = (s) => { console.log(s); fs.appendFileSync(LOG, s + "\n"); };

  bot.once("spawn", async () => {
    bot.chat("/gamemode survival @s");
    // 世界修复（幂等）：金垫、墙、箱源恢复原位
    bot.chat(`/setblock ${TGT_X} ${Y} ${Z0} minecraft:gold_block`);
    bot.chat(`/fill ${TGT_X} ${Y + 1} ${Z0} ${TGT_X} ${Y + 3} ${Z0} minecraft:air`);
    bot.chat("/fill 3 -60 0 3 -59 0 minecraft:stone");
    bot.chat(`/fill ${SRC_X} ${Y} ${Z0} ${SRC_X} ${Y + 1} ${Z0} minecraft:oak_planks`);
    viewer(bot, { port: 3007, firstPerson: true, viewDistance: 4 });
    out("[系统] 第一人称直播就绪：http://localhost:3007");
    await sleep(2000);

    const readState = () => {
      const p = bot.entity.position;
      const zone = Math.max(0, Math.min(ZONE_MAX, Math.round(p.x)));
      const lane = p.z >= Z1 - 1 ? 1 : 0;
      const carry = bot.inventory.items().some((i) => i.name === "oak_planks") ? 1 : 0;
      let stack = 0;
      for (let dy = 1; dy <= 2; dy++) { // 堆垛在金垫上方：y=-59 / y=-58
        const b = bot.blockAt(new Vec3(TGT_X, Y + dy, Z0));
        if (b && b.name === "oak_planks") stack = dy; else break;
      }
      return { zone, lane, carry, stack };
    };

    const bench = {
      async conduct(state, action) {
        // 状态设置（传送是实验台仪表，不是世界规律）
        bot.chat(`/tp @s ${state.zone + 0.5} ${feetY(state.zone, state.lane, state.stack)} ${state.lane === 1 ? Z1 + 0.5 : Z0 + 0.5}`);
        bot.chat(state.carry ? "/give @s minecraft:oak_planks 8" : "/clear @s minecraft:oak_planks");
        bot.chat(`/fill ${TGT_X} ${Y + 1} ${Z0} ${TGT_X} ${Y + 3} ${Z0} minecraft:air`); // 清堆垛区，保住金垫
        if (state.stack > 0) bot.chat(`/fill ${TGT_X} ${Y + 1} ${Z0} ${TGT_X} ${Y + state.stack} ${Z0} minecraft:oak_planks`);
        bot.chat(`/fill ${SRC_X} ${Y} ${Z0} ${SRC_X} ${Y + 1} ${Z0} minecraft:oak_planks`); // 箱源复原
        await sleep(500);
        // 移动（真实寻路；撞墙/爬不上就如实失败停在原地）
        if (action.move !== 4) {
          const t = { zone: state.zone, lane: state.lane };
          if (action.move === 0) t.zone = Math.max(0, t.zone - 1);
          if (action.move === 1) t.zone = Math.min(ZONE_MAX, t.zone + 1);
          if (action.move === 2) t.lane = 0;
          if (action.move === 3) t.lane = 1;
          const g = new goals.GoalNear(t.zone + 0.5, feetY(t.zone, t.lane, state.stack), t.lane === 1 ? Z1 + 0.5 : Z0 + 0.5, 0.25);
          try { await bot.pathfinder.goto(g); } catch { /* 失败如实 */ }
          const at = () => { const p = bot.entity.position; return Math.round(p.x) === t.zone && (p.z >= Z1 - 1 ? 1 : 0) === t.lane; };
          if (!at()) { try { await bot.pathfinder.goto(g); } catch { /* 仍失败如实 */ } }
        }
        // 挖掘箱源（够不着就如实失败；拾取后回到原位——拾取走位是执行噪声不是规律）
        if (action.handle === 1) {
          let src = bot.blockAt(new Vec3(SRC_X, Y, Z0));
          if (!src || src.name !== "oak_planks") src = bot.blockAt(new Vec3(SRC_X, Y + 1, Z0));
          if (src && src.name === "oak_planks") {
            const before = bot.entity.position.clone();
            let broke = false;
            try { await bot.dig(src); broke = bot.blockAt(src.position).name === "air"; } catch { /* 够不着如实 */ }
            if (broke) {
              await sleep(300);
              try { await bot.pathfinder.goto(new goals.GoalNear(SRC_X + 0.5, Y, Z0 + 0.5, 0.6)); } catch { /* */ }
              await sleep(800);
              if (!bot.inventory.items().some((i) => i.name === "oak_planks")) await sleep(800);
              bot.chat(`/tp @s ${before.x.toFixed(2)} ${before.y.toFixed(2)} ${before.z.toFixed(2)}`);
              await sleep(200);
            }
          }
        }
        // 放置到堆垛顶（box-world 语义：stack 封顶 2，超出不再放）
        if (action.handle === 2 && state.stack < 2) {
          const top = bot.blockAt(new Vec3(TGT_X, Y + state.stack, Z0)); // stack=0 → 金垫
          const inv = bot.inventory.items().find((i) => i.name === "oak_planks");
          if (top && top.name !== "air" && inv) {
            try { await bot.equip(inv, "hand"); await bot.placeBlock(top, new Vec3(0, 1, 0)); } catch { /* 放不上如实 */ }
          }
        }
        await sleep(300);
        const next = readState();
        return Object.fromEntries(MC_BOX_SPACE.states.map((d) => [d.outcome, next[d.name]]));
      },
    };

    out("══ 阶段 1：自由探索（覆盖学习，传送探针 + 生存物理）");
    bot.chat("[ProtoAgent] 开始自由探索（约 40 分钟）");
    const model = new TransitionMemory(MC_BOX_SPACE);
    let predictCount = 0;
    const origPredict = model.predict.bind(model);
    model.predict = (s, a, seed) => {
      predictCount++;
      if (predictCount % 20 === 0) fs.writeSync(1, `  [predict] ${predictCount} 次\n`); // 同步写：规划阻塞事件循环时仍可见
      return origPredict(s, a, seed);
    };
    const t0 = performance.now();
    await collectTransitions(model, bench, 7 * 2 * 2 * 3 * 15, 1);
    out(`探索完成：${model.mem.ruleCount} 条规则，耗时 ${((performance.now() - t0) / 1000).toFixed(0)}s`);

    out("══ 阶段 2：中文指令 → Jev 解析 → 规划 → 物理执行");
    const key = process.env.TYPESAFE_API_KEY;
    const backend = key ? new JevApiBackend("https://api.typesafe.ai/v1/systemone", key) : null;
    let goal = { zone: 6, lane: 1, carry: 0, stack: 2 };
    if (backend) {
      const parser = new SceneParser(backend);
      const got = await parser.parse("把箱子摞起来，摞两层", BOX_GOAL_PERCEPTION);
      out(`Jev 指令解析：${JSON.stringify(got.details)}，unknown=${JSON.stringify(got.unknownDims)}`);
      if (!got.unknownDims.length && (got.frame.stack ?? 0) > 0) goal = { ...goal, stack: got.frame.stack };
    } else {
      out("（无 TYPESAFE_API_KEY，用默认目标 stack=2——Jev 解析环节跳过）");
    }
    out(`目标：${JSON.stringify(goal)}（lane=1：stack=2 时 lane 0 是三层柱顶、物理上走不进，目标定为站在堆垛旁）`);
    bot.chat("[ProtoAgent] 开始规划（神经退火约 10-20 分钟，画面冻结，完成后恢复执行）");
    const t1 = performance.now();
    const exec = await executeGoal(model, bench, { zone: 0, lane: 1, carry: 0, stack: 0 }, goal, 1);
    const plan0 = exec.plans[0];
    out(`初始规划：${plan0.status}，${plan0.steps.length} 步，predict ${plan0.predictions.length} 次`);
    out(`执行：到达=${exec.reached}，终止=${exec.terminationReason}，步数=${exec.steps.length}，重规划=${exec.replans.length}，耗时 ${((performance.now() - t1) / 1000).toFixed(0)}s`);
    out(`最终状态：${JSON.stringify(exec.finalState)}，predict 总计=${predictCount}`);
    out("[系统] 演示结束（证据写入 live-demo.log）。视角服务器继续在线。");
  });

  bot.once("error", (e) => { console.error("bot error:", e.message); process.exit(1); });
}

main().catch((e) => { console.error(e); process.exit(1); });

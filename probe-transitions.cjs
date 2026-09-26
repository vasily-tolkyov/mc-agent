/** 路线关键转移的可靠性探针：复用 mc-bench 的 conduct，在真实物理里重复测量。
 * 与运行中的 agent 共享世界（偶发干扰会计入噪声，这正是要测的东西）。 */
const mineflayer = require("mineflayer");
const { pathfinder } = require("mineflayer-pathfinder");
const { makeBench, repairWorld, sleep } = require("./mc-bench.cjs");

const bot = mineflayer.createBot({ host: "localhost", port: 25565, username: "SmokeBot", version: "1.20.1" });
bot.loadPlugin(pathfinder);

async function probe(bench, label, state, action, expect, reps = 8) {
  let ok = 0;
  const outcomes = [];
  for (let i = 0; i < reps; i++) {
    try {
      const r = await bench.conduct(state, action);
      const hit = Object.entries(expect).every(([k, v]) => r[k] === v);
      if (hit) ok++;
      outcomes.push(JSON.stringify(r));
    } catch (e) {
      outcomes.push("ERR:" + e.message);
    }
    await sleep(300);
  }
  console.log(`[${label}] 成功 ${ok}/${reps}`);
  const freq = {};
  for (const o of outcomes) freq[o] = (freq[o] ?? 0) + 1;
  for (const [o, n] of Object.entries(freq)) console.log(`    ${n}× ${o}`);
}

bot.once("spawn", async () => {
  try {
    bot.chat("/gamemode survival @s");
    await sleep(1200);
    repairWorld(bot);
    await sleep(600);
    const bench = makeBench(bot);
    await probe(bench, "挖箱@(0,1)", { zone: 0, lane: 1, carry: 0, stack: 0 }, { move: 4, handle: 1 }, { nextCarry: 1 });
    await probe(bench, "放置@(6,1)stack0→1", { zone: 6, lane: 1, carry: 1, stack: 0 }, { move: 4, handle: 2 }, { nextStack: 1, nextCarry: 0 });
    await probe(bench, "放置@(6,1)stack1→2", { zone: 6, lane: 1, carry: 1, stack: 1 }, { move: 4, handle: 2 }, { nextStack: 2, nextCarry: 0 });
    await probe(bench, "移动@(2,1)→3", { zone: 2, lane: 1, carry: 0, stack: 0 }, { move: 1, handle: 0 }, { nextZone: 3 });
    await probe(bench, "移动穿墙@(2,0)→3（应被挡）", { zone: 2, lane: 0, carry: 0, stack: 0 }, { move: 1, handle: 0 }, { nextZone: 2 });
    console.log("探针完成");
    bot.quit();
    process.exit(0);
  } catch (e) { console.error("探针失败:", e); process.exit(1); }
});
bot.once("error", (e) => { console.error(e.message); process.exit(1); });

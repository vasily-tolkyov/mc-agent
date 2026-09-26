/** handle=3 拆除堆垛探针：stack1→0（应捡到，carry→1）与 stack2→1（物品留在顶上，carry 不变）。 */
const mineflayer = require("mineflayer");
const { pathfinder } = require("mineflayer-pathfinder");
const { makeBench, repairWorld, sleep } = require("./mc-bench.cjs");

const bot = mineflayer.createBot({ host: "localhost", port: 25565, username: "SmokeBot", version: "1.20.1" });
bot.loadPlugin(pathfinder);

async function probe(bench, label, state, action, expect, reps = 6) {
  let ok = 0;
  const freq = {};
  for (let i = 0; i < reps; i++) {
    try {
      const r = await bench.conduct(state, action);
      const hit = Object.entries(expect).every(([k, v]) => r[k] === v);
      if (hit) ok++;
      const k = JSON.stringify(r);
      freq[k] = (freq[k] ?? 0) + 1;
    } catch (e) {
      const k = "ERR:" + e.message;
      freq[k] = (freq[k] ?? 0) + 1;
    }
    await sleep(300);
  }
  console.log(`[${label}] 期望命中 ${ok}/${reps}`);
  for (const [o, n] of Object.entries(freq)) console.log(`    ${n}× ${o}`);
}

bot.once("spawn", async () => {
  try {
    bot.chat("/gamemode survival @s");
    await sleep(1200);
    repairWorld(bot);
    await sleep(600);
    const bench = makeBench(bot);
    await probe(bench, "拆除@stack1→0（应捡到）", { zone: 6, lane: 1, carry: 0, stack: 1 }, { move: 4, handle: 3 }, { nextStack: 0, nextCarry: 1 });
    await probe(bench, "拆除@stack2→1（物品留顶上）", { zone: 6, lane: 1, carry: 0, stack: 2 }, { move: 4, handle: 3 }, { nextStack: 1 });
    console.log("探针完成");
    bot.quit();
    process.exit(0);
  } catch (e) { console.error("探针失败:", e); process.exit(1); }
});
bot.once("error", (e) => { console.error(e.message); process.exit(1); });

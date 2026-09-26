/** MC 实验台冒烟：传送 → 挖箱源 → 走到目标点 → 放置，逐步验证物理链路。 */
const mineflayer = require("mineflayer");
const { pathfinder, goals } = require("mineflayer-pathfinder");
const Vec3 = require("vec3");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const Y = -60;

const bot = mineflayer.createBot({ host: "localhost", port: 25565, username: "SmokeBot", version: "1.20.4" });
bot.loadPlugin(pathfinder);
bot.once("spawn", async () => {
  try {
    bot.chat("/gamemode survival @s");
    await sleep(1200);
    // 修复箱源（世界是有状态的，挖过就要补）+ 传送到箱源旁
    bot.chat("/fill 0 -60 0 0 -59 0 minecraft:oak_planks");
    bot.chat("/tp @s 1.5 -60 0");
    await sleep(600);
    console.log("位置:", bot.entity.position.toString());
    // 挖箱源（y=-60 的木板）
    const src = bot.blockAt(new Vec3(0, Y, 0));
    console.log("源方块:", src?.name);
    if (src?.name === "oak_planks") {
      await bot.dig(src);
      await sleep(400);
      // 走过去把掉落物吸进背包
      try { await bot.pathfinder.goto(new goals.GoalNear(0, Y, 0, 0.4)); } catch {}
      await sleep(700);
      console.log("挖掘后背包:", JSON.stringify(bot.inventory.items().map(i => i.name)));
    }
    // 走到目标点（会被墙挡，绕行 z=2）
    const goal = new goals.GoalNear(6.5, Y, 2, 0.3);
    await bot.pathfinder.goto(goal);
    console.log("走到:", bot.entity.position.toString());
    // 放置
    const inv = bot.inventory.items().find(i => i.name === "oak_planks");
    console.log("背包有木板:", !!inv);
    if (inv) {
      await bot.equip(inv, "hand");
      const pad = bot.blockAt(new Vec3(6, Y - 1, 0)); // 金块垫顶面是 y=-60？金块在 y=-60，放到它上面
      const gold = bot.blockAt(new Vec3(6, Y, 0));
      console.log("目标垫方块:", gold?.name);
      await bot.placeBlock(gold, new Vec3(0, 1, 0));
      await sleep(400);
      const placed = bot.blockAt(new Vec3(6, Y + 1, 0));
      console.log("放置结果:", placed?.name);
    }
    bot.quit();
    process.exit(0);
  } catch (e) {
    console.error("冒烟失败:", e.message);
    bot.quit();
    process.exit(1);
  }
});
bot.once("error", (e) => { console.error(e.message); process.exit(1); });
setTimeout(() => { console.error("超时"); process.exit(1); }, 60000);

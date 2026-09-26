/** 搭建演示地图（y=5 高台版——prismarine-viewer 不渲染 y<0 区块，issue #250）：
 * 草地平台（x -8..14，z -6..8，顶面 y=4）+ 墙（x=3,z=0 两格高）+ 箱源柱（x=0,z=0）+ 目标垫（x=6,z=0 金块）。
 * 通道 z=2 保持无障碍（勿放装饰地标——会挡 lane 1 走位目标点）。创造模式 + 作弊开启。 */
const mineflayer = require("mineflayer");

const bot = mineflayer.createBot({ host: "localhost", port: 25565, username: "MapBuilder", version: "1.20.1" });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
bot.once("spawn", async () => {
  await sleep(1500);
  const Y = 5; // 行走面（脚底）；平台方块在 y=4
  bot.chat(`/fill -8 ${Y - 1} -6 14 ${Y - 1} 8 minecraft:grass_block`);
  await sleep(800);
  bot.chat(`/fill 3 ${Y} 0 3 ${Y + 1} 0 minecraft:stone`);       // 墙
  await sleep(400);
  bot.chat(`/fill 0 ${Y} 0 0 ${Y + 1} 0 minecraft:oak_planks`);   // 箱源柱（两层，可挖）
  await sleep(400);
  bot.chat(`/setblock 6 ${Y} 0 minecraft:gold_block`);            // 目标垫
  await sleep(400);
  console.log("地图建好：平台 y=4 顶面；墙 x=3/z=0（2 高），箱源 x=0/z=0，目标 x=6/z=0（金块垫）");
  bot.quit();
  process.exit(0);
});
bot.once("error", (e) => { console.error(e.message); process.exit(1); });

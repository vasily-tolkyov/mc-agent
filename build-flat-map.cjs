/** 超平坦训练场布设（操作员盖教室，与学习无关）：一圈方块标本供教师课程使用。
 * 世界：超平坦，表面脚底 y=-60。中心 (0,-60,0) 留空作出生点。 */
const mineflayer = require("mineflayer");
const bot = mineflayer.createBot({ host: "127.0.0.1", port: 25567, username: "SmokeBot", version: "1.21.4" });
const Y = -60;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PATCHES = [
  { name: "stone", fill: [-10, Y, -2, -8, Y, 2, "minecraft:stone"] },
  { name: "dirt", fill: [2, Y, -12, 4, Y, -10, "minecraft:dirt"] },
  { name: "sand", fill: [8, Y, -2, 10, Y, 2, "minecraft:sand"] },
  { name: "gravel", fill: [-2, Y, 8, 2, Y, 10, "minecraft:gravel"] },
  { name: "water", fill: [12, Y, 4, 14, Y, 6, "minecraft:water"] },
  { name: "oak_log", fill: [0, Y, -10, 0, Y + 2, -10, "minecraft:oak_log"] },
  { name: "oak_log", fill: [1, Y, -10, 1, Y + 2, -10, "minecraft:oak_log"] },
  { name: "oak_log", fill: [16, Y, -14, 16, Y + 2, -14, "minecraft:oak_log"] },  // 资源加密（L3 拾取规则的重复素材）
  { name: "oak_log", fill: [17, Y, -14, 17, Y + 2, -14, "minecraft:oak_log"] },
  { name: "oak_log", fill: [-16, Y, 14, -16, Y + 2, 14, "minecraft:oak_log"] },
  { name: "oak_log", fill: [-17, Y, 14, -17, Y + 2, 14, "minecraft:oak_log"] },
  { name: "oak_leaves", fill: [-1, Y + 3, -11, 2, Y + 3, -9, "minecraft:oak_leaves"] },
  { name: "oak_planks", fill: [-12, Y, 6, -12, Y + 1, 6, "minecraft:oak_planks"] },
  { name: "gold_block", setblock: [4, Y, 12, "minecraft:gold_block"] },
  { name: "emerald_block", setblock: [-4, Y, 12, "minecraft:emerald_block"] },
];

// 绕行造链场景：给 (16.5,-14) 木点围一圈 2 格高圆墙（r=4，南侧留缺口）——
// 随机游走撞不进去，只有"绕到缺口→进入→挖→捡"的规划链能到（链式规划的真机验尸场）
const WALL_C = [16.5, -14], WALL_R = 4;
for (let i = 0; i < 32; i++) {
  const a = (i / 32) * Math.PI * 2;
  const dAngle = Math.abs(((a - Math.PI / 2 + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  if (dAngle < (Math.PI / 32) * 2) continue; // 南侧（+z）留 2 段缺口
  const wx = Math.round(WALL_C[0] + WALL_R * Math.cos(a));
  const wz = Math.round(WALL_C[1] + WALL_R * Math.sin(a));
  PATCHES.push({ name: "wall", fill: [wx, Y, wz, wx, Y + 1, wz, "minecraft:cobblestone"] });
}

bot.once("spawn", async () => {
  await sleep(1500);
  // 先清场：历次课程/测试留下的挖掘坑与随手放的方块会卡住寻路（实测 z=-2.3 反复卡死）。
  // 操作员维护教室：48×48 场地 y≥-59 清空，y=-60 重铺草地，掉落物清掉。
  bot.chat("/fill -24 -59 -24 24 -52 24 air");
  await sleep(400);
  bot.chat("/fill -24 -60 -24 24 -60 24 grass_block");
  await sleep(400);
  bot.chat("/kill @e[type=item]");
  await sleep(400);
  // 超平坦史莱姆成群撞击 bot，寻路反复被打断（实测往返卡死在标本带边界）——训练场设和平模式
  bot.chat("/difficulty peaceful");
  await sleep(400);
  bot.chat("/kill @e[type=!player]");
  await sleep(400);
  for (const p of PATCHES) {
    if (p.fill) bot.chat(`/fill ${p.fill.join(" ")}`);
    if (p.setblock) bot.chat(`/setblock ${p.setblock.join(" ")}`);
    await sleep(300);
  }
  console.log(`训练场布设完成：${PATCHES.length} 处标本（中心 0,${Y},0 出生点）`);
  bot.quit();
  process.exit(0);
});
bot.once("error", (e) => { console.error(e.message); process.exit(1); });

/** 固定俯瞰相机（3010 端口）：地图已建好，本进程只做旁观视角，不再改世界。 */
const mineflayer = require("mineflayer");
const viewer = require("prismarine-viewer").mineflayer;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bot = mineflayer.createBot({ host: "localhost", port: 25565, username: "MapBuilder", version: "1.20.1" });
bot.once("spawn", async () => {
  await sleep(1500);
  bot.chat("/tp @s 12.5 8 5.5");
  await sleep(600);
  const yaw = Math.atan2(-(2 - 12.5), 0.5 - 5.5); // 看向工作区中心 (2, 5, 0.5)
  await bot.look(yaw, 0.25, true).catch(() => {});
  viewer(bot, { port: 3010, firstPerson: true, viewDistance: 6 });
  console.log("固定俯瞰相机：http://localhost:3010");
});
bot.once("error", (e) => { console.error(e.message); process.exit(1); });

/** 手动射线调试：逐步打印射线路径上的 blockAt 结果，定位断点。 */
const mineflayer = require("mineflayer");
const Vec3 = require("vec3");
const { Y, sleep } = require("./mc-bench.cjs");

const bot = mineflayer.createBot({ host: "localhost", port: 25565, username: "SmokeBot", version: "1.20.1" });
bot.once("spawn", async () => {
  try {
    bot.chat("/gamemode spectator @s");
    await sleep(800);
    bot.chat(`/tp @s 1.5 ${Y} 0.5`);
    await sleep(800);
    const p = bot.entity.position;
    console.log("位置:", p.toString());
    const eye = new Vec3(p.x, p.y + 1.62, p.z);
    // 直接朝 +X 水平看（瞄准墙 y=5.5 中心高度，确保穿过 (3,5,0)）
    const yaw = Math.atan2(-1, 0), pitch = Math.atan2(eye.y - 5.5, 2.0);
    await bot.look(yaw, pitch, true);
    await sleep(400);
    const dir = new Vec3(-Math.sin(bot.entity.yaw) * Math.cos(bot.entity.pitch), -Math.sin(bot.entity.pitch), Math.cos(bot.entity.yaw) * Math.cos(bot.entity.pitch));
    console.log("姿态 yaw=", bot.entity.yaw.toFixed(2), "pitch=", bot.entity.pitch.toFixed(2), "dir=", dir.toString());
    for (let d = 0.25; d <= 4; d += 0.25) {
      const pt = eye.plus(dir.scale(d));
      const b = bot.blockAt(pt);
      console.log(`d=${d.toFixed(2)} (${pt.x.toFixed(2)},${pt.y.toFixed(2)},${pt.z.toFixed(2)}) → ${b ? b.name : "null"}`);
    }
    bot.quit(); process.exit(0);
  } catch (e) { console.error(e); process.exit(1); }
});
bot.once("error", (e) => { console.error(e.message); process.exit(1); });

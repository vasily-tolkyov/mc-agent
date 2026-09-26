/** frontBlock 射线直视探针：站到墙/金垫/箱源旁，按 concept-agent 的同款逻辑采帧并打印。 */
const mineflayer = require("mineflayer");
const Vec3 = require("vec3");
const { Y, sleep } = require("./mc-bench.cjs");

const bot = mineflayer.createBot({ host: "localhost", port: 25565, username: "SmokeBot", version: "1.20.1" });

function frontBlock(bot, maxDist = 4, step = 0.25) {
  const p = bot.entity.position;
  const ex = p.x, ey = p.y + 1.62, ez = p.z;
  const yaw = bot.entity.yaw, pitch = bot.entity.pitch;
  const cp = Math.cos(pitch);
  const dx = -Math.sin(yaw) * cp, dy = -Math.sin(pitch), dz = Math.cos(yaw) * cp;
  for (let d = step; d <= maxDist; d += step) {
    const b = bot.blockAt(new Vec3(ex + dx * d, ey + dy * d, ez + dz * d));
    if (b && b.name !== "air") return { name: b.name, d: +d.toFixed(2) };
  }
  return { name: "air" };
}

async function lookAtBlock(bot, bx, by, bz) {
  const p = bot.entity.position;
  const dx = bx + 0.5 - p.x, dz = bz + 0.5 - p.z, dy = by + 0.5 - (p.y + 1.62);
  await bot.look(Math.atan2(-dx, dz), Math.atan2(-dy, Math.hypot(dx, dz)), true).catch(() => {});
}

bot.once("spawn", async () => {
  try {
    bot.chat("/gamemode spectator @s");
    await sleep(1000);
    for (const t of [{ x: 3, z: 0, n: "墙" }, { x: 6, z: 0, n: "金垫" }, { x: 0, z: 0, n: "箱源" }]) {
      for (const [ox, oz] of [[1.5, 1.5], [-1.5, 1.2], [1.2, -1.6], [-1.4, -1.4]]) {
        bot.chat(`/tp @s ${(t.x + ox).toFixed(1)} ${Y} ${(t.z + oz).toFixed(1)}`);
        await sleep(400);
        await lookAtBlock(bot, t.x, Y, t.z);
        await sleep(300);
        const f = frontBlock(bot);
        console.log(`${t.n} 旁 (${(t.x + ox).toFixed(1)},${(t.z + oz).toFixed(1)}) → frontBlock=${f.name} (d=${f.d ?? "-"})  yaw=${bot.entity.yaw.toFixed(2)} pitch=${bot.entity.pitch.toFixed(2)}`);
      }
    }
    bot.quit(); process.exit(0);
  } catch (e) { console.error(e); process.exit(1); }
});
bot.once("error", (e) => { console.error(e.message); process.exit(1); });

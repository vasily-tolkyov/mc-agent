/** 操作员救援（带验证）：把 ProtoAgent 传送到训练场中心 (0,-59,0)，读出位置确认，随后收 op。 */
const mineflayer = require("mineflayer");
const bot = mineflayer.createBot({ host: "127.0.0.1", port: 25567, username: "SmokeBot", version: "1.21.4" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
bot.once("spawn", async () => {
  try {
    await sleep(1500);
    bot.chat("/tp ProtoAgent 0 -59 0");
    await sleep(1500);
    const pa = Object.values(bot.entities).find((e) => e.type === "player" && e.username === "ProtoAgent");
    if (!pa) { console.error("✘ 看不到 ProtoAgent，无法确认"); process.exit(1); }
    const p = pa.position;
    const ok = Math.hypot(p.x - 0, p.z - 0) < 3 && p.y > -61 && p.y < -57;
    console.log(`${ok ? "✔" : "✘"} ProtoAgent 现在 pos=${p.toString()}`);
    bot.chat("/deop ProtoAgent");
    bot.chat("/deop SmokeBot");
    await sleep(500);
    bot.quit();
    process.exit(ok ? 0 : 1);
  } catch (e) { console.error("救援失败:", e.message); process.exit(1); }
});
bot.once("error", (e) => { console.error(e.message); process.exit(1); });

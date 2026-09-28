import mineflayer from 'mineflayer';
import { raycastForward } from '../mind/sensory.mjs';

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25567, username: 'SmokeBot', version: '1.21.4' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

bot.once('spawn', async () => {
  try {
    await sleep(1200);
    bot.chat('/tp @s -6.5 -60 0.5');
    await sleep(600);
    console.log('位置:', bot.entity.position.toString());
    for (const ty of [-59.5, -60, -59]) {
      const p = bot.entity.position;
      const dx = -9 - p.x, dz = 0 - p.z, dy = ty - (p.y + 1.62);
      const yaw = Math.atan2(-dx, dz), pitch = Math.atan2(-dy, Math.hypot(dx, dz));
      await bot.look(yaw, pitch, true);
      await sleep(400);
      const hit = raycastForward(bot, 8);
      console.log(`看向 y=${ty}：pitch=${bot.entity.pitch.toFixed(2)} → ${hit ? hit.block.name + ' @d=' + hit.dist.toFixed(2) : 'air(未命中)'}`);
    }
    bot.chat('/tp @s -8.5 -60 0.5');
    await sleep(500);
    for (const dp of [0.3, 0.6, 0.9, 1.2]) {
      await bot.look(bot.entity.yaw, dp, true);
      await sleep(300);
      const hit = raycastForward(bot, 8);
      console.log(`pitch=${dp} → ${hit ? hit.block.name + ' @d=' + hit.dist.toFixed(2) : 'air'}`);
    }
    bot.quit(); process.exit(0);
  } catch (e) { console.error(e); process.exit(1); }
});
bot.once('error', (e) => { console.error(e.message); process.exit(1); });

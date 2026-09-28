/** 转向探针 v2：验证镜像 z 修正——看向镜像点行走，应抵达真目标。 */
import { createBody } from '../mind/body.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const body = createBody({ username: 'SteerProbe2' });
await body.ready;
const bot = body.bot;

// 目标：出生点西北 (0, -5)。镜像转向：lookAt(x, y, 2*p.z - z)
const tx = 0, tz = -5;
for (let i = 0; i < 20; i++) {
  const p = bot.entity.position;
  const d = Math.hypot(tx - p.x, tz - p.z);
  if (d <= 1.2) { console.log(`抵达！${i} 步，位置 ${p.toString()}`); break; }
  await body.lookAt(tx, p.y, 2 * p.z - tz); // 镜像 z
  bot.setControlState('forward', true);
  await sleep(350);
  if (i === 19) console.log(`未抵达，位置 ${bot.entity.position.toString()}（目标 ${tx},${tz}）`);
}
bot.setControlState('forward', false);
await body.quit();
setTimeout(() => process.exit(0), 300);

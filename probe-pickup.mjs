/** 拾取探针 v3：重建场地 → 挖原木 → 看着掉落物用 'back' 接近 → 验证吸入。 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createBody } from './mind/body.mjs';
import { raycastForward } from './mind/sensory.mjs';

execFileSync(process.execPath, [path.join(path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))), 'build-flat-map.cjs')], { stdio: 'inherit' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const body = createBody({ username: `PK${Date.now() % 100000}` });
await body.ready;
const bot = body.bot;
const inv = () => bot.inventory.items().map((i) => `${i.name}×${i.count}`).join(',') || '空';
const nearestItem = () => {
  const p = bot.entity.position;
  return Object.values(bot.entities).filter((e) => e.displayName === 'Item' && e.position.distanceTo(p) < 8)
    .sort((a, b) => a.position.distanceTo(p) - b.position.distanceTo(p))[0];
};

await body.goto(0.5, -6.5, 1.0);
await body.lookAt(0.5, -59.5, -10);
await sleep(300);
console.log('命中:', raycastForward(bot, 4)?.block.name, '背包', inv());
await body.act('dig');
await sleep(600);
let it = nearestItem();
console.log('挖后掉落物:', it ? `${it.position.toString()}（距 ${it.position.distanceTo(bot.entity.position).toFixed(2)}m）` : '无', '背包', inv());
for (let k = 0; k < 6 && it; k++) {
  await body.lookAt(it.position.x, it.position.y, it.position.z); // 看着它
  const d0 = it.position.distanceTo(bot.entity.position);
  await body.act('back'); // 关键验证：back 是否朝视线方向移动
  await sleep(200);
  it = nearestItem();
  const d1 = it ? it.position.distanceTo(bot.entity.position) : -1;
  console.log(`back 第${k + 1}步: ${d0.toFixed(2)}m → ${it ? d1.toFixed(2) + 'm' : '已吸入'} 背包=${inv()}`);
}
console.log('终态位置', bot.entity.position.toString(), '背包', inv());
await body.quit();
setTimeout(() => process.exit(0), 300);

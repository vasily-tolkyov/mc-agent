/** 掉落物空间维度探针：挖原木 → 重看掉落物 → 打印 sensoryFrame 的 itemDist/itemType/itemBearing →
 * 转身看方位档变化 → 用 'back'（镜像约定：back 朝视线方向移动）走过去捡起，确认 itemDist 回到 8。
 * 注意：bot.dig 内部会用 mineflayer 原生 lookAt（与本环境视觉镜像相反）把视线甩走，
 * 挖完必须 body.lookAt 重新看向掉落物，否则方位档是"看着别处"的值（如实但不符合探针意图）。 */
import { createBody } from './mind/body.mjs';
import { sensoryFrame, raycastForward } from './mind/sensory.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const body = createBody({ username: `IT${Date.now() % 100000}` });
await body.ready;
const bot = body.bot;
bot.on('playerCollect', (collector, collected) => {
  console.log(`[playerCollect] ${collector.username ?? collector.name ?? collector.id} 拾取了 ${collected.name ?? collected.displayName}`);
});
const fmt = (f) => `itemDist=${f.itemDist} itemType=${f.itemType} itemBearing=${f.itemBearing} | nearType=${f.nearType} nearDist=${f.nearDist.toFixed(2)} yaw=${bot.entity.yaw.toFixed(2)}`;
const nearestItem = () => Object.values(bot.entities)
  .filter((e) => e.displayName === 'Item' && e.position.distanceTo(bot.entity.position) < 8)
  .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];

// 目标：原木柱 (0.5,-10)；若柱已被挖掉则退到 dirt patch (3,-11)（itemType=2）
await body.goto(0.5, -7, 0.8);
await body.lookAt(0.5, -59.5, -10);
await sleep(300);
let target = raycastForward(bot, 4)?.block.name;
let expectType = 4; // oak_log
if (target !== 'oak_log') {
  console.log(`原木柱不可用（命中 ${target ?? '无'}），改挖 dirt patch`);
  await body.goto(3, -8.5, 0.8);
  await body.lookAt(3, -59.5, -11);
  await sleep(300);
  target = raycastForward(bot, 4)?.block.name;
  expectType = 2; // dirt
}
console.log(`挖掘目标=${target ?? '无'} 期望 itemType=${expectType}`, '| 在线玩家:', Object.keys(bot.players).join(','));
console.log('挖前:', fmt(sensoryFrame(bot)));
await body.act('dig');
await sleep(2000); // 实体跟踪延迟
const it0 = nearestItem();
console.log('挖后掉落物:', it0 ? `dist=${it0.position.distanceTo(bot.entity.position).toFixed(2)} @ ${it0.position.toString()}` : '无');
if (it0) await body.lookAt(it0.position.x, it0.position.y, it0.position.z); // 重新看向它（dig 把视线甩走了）
await sleep(300);
for (let i = 0; i < 8; i++) {
  console.log(`帧${i}:`, fmt(sensoryFrame(bot)));
  await sleep(500);
}
await body.act('turnLeft');
console.log('左转1:', fmt(sensoryFrame(bot)));
await body.act('turnLeft');
console.log('左转2:', fmt(sensoryFrame(bot)));
// 看着它用 back 接近（镜像约定），直到吸入
for (let k = 0; k < 6; k++) {
  const it = nearestItem();
  if (!it) { console.log(`back 第${k}步后: 已吸入`); break; }
  await body.lookAt(it.position.x, it.position.y, it.position.z);
  await body.act('back');
  await sleep(200);
  console.log(`back 第${k + 1}步:`, fmt(sensoryFrame(bot)));
}
await sleep(1200);
console.log('捡后:', fmt(sensoryFrame(bot)), '背包=', bot.inventory.items().map((i) => `${i.name}×${i.count}`).join(',') || '空');
await body.quit();
process.exit(0);

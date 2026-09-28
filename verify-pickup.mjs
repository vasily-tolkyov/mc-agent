/** 校准后拾取端到端验证：挖原木 → 丢 → 走远 → 回来 → 用校准后的 forward 逼近 → 必须吸回。
 * 运行：node verify-pickup.mjs */
import { createBody } from './mind/body.mjs';
import { raycastForward } from './mind/sensory.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const body = createBody({ username: `PK${Date.now() % 100000}` });
await body.ready;
await sleep(1500);
const inv = () => body.bot.inventory.items().filter((i) => i.name === 'oak_log').reduce((n, i) => n + i.count, 0);
const nearestItem = () => {
  const p = body.bot.entity.position;
  return Object.values(body.bot.entities).filter((e) => e.displayName === 'Item' && e.position.distanceTo(p) < 12)
    .sort((a, b) => a.position.distanceTo(p) - b.position.distanceTo(p))[0] ?? null;
};

// 挖一根
const blk = body.bot.findBlocks({ point: body.bot.entity.position, maxDistance: 32, matching: [body.bot.registry.blocksByName.oak_log.id], count: 1 })[0];
await body.goto(blk.x, blk.z, 1.2);
await body.lookAt(blk.x + 0.5, blk.y + 0.5, blk.z + 0.5);
await body.act('dig');
await sleep(1200);
console.log(`挖后原木数: ${inv()}（校准前这步就常失败）`);

// 丢、走远、回来
const logs = body.bot.inventory.items().filter((i) => i.name === 'oak_log');
if (logs.length) await body.bot.tossStack(logs[0]).catch(() => {});
const dropP = body.bot.entity.position.clone();
await sleep(400);
await body.goto(dropP.x + 12, dropP.z, 1.5);
await body.goto(dropP.x, dropP.z, 1.2);
await sleep(600);
console.log(`回来后原木数 ${inv()}，最近掉落物 ${nearestItem()?.position.distanceTo(body.bot.entity.position).toFixed(2) ?? '-'}m`);

// 校准后的逼近：盯着掉落物走 forward
for (let k = 0; k < 4 && inv() === 0; k++) {
  const it = nearestItem();
  if (!it) break;
  await body.lookAt(it.position.x, it.position.y, it.position.z);
  const d0 = it.position.distanceTo(body.bot.entity.position);
  await body.act('forward');
  await sleep(500);
  const it2 = nearestItem();
  const d1 = it2 ? it2.position.distanceTo(body.bot.entity.position) : 0;
  console.log(`逼近第 ${k + 1} 步：距离 ${d0.toFixed(2)} → ${d1.toFixed(2)}m，原木数 ${inv()}`);
}
const pass = inv() > 0;
console.log(pass ? '\n✓✓ 校准后拾取成立' : '\n✗✗ 仍未吸回');
body.quit();
process.exit(pass ? 0 : 1);

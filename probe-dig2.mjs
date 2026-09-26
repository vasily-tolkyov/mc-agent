/** 挖掘探针：复刻课程电池序列（到位→看标本→lookDown→dig），逐步验证掉落。 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createBody } from './mind/body.mjs';
import { raycastForward } from './mind/sensory.mjs';

execFileSync(process.execPath, [path.join(path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))), 'build-flat-map.cjs')], { stdio: 'inherit' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const body = createBody({ username: `DG${Date.now() % 100000}` });
await body.ready;
const bot = body.bot;

await body.goto(0.5, -10, 2.2);
await body.lookAt(0.5, -59.5, -10);
console.log('看标本后命中:', raycastForward(bot, 4)?.block.name);
await body.act('lookDown');
const hit = raycastForward(bot, 4);
console.log('lookDown 后命中:', hit ? `${hit.block.name}@${hit.block.position.toString()} dist=${hit.dist.toFixed(2)}` : 'null');
await body.act('dig');
console.log('dig 后该位置方块:', hit ? bot.blockAt(hit.block.position)?.name : '?');
console.log('背包:', bot.inventory.items().map((i) => `${i.name}×${i.count}`).join(',') || '空');
await sleep(2000);
console.log('2s 后该位置方块（服务器权威）:', hit ? bot.blockAt(hit.block.position)?.name : '?');
console.log('2s 后背包:', bot.inventory.items().map((i) => `${i.name}×${i.count}`).join(',') || '空');
await sleep(600);
const p = bot.entity.position;
const items = Object.values(bot.entities).filter((e) => e.displayName === 'Item' && e.position.distanceTo(p) < 8);
console.log('8m 内掉落物:', items.length ? items.map((e) => `${e.position.toString()} d=${e.position.distanceTo(p).toFixed(2)}`).join(' | ') : '无');
await body.quit();
setTimeout(() => process.exit(0), 300);

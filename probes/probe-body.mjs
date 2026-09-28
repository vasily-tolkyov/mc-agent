/** 用生产 body.mjs 的 goto 直接测（第三个账号，避开 ProtoAgent/SmokeBot 冲突）。 */
import { createBody } from '../mind/body.mjs';

const body = createBody({ username: 'ProbeBot' });
await body.ready;
console.log('已连接');
const t = Date.now();
await body.goto(-9, 0, 2.2);
console.log(`goto 返回，耗时 ${((Date.now() - t) / 1000).toFixed(1)}s，位置 ${body.bot.entity.position.toString()}`);
process.exit(0);

/** 移动校准验证（连本地 MC 25567）：8 个 yaw 下，原语 forward 的位移必须 ≡ 视线方向，
 * back ≡ 反视线方向（点积 > 0.7，校准目标 ≤45° 误差；组合键理论 ≤22.5°）。
 * 背景：本协议栈移动与视线跨 x 轴镜像（forward 键实测位移=(-sin,-cos)，视线=(-sin,+cos)），
 * body.mjs 的 MOVE_BASIS 按当前 yaw 选组合键校准。运行：node verify-movement-calib.mjs */
import { createBody } from './mind/body.mjs';

const body = createBody({ username: `MC${Date.now() % 100000}` });
await body.ready;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(2000);

let pass = true;
for (const yawDeg of [0, 45, 90, 135, 180, 225, 270, 315]) {
  await body.lookAt(
    body.bot.entity.position.x - Math.sin((yawDeg * Math.PI) / 180) * 10,
    body.bot.entity.position.y,
    body.bot.entity.position.z + Math.cos((yawDeg * Math.PI) / 180) * 10,
  );
  await sleep(300);
  for (const [act, sign] of [['forward', 1], ['back', -1]]) {
    const yaw = body.bot.entity.yaw;
    const vx = -Math.sin(yaw) * sign, vz = Math.cos(yaw) * sign;
    const p0 = body.bot.entity.position.clone();
    await body.act(act);
    await sleep(250);
    const d = body.bot.entity.position.minus(p0);
    const mag = Math.hypot(d.x, d.z);
    const dot = mag > 0.05 ? (d.x * vx + d.z * vz) / mag : 0; // 单位化后点积（位移方向 vs 期望方向）
    const ok = dot > 0.7;
    if (!ok) pass = false;
    console.log(`yaw=${yawDeg}° ${act}: 位移方向点积 ${dot.toFixed(2)} ${ok ? '✓' : '✗ 镜像未校准'}`);
  }
}
console.log(pass ? '\n✓✓ 移动校准成立：forward≡视线方向' : '\n✗✗ 仍有镜像残留');
body.quit();
process.exit(pass ? 0 : 1);

/** 放置反作弊校验探针：挖 → 走（拾取）→ 对准命中面心 → 放。 */
import mineflayer from 'mineflayer';
import Vec3 from 'vec3';

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25567, username: 'ProbeBot', version: '1.21.4' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ray(bot, maxDist = 4) {
  const p = bot.entity.position, eye = p.offset(0, 1.62, 0);
  const yaw = bot.entity.yaw, pitch = bot.entity.pitch, cp = Math.cos(pitch);
  const dir = new Vec3(-Math.sin(yaw) * cp, -Math.sin(pitch), Math.cos(yaw) * cp);
  let prevAir = null;
  for (let d = 0.25; d <= maxDist; d += 0.25) {
    const pt = eye.plus(dir.scale(d));
    const b = bot.blockAt(pt);
    if (b && b.name !== 'air') return { hit: b, prevAir };
    prevAir = pt.floored();
  }
  return null;
}

bot.once('spawn', async () => {
  try {
    await sleep(1200);
    await bot.look(0, 1.1, true); // 低头
    await sleep(300);
    let r = ray(bot);
    if (!r) throw new Error('挖掘目标没找到');
    await bot.dig(r.hit);
    await sleep(400);
    bot.setControlState('forward', true); await sleep(800); bot.setControlState('forward', false);
    await sleep(500);
    const inv1 = bot.inventory.items();
    console.log('挖+走后背包:', JSON.stringify(inv1.map((i) => i.name + 'x' + i.count)));
    if (!inv1.length) throw new Error('没捡到东西，无法测放置');
    // 重新对准地面（前进后位置变了）
    await bot.look(bot.entity.yaw, 1.0, true);
    await sleep(300);
    r = ray(bot);
    if (!r || !r.prevAir) throw new Error('放置参照没找到');
    const raw = r.prevAir.minus(r.hit.position);
    // 轴对齐吸附（斜面服务器静默拒放）
    const face = Math.abs(raw.x) >= Math.abs(raw.y) && Math.abs(raw.x) >= Math.abs(raw.z) ? new Vec3(Math.sign(raw.x), 0, 0)
      : Math.abs(raw.y) >= Math.abs(raw.z) ? new Vec3(0, Math.sign(raw.y), 0) : new Vec3(0, 0, Math.sign(raw.z));
    const faceCenter = r.hit.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5);
    console.log('参照块:', r.hit.name, r.hit.position.toString(), '轴对齐面:', face.toString(), '面心:', faceCenter.toString());
    await bot.lookAt(faceCenter, true); // 准星对准命中面（反作弊校验要这个）
    await sleep(300);
    await bot.equip(inv1[0], 'hand');
    try { await bot.placeBlock(r.hit, face); console.log('✔ placeBlock 成功'); }
    catch (e) { console.log('✘ placeBlock 错误:', e.message); }
    await sleep(400);
    console.log('放置后背包:', JSON.stringify(bot.inventory.items().map((i) => i.name + 'x' + i.count)));
    bot.quit(); process.exit(0);
  } catch (e) { console.error('探针失败:', e.message); bot.quit(); process.exit(1); }
});
bot.once('error', (e) => { console.error(e.message); process.exit(1); });

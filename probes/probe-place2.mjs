/** 顶面放置探针 v2：挖 → 走 → 低头看中距离地面 → 顶面放置（带占用/体内校验）。 */
import mineflayer from 'mineflayer';
import Vec3 from 'vec3';
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25567, username: 'ProbeBot', version: '1.21.4' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ray = () => {
  const p = bot.entity.position, eye = p.offset(0, 1.62, 0), yaw = bot.entity.yaw, pitch = bot.entity.pitch, cp = Math.cos(pitch);
  const dir = new Vec3(-Math.sin(yaw) * cp, -Math.sin(pitch), Math.cos(yaw) * cp);
  for (let d = 0.25; d <= 4; d += 0.25) { const b = bot.blockAt(eye.plus(dir.scale(d))); if (b && b.name !== 'air') return b; }
  return null;
};
bot.once('spawn', async () => {
  try {
    await sleep(1200);
    let hit = null;
    for (let tries = 0; tries < 8 && !bot.inventory.items().length; tries++) {
      await bot.look(bot.entity.yaw, 1.1, true); await sleep(300);
      hit = ray();
      if (hit) { try { await bot.dig(hit); } catch {} }
      bot.setControlState('forward', true); await sleep(600); bot.setControlState('forward', false); await sleep(500);
    }
    console.log('挣到:', JSON.stringify(bot.inventory.items().map((i) => i.name)));
    if (!bot.inventory.items().length) throw new Error('没挣到东西');
    await bot.look(bot.entity.yaw, 0.5, true); await sleep(300);
    hit = ray();
    if (!hit) throw new Error('放置参照没找到');
    const target = hit.position.offset(0, 1, 0);
    const me = bot.entity.position.floored();
    const blocked = bot.blockAt(target).name !== 'air';
    const inside = target.equals(me) || target.equals(me.offset(0, 1, 0));
    console.log('命中:', hit.name, hit.position.toString(), '目标格占用:', blocked, '在体内:', inside);
    await bot.lookAt(hit.position.offset(0.5, 1, 0.5), true); await sleep(300);
    await bot.equip(bot.inventory.items()[0], 'hand');
    try { await bot.placeBlock(hit, new Vec3(0, 1, 0)); console.log('✔ placeBlock 成功'); }
    catch (e) { console.log('✘ placeBlock 错误:', e.message); }
    await sleep(400);
    console.log('放置后背包:', JSON.stringify(bot.inventory.items().map((i) => i.name + 'x' + i.count)));
    bot.quit(); process.exit(0);
  } catch (e) { console.error('探针失败:', e.message); bot.quit(); process.exit(1); }
});
bot.once('error', (e) => { console.error(e.message); process.exit(1); });

import mineflayer from 'mineflayer';
import Vec3 from 'vec3';
import pf from 'mineflayer-pathfinder'; // CJS 无具名 ESM 导出：默认导入后解构
import minecraftData from 'minecraft-data';
import { raycastForward } from './sensory.mjs';

const { pathfinder, goals, Movements } = pf;

/** 真实生存具身：只发 MC 协议动作（移动/视角/挖掘/放置/换槽），
 * 不使用任何创造指令（无 /tp /give /fill /gamemode）。所有物理动作带超时熔断。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const ACTION_NAMES = ['forward', 'back', 'turnLeft', 'turnRight', 'jump', 'dig', 'place', 'slotNext', 'lookUp', 'lookDown'];

async function withTimeout(p, ms, onTimeout) {
  let t;
  try {
    return await Promise.race([
      Promise.resolve(p).catch((e) => { // 快速失败也要可见：静默吞错会藏起真因
        process.stderr.write(`[动作失败] ${String(e?.message ?? e).slice(0, 140)}\n`);
        return undefined;
      }),
      new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); }),
    ]);
  } catch {
    if (onTimeout) onTimeout();
    process.stderr.write(`[熔断] ${ms}ms 超时\n`);
    return undefined;
  } finally { clearTimeout(t); }
}

export function createBody({ host = '127.0.0.1', port = 25567, username = 'ProtoAgent', version = '1.21.4' } = {}) {
  const bot = mineflayer.createBot({ host, port, username, version });
  bot.loadPlugin(pathfinder);
  const state = { online: false };

  const ready = new Promise((resolve, reject) => {
    bot.once('spawn', () => { state.online = true; resolve(); });
    bot.once('error', reject);
  });
  bot.once('error', (e) => { console.error('body error:', e.message); });
  bot.once('end', () => { state.online = false; });

  const drive = async (key, ms) => {
    bot.setControlState(key, true);
    await sleep(ms);
    bot.setControlState(key, false);
    await sleep(140);
  };
  const look = async (yaw, pitch) => {
    const p = Math.max(-1.57, Math.min(1.57, pitch));
    await withTimeout(bot.look(yaw, p, true), 3000);
  };

  return {
    bot, ready,
    isOnline: () => state.online,
    /** 教师导航用：精确看向世界点（与 look() 同物理，只供课程导航，不进学习动作表） */
    async lookAt(x, y, z) {
      const p = bot.entity.position;
      const dx = x - p.x, dz = z - p.z, dy = y - (p.y + 1.62);
      await look(Math.atan2(-dx, dz), Math.atan2(-dy, Math.hypot(dx, dz)));
    },
    /** 教师带路用：真实寻路走到目标附近（pathfinder 导航，不是传送；熔断随距离伸缩）。
     * GoalNearXZ 只管水平距离（GoalNear 的 y 判定让"已到目标"永不完成的实测根因）；
     * 已在半径内直接返回——pathfinder 对"无路可走的已满足目标"不发事件、挂到熔断（又一实测根因）。 */
    async goto(x, z, r = 1.5) {
      const dist = Math.hypot(x - bot.entity.position.x, z - bot.entity.position.z);
      if (dist <= r) { process.stderr.write(`[goto] 已在半径内 (${dist.toFixed(1)}m ≤ ${r}m)，直接返回\n`); return; }
      if (!bot.pathfinder.movements) bot.pathfinder.setMovements(new Movements(bot, minecraftData(bot.version)));
      const t0 = Date.now();
      const fuseMs = Math.max(15000, dist * 1200); // 步行 ~4.3m/s 留 2.8 倍余量
      process.stderr.write(`[goto] 发起 (${x},${z}) 当前 y=${bot.entity.position.y.toFixed(1)}\n`);
      await withTimeout(bot.pathfinder.goto(new goals.GoalNearXZ(x, z, r)), fuseMs,
        () => { try { bot.pathfinder.setGoal(null); } catch { /* */ } });
      process.stderr.write(`[goto] 返回 ${((Date.now() - t0) / 1000).toFixed(1)}s pos=${bot.entity.position.toString()}\n`);
    },
    async act(name) {
      switch (name) {
        case 'forward': return drive('forward', 800);
        case 'back': return drive('back', 600);
        case 'turnLeft': return look(bot.entity.yaw + Math.PI / 4, bot.entity.pitch);
        case 'turnRight': return look(bot.entity.yaw - Math.PI / 4, bot.entity.pitch);
        case 'jump': { bot.setControlState('jump', true); await sleep(450); bot.setControlState('jump', false); return sleep(140); }
        case 'dig': {
          const hit = raycastForward(bot, 4);
          if (!hit || !hit.block.diggable) return;
          const yaw0 = bot.entity.yaw, pitch0 = bot.entity.pitch; // mineflayer 原生 lookAt 用镜像 yaw 公式（子 agent 实证的地雷），dig 会把视线甩飞——挖前存视线
          await withTimeout(bot.dig(hit.block), 9000, () => { try { bot.stopDigging(); } catch { /* */ } });
          await withTimeout(bot.look(yaw0, pitch0, true), 3000); // 挖后恢复（否则后续帧全在"看别处"）
          return sleep(300);
        }
        case 'place': {
          // 顶面放置：命中块顶面放（新块在 bot 前方）；顶上有东西或落在自己身体就老实不放
          const ref = raycastForward(bot, 4);
          const inv = bot.inventory.items()[0];
          if (!ref || !inv) return;
          const target = ref.block.position.offset(0, 1, 0);
          if (bot.blockAt(target).name !== 'air') return;
          const me = bot.entity.position.floored();
          if (target.equals(me) || target.equals(me.offset(0, 1, 0))) return;
          const yaw0 = bot.entity.yaw, pitch0 = bot.entity.pitch; // 同 dig：placeBlock 内部 lookAt 也是镜像
          await withTimeout(bot.lookAt(ref.block.position.offset(0.5, 1, 0.5), true), 3000); // 准星对准顶面中心（反作弊）
          await withTimeout(bot.equip(inv, 'hand'), 4000);
          await withTimeout(bot.placeBlock(ref.block, new Vec3(0, 1, 0)), 6000);
          await withTimeout(bot.look(yaw0, pitch0, true), 3000); // 放后恢复视线
          return sleep(200);
        }
        case 'slotNext': return withTimeout(bot.setQuickBarSlot((bot.quickBarSlot + 1) % 9), 3000);
        case 'lookUp': return look(bot.entity.yaw, bot.entity.pitch - 0.4);
        case 'lookDown': return look(bot.entity.yaw, bot.entity.pitch + 0.4);
        default: throw new Error('unknown action: ' + name);
      }
    },
    async quit() { try { bot.quit(); } catch { /* */ } },
  };
}

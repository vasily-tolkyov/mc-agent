import Vec3 from 'vec3';
import minecraftData from 'minecraft-data';

const mcDataCache = new Map(); // 版本 → minecraft-data（sensoryFrame 每帧调用，不能每次重载）
/** 掉落物实体 → 物品名：实体 metadata 里的物品槽（原始槽数据带 itemId），按注册表查名。 */
function dropItemName(bot, e) {
  const slot = e.metadata?.find?.((m) => m && typeof m === 'object' && m.itemId != null);
  if (!slot) return null;
  let mc = mcDataCache.get(bot.version);
  if (!mc) { mc = minecraftData(bot.version); mcDataCache.set(bot.version, mc); }
  return mc.items[slot.itemId]?.name ?? null;
}

/** 自我中心感知帧：所有维度都是"以我为准"的关系量，没有绝对坐标进学习输入。
 * 面前方块 = 纯算术视线步进（教训：本环境的 vec3.plus/scale 与 blockInSight 都不可靠）。 */
export const BLOCK_IDS = {
  air: 0, grass_block: 1, dirt: 2, stone: 3, oak_log: 4, oak_leaves: 5,
  water: 6, sand: 7, gravel: 8, oak_planks: 9, gold_block: 10, emerald_block: 11,
};
export const blockId = (name) => BLOCK_IDS[name] ?? 12; // 其余类型归并一档

const CONT = (name, min, max) => ({ name, min, max });
const DISC = (name, bins) => ({ name, min: -0.5, max: bins - 0.5, sigma: 0.225 });
export const SENSORY_DIMS = [
  CONT('nearDist', 0, 8),          // 面前最近非空气方块距离
  DISC('nearType', 13),            // 面前方块类型（离散档）
  DISC('belowType', 13),           // 脚下方块类型
  DISC('grip', 9),                 // 背包物品总数（截顶 8）——计数是离散档：连续编码会让 0/1/2 共享感受野焊成一族（L3 空手套白狼根因）
  DISC('logGrip', 9),              // 背包原木数（截顶 8）——同上
  CONT('speed', 0, 0.5),           // 水平速度模
  DISC('onGround', 2),             // 是否着地
  DISC('viewWell', 14),            // 视网膜认出的视觉井稳定槽位（0-12），13=未识别（由 mind-agent 的视网膜流填写）
  DISC('itemDist', 9),             // 最近掉落物实体距离（0-8 截顶取整，无掉落物=8）
  DISC('itemType', 13),            // 最近掉落物类型（复用方块字母表，非方块物品归 12，无掉落物=0）
  DISC('itemBearing', 9),          // 掉落物相对视线方位：扇区 -4..4 → 0..8（正前=4，无掉落物=0）
];
export const DIM_NAMES = SENSORY_DIMS.map((d) => d.name);

const EYE = 1.62;
export function raycastForward(bot, maxDist = 8, step = 0.25) {
  const p = bot.entity.position;
  const yaw = bot.entity.yaw, pitch = bot.entity.pitch;
  const cp = Math.cos(pitch);
  const dx = -Math.sin(yaw) * cp, dy = -Math.sin(pitch), dz = Math.cos(yaw) * cp;
  let prevAir = null;
  for (let d = step; d <= maxDist; d += step) {
    const pt = new Vec3(p.x + dx * d, p.y + EYE + dy * d, p.z + dz * d);
    const b = bot.blockAt(pt);
    if (b && b.name !== 'air') return { block: b, dist: d, prevAir }; // prevAir = 命中前的空气格（放置该落这里）
    prevAir = pt.floored();
  }
  return null;
}

export function sensoryFrame(bot) {
  const hit = raycastForward(bot, 8);
  const below = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
  const items = bot.inventory.items();
  const grip = Math.min(8, items.reduce((n, i) => n + i.count, 0));
  const logGrip = Math.min(8, items.filter((i) => i.name === 'oak_log').reduce((n, i) => n + i.count, 0));
  const v = bot.entity.velocity;
  // 最近掉落物实体（实体跟踪有 1-2s 延迟：刚掉落的物品可能暂不可见，如实接受）
  const p = bot.entity.position;
  const drop = Object.values(bot.entities)
    .filter((e) => e.displayName === 'Item' && e.position.distanceTo(p) < 8)
    .sort((a, b) => a.position.distanceTo(p) - b.position.distanceTo(p))[0];
  let itemDist = 8, itemType = 0, itemBearing = 0;
  if (drop) {
    itemDist = Math.min(8, Math.round(drop.position.distanceTo(p)));
    itemType = blockId(dropItemName(bot, drop)); // 物品名多对应方块名（oak_log）；非方块物品（lead 等）兜底 12
    // 视觉约定 viewDir=(-sin(yaw), +cos(yaw))（本环境 yaw 镜像：看 dz=+cos，走 dz=−cos，已实证）
    const vx = -Math.sin(bot.entity.yaw), vz = Math.cos(bot.entity.yaw);
    const dx = drop.position.x - p.x, dz = drop.position.z - p.z;
    const len = Math.hypot(dx, dz);
    if (len > 1e-3) { // 贴在脚上的掉落物没有方位可言，留默认 0（正中）
      const ix = dx / len, iz = dz / len;
      const alpha = Math.atan2(vx * iz - vz * ix, vx * ix + vz * iz); // 有向夹角 (-π,π]，>0 偏右
      itemBearing = Math.min(8, Math.max(0, Math.round(alpha / (Math.PI / 4)) + 4)); // 扇区 -4..4 → 0..8，正前=4
    }
  }
  return {
    nearDist: hit ? hit.dist : 8,
    nearType: hit ? blockId(hit.block.name) : 0,
    belowType: blockId(below?.name ?? 'air'),
    grip, logGrip,
    speed: Math.hypot(v.x, v.z),
    onGround: bot.entity.onGround ? 1 : 0,
    viewWell: 13, // 默认未识别；mind-agent 的视网膜流每帧覆写
    itemDist, itemType, itemBearing,
  };
}

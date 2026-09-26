/**
 * MC 箱子世界共享模块：状态空间、世界几何、实验台（传送设状态 + 生存物理执行 + 真实读出）。
 * 所有物理动作带超时熔断（goto/dig/place 的 Promise 可能永不返回——实测死锁教训）；
 * 超时即取消动作、如实记为该次尝试失败。live-agent.cjs 与 interactive-agent.cjs 共用。
 */
const { goals } = require("mineflayer-pathfinder");
const Vec3 = require("vec3");

const Y = 5;
const Z0 = 0, Z1 = 2;
const ZONE_MAX = 6;
const SRC_X = 0, TGT_X = 6;

const MC_BOX_SPACE = {
  states: [
    { name: "zone", outcome: "nextZone", bins: 7 },
    { name: "lane", outcome: "nextLane", bins: 2 },
    { name: "carry", outcome: "nextCarry", bins: 2 },
    { name: "stack", outcome: "nextStack", bins: 3 },
  ],
  actions: [{ name: "move", bins: 5 }, { name: "handle", bins: 4 }], // handle: 0=无 1=挖箱源 2=放置堆垛 3=拆除堆垛
  diameter: 26, // 箱子世界先例（"实测 24 不够"）；MC 有 7 区 × 4 操作，双程往返 ~22 步，预算=maxDepth×20
};

// 站立高度：箱源柱顶 / 墙顶 / 垫+堆垛顶，其余为地板
const feetY = (zone, lane, stack) => {
  if (lane === 0) {
    if (zone === 0) return Y + 2;
    if (zone === 3) return Y + 2;
    if (zone === ZONE_MAX) return Y + 1 + stack;
  }
  return Y;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 超时熔断：Promise 永不返回时按失败处理（并执行 cancel 清理副作用），不造假结果。 */
async function withTimeout(p, ms, tag, onTimeout) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(p).catch(() => undefined),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout:${tag}`)), ms); }),
    ]);
  } catch {
    if (onTimeout) onTimeout();
    process.stderr.write(`  [熔断] ${tag} ${ms}ms 超时，按失败处理\n`);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** 世界修复（幂等）：金垫、墙、箱源复原；堆垛区清空。 */
function repairWorld(bot) {
  bot.chat(`/setblock ${TGT_X} ${Y} ${Z0} minecraft:gold_block`);
  bot.chat(`/fill ${TGT_X} ${Y + 1} ${Z0} ${TGT_X} ${Y + 3} ${Z0} minecraft:air`);
  bot.chat(`/fill 3 ${Y} 0 3 ${Y + 1} 0 minecraft:stone`);
  bot.chat(`/fill ${SRC_X} ${Y} ${Z0} ${SRC_X} ${Y + 1} ${Z0} minecraft:oak_planks`);
}

function makeReadState(bot) {
  return () => {
    const p = bot.entity.position;
    const zone = Math.max(0, Math.min(ZONE_MAX, Math.floor(p.x))); // 站在方块 x=n 上（x∈[n,n+1)）即 zone n；round 在半格边界会漂
    const lane = p.z >= Z1 - 1 ? 1 : 0;
    const carry = bot.inventory.items().some((i) => i.name === "oak_planks") ? 1 : 0;
    let stack = 0;
    for (let dy = 1; dy <= 2; dy++) { // 堆垛在金垫上方：Y+1 / Y+2
      const b = bot.blockAt(new Vec3(TGT_X, Y + dy, Z0));
      if (b && b.name === "oak_planks") stack = dy; else break;
    }
    return { zone, lane, carry, stack };
  };
}

function makeBench(bot, { log = () => {}, isOnline = () => true } = {}) {
  const readState = makeReadState(bot);
  // 传送后俯视并朝向工作区（目标垫方向），否则第一人称画面大半是天空
  const lookAtWorkArea = () => {
    const p = bot.entity.position;
    const yaw = Math.atan2(-(TGT_X + 0.5 - p.x), Z0 + 0.5 - p.z); // MC yaw: 0=+Z，逆时针
    bot.look(yaw, 0.7, true).catch(() => {});
  };
  return {
    readState,
    async conduct(state, action) {
      // 状态设置（传送是实验台仪表，不是世界规律）
      bot.chat(`/tp @s ${state.zone + 0.5} ${feetY(state.zone, state.lane, state.stack)} ${state.lane === 1 ? Z1 + 0.5 : Z0 + 0.5}`);
      // carry 语义精确化：先清空再只给 1 块——否则放掉 1 块还剩 7 块，carry 永远粘住（路线被堵死的根因）
      bot.chat("/clear @s minecraft:oak_planks");
      if (state.carry) bot.chat("/give @s minecraft:oak_planks 1");
      bot.chat(`/fill ${TGT_X} ${Y + 1} ${Z0} ${TGT_X} ${Y + 3} ${Z0} minecraft:air`); // 清堆垛区，保住金垫
      if (state.stack > 0) bot.chat(`/fill ${TGT_X} ${Y + 1} ${Z0} ${TGT_X} ${Y + state.stack} ${Z0} minecraft:oak_planks`);
      bot.chat(`/fill ${SRC_X} ${Y} ${Z0} ${SRC_X} ${Y + 1} ${Z0} minecraft:oak_planks`); // 箱源复原
      bot.chat(`/fill 3 ${Y} 0 3 ${Y + 1} 0 minecraft:stone`); // 墙自愈（墙顶曾被未知原因破坏，每次实验前补齐）
      await sleep(500);
      lookAtWorkArea();
      // 移动（真实寻路；撞墙/爬不上就如实失败停在原地；熔断后校验不到位再试一次）
      if (action.move !== 4) {
        const t = { zone: state.zone, lane: state.lane };
        if (action.move === 0) t.zone = Math.max(0, t.zone - 1);
        if (action.move === 1) t.zone = Math.min(ZONE_MAX, t.zone + 1);
        if (action.move === 2) t.lane = 0;
        if (action.move === 3) t.lane = 1;
        const g = new goals.GoalNear(t.zone + 0.5, feetY(t.zone, t.lane, state.stack), t.lane === 1 ? Z1 + 0.5 : Z0 + 0.5, 0.25);
        const gotoOnce = () => withTimeout(bot.pathfinder.goto(g), 20000, "goto", () => { try { bot.pathfinder.setGoal(null); } catch { /* */ } });
        await gotoOnce();
        const at = () => { const p = bot.entity.position; return Math.max(0, Math.min(ZONE_MAX, Math.floor(p.x))) === t.zone && (p.z >= Z1 - 1 ? 1 : 0) === t.lane; };
        if (!at()) await gotoOnce();
      }
      // 挖掘箱源（够不着就如实失败；拾取后回到原位——拾取走位是执行噪声不是规律；
      // 挖到但没捡到就再试一次：bench 测的是稳定底层物理，不是首次尝试的手滑）
      if (action.handle === 1) {
        for (let attempt = 0; attempt < 2; attempt++) {
          let src = bot.blockAt(new Vec3(SRC_X, Y, Z0));
          if (!src || src.name !== "oak_planks") src = bot.blockAt(new Vec3(SRC_X, Y + 1, Z0));
          if (!src || src.name !== "oak_planks") break;
          const before = bot.entity.position.clone();
          const planksBefore = bot.inventory.items().filter((i) => i.name === "oak_planks").reduce((n, i) => n + i.count, 0);
          await withTimeout(bot.dig(src), 15000, "dig", () => { try { bot.stopDigging(); } catch { /* */ } });
          const broke = bot.blockAt(src.position).name === "air";
          if (!broke) break; // 够不着/挖不动是真实物理，不重试
          await sleep(300);
          await withTimeout(bot.pathfinder.goto(new goals.GoalNear(SRC_X + 0.5, Y, Z0 + 0.5, 0.6)), 20000, "pickup-goto",
            () => { try { bot.pathfinder.setGoal(null); } catch { /* */ } });
          await sleep(600);
          const planksAfter = bot.inventory.items().filter((i) => i.name === "oak_planks").reduce((n, i) => n + i.count, 0);
          if (planksAfter <= planksBefore) await sleep(600);
          bot.chat(`/tp @s ${before.x.toFixed(2)} ${before.y.toFixed(2)} ${before.z.toFixed(2)}`);
          await sleep(200);
          const gained = bot.inventory.items().filter((i) => i.name === "oak_planks").reduce((n, i) => n + i.count, 0) > planksBefore;
          if (gained) break; // 拿到了才停
        }
      }
      // 放置到堆垛顶（box-world 语义：stack 封顶 2；放了但堆高没变就重试一次）
      if (action.handle === 2 && state.stack < 2) {
        for (let attempt = 0; attempt < 2; attempt++) {
          const top = bot.blockAt(new Vec3(TGT_X, Y + state.stack, Z0)); // stack=0 → 金垫
          const inv = bot.inventory.items().find((i) => i.name === "oak_planks");
          if (!top || top.name === "air" || !inv) break; // 无条件放置是真实物理，不重试
          await withTimeout(bot.equip(inv, "hand"), 5000, "equip");
          await withTimeout(bot.placeBlock(top, new Vec3(0, 1, 0)), 10000, "place");
          if (bot.blockAt(new Vec3(TGT_X, Y + state.stack + 1, Z0)).name === "oak_planks") break; // 放上了才停
        }
      }
      // 拆除堆垛顶（挖掉最上层木板：stack-1。拾取按真实物理：拆最后一层时物品落在垫上、
      // 走上去即可捡到（carry+1）；拆第二层时物品留在第一层顶上、地板上吸不到（carry 不变）——
      // 两种结果都是世界的真实规律，模型如实学习）
      if (action.handle === 3 && state.stack > 0) {
        const topPlank = bot.blockAt(new Vec3(TGT_X, Y + state.stack, Z0));
        if (topPlank && topPlank.name === "oak_planks") {
          const before = bot.entity.position.clone();
          await withTimeout(bot.dig(topPlank), 15000, "dig-stack", () => { try { bot.stopDigging(); } catch { /* */ } });
          const broke = bot.blockAt(topPlank.position).name === "air";
          if (broke) {
            await sleep(400); // 等物品下落
            // 先走到垫旁
            await withTimeout(bot.pathfinder.goto(new goals.GoalNear(TGT_X + 0.5, Y, Z0 + 1.5, 0.3)), 20000, "pickup-goto",
              () => { try { bot.pathfinder.setGoal(null); } catch { /* */ } });
            await sleep(500);
            const gained = () => bot.inventory.items().some((i) => i.name === "oak_planks");
            // 拆空了（stack→0）时垫顶可走，上去吸物品
            if (state.stack === 1 && !gained()) {
              await withTimeout(bot.pathfinder.goto(new goals.GoalNear(TGT_X + 0.5, Y + 1, Z0 + 0.5, 0.2)), 15000, "pickup-climb",
                () => { try { bot.pathfinder.setGoal(null); } catch { /* */ } });
              await sleep(600);
            }
            bot.chat(`/tp @s ${before.x.toFixed(2)} ${before.y.toFixed(2)} ${before.z.toFixed(2)}`);
            await sleep(200);
          }
        }
      }
      await sleep(300);
      if (!isOnline()) throw new Error("bench-offline：连接中断，本次实验作废（不写入观察）");
      const next = readState();
      return Object.fromEntries(MC_BOX_SPACE.states.map((d) => [d.outcome, next[d.name]]));
    },
  };
}

module.exports = { MC_BOX_SPACE, Y, Z0, Z1, ZONE_MAX, SRC_X, TGT_X, feetY, sleep, withTimeout, repairWorld, makeReadState, makeBench };

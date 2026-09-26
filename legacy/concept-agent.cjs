/**
 * 概念自形成实机验证（独立进程，不动 ProtoAgent 的规划管线）。
 * ConceptBot 在 MC 世界里游走观察，原始感知流（面前/脚下方块类型、邻域计数、背包、坐标）
 * 经 SensoryEncoder 高斯感受野编码进能量网络，ConceptFormation 共现成阱让概念自己长出来，
 * 教师程序从概念中心值反推语义标签（"面前是石头"等），最后在没采过帧的新位置做泛化读出。
 * 状态面板：http://localhost:3011
 */
const mineflayer = require("mineflayer");
const { pathfinder } = require("mineflayer-pathfinder");
const viewer = require("prismarine-viewer").mineflayer;
const Vec3 = require("vec3");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Y, ZONE_MAX, SRC_X, TGT_X, sleep } = require("./mc-bench.cjs");

const REPO = path.resolve(__dirname, "..", "energy-network-sim");
const url = (p) => "file:///" + p.replace(/\\/g, "/");
const LOG = path.join(__dirname, "concept.log");
fs.writeFileSync(LOG, "");
const out = (s) => { console.log(s); fs.appendFileSync(LOG, s + "\n"); };

// 方块类型 → 离散档（感知层的"对象词汇"由网络自己形成，这里只给类型一个数值载体）
const BLOCK_IDS = { air: 0, stone: 1, oak_planks: 2, gold_block: 3, grass_block: 4, bedrock: 5, emerald_block: 6 };
const blockId = (name) => BLOCK_IDS[name] ?? 7;
const ID_NAMES = Object.fromEntries(Object.entries(BLOCK_IDS).map(([k, v]) => [v, k]));

// 感知维度：对象相关特征（让"石头/金块/木板"成为概念）+ 坐标 + 背包
const CONT = (name, min, max) => ({ name, min, max });
const DISC = (name, bins) => ({ name, min: -0.5, max: bins - 0.5, sigma: 0.225 }); // 离散档 σ 标定（相邻档感受野不相交）
const DIMS = [
  DISC("frontBlock", 8), DISC("belowBlock", 8),      // 面前/脚下第一个方块类型
  CONT("nearStone", 0, 12), CONT("nearPlanks", 0, 12), CONT("nearGold", 0, 4), // 3×3×3 邻域计数
  CONT("carrying", 0, 8),                             // 背包木板数
  CONT("x", -8, 14), CONT("z", -6, 8),                // 坐标（位置概念也允许自形成）
];

async function main() {
  const { SensoryEncoder } = await import(url(path.join(REPO, "dist/src/pop/concept/sensory.js")));
  const { ConceptFormation } = await import(url(path.join(REPO, "dist/src/pop/concept/formation.js")));
  const { EmergentMap } = await import(url(path.join(REPO, "dist/src/pop/concept/emergent-map.js")));

  const enc = new SensoryEncoder(DIMS, 40);
  const formation = new ConceptFormation(enc);

  let frameCount = 0, em = null, concepts = [];
  const labelMap = new Map(); // conceptId → 标签（教师程序）
  let lastFrame = null, lastResolved = null;

  const bot = mineflayer.createBot({ host: "localhost", port: 25565, username: "ConceptBot", version: "1.20.1" });
  bot.loadPlugin(pathfinder);

  // ── 感知帧采集 ──────────────────────────────────────────
  const eyeY = () => bot.entity.position.y + 1.62;
  async function lookAtBlock(bx, by, bz) { // 精确瞄准方块中心（随机仰俯角会飘出目标）
    const p = bot.entity.position;
    const dx = bx + 0.5 - p.x, dz = bz + 0.5 - p.z;
    const dy = by + 0.5 - eyeY();
    await bot.look(Math.atan2(-dx, dz), Math.atan2(-dy, Math.hypot(dx, dz)), true).catch(() => {});
  }
  function frontBlock(maxDist = 4, step = 0.25) {
    // 纯算术视线步进（本环境的 vec3 plus/scale 行为有坑，实测非线性——不用它）
    const p = bot.entity.position;
    const ex = p.x, ey = p.y + 1.62, ez = p.z;
    const yaw = bot.entity.yaw, pitch = bot.entity.pitch; // MC 约定：pitch 正值向下
    const cp = Math.cos(pitch);
    const dx = -Math.sin(yaw) * cp, dy = -Math.sin(pitch), dz = Math.cos(yaw) * cp;
    for (let d = step; d <= maxDist; d += step) {
      const b = bot.blockAt(new Vec3(ex + dx * d, ey + dy * d, ez + dz * d));
      if (b && b.name !== "air") return b.name;
    }
    return "air";
  }
  function observe() {
    const p = bot.entity.position;
    const front = frontBlock(); // 视线上 4 格内第一个非空气方块
    const fp = p.floored();
    const below = bot.blockAt(fp.offset(0, -1, 0));
    let nearStone = 0, nearPlanks = 0, nearGold = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const b = bot.blockAt(fp.offset(dx, dy, dz));
      if (!b) continue;
      if (b.name === "stone") nearStone++;
      else if (b.name === "oak_planks") nearPlanks++;
      else if (b.name === "gold_block") nearGold++;
    }
    const carrying = bot.inventory.items().filter((i) => i.name === "oak_planks").reduce((n, i) => n + i.count, 0);
    return {
      frontBlock: blockId(front), belowBlock: blockId(below?.name ?? "air"),
      nearStone, nearPlanks, nearGold, carrying, x: p.x, z: p.z,
    };
  }

  // ── 概念刷新 + 教师程序标签（从概念中心值反推语义）──
  function refreshConcepts() {
    concepts = formation.extractConcepts(0.5);
    em = new EmergentMap(concepts, enc);
    labelMap.clear();
    for (const c of concepts) {
      const v = Math.round(c.centerValue);
      if (c.dimension === "frontBlock") labelMap.set(c.conceptId, `面前是${ID_NAMES[v] ?? "未知"}`);
      else if (c.dimension === "belowBlock") labelMap.set(c.conceptId, `脚下是${ID_NAMES[v] ?? "未知"}`);
      else if (c.dimension === "carrying") labelMap.set(c.conceptId, v === 0 ? "空手" : `拿着${v}块木板`);
      else if (c.dimension === "x") labelMap.set(c.conceptId, `在 x≈${c.centerValue.toFixed(1)} 一带`);
      else if (c.dimension === "z") labelMap.set(c.conceptId, `在 z≈${c.centerValue.toFixed(1)} 一带`);
      else if (c.dimension.startsWith("near")) labelMap.set(c.conceptId, `附近${c.dimension.slice(4)}≈${v}个`);
    }
  }

  // ── 泛化验证：在没采过帧的位置，概念是否仍被认出 ──
  async function generalizationTest() {
    if (!em || concepts.length === 0) return;
    const spots = [ // 刻意远离采样区的测试点（视距 4 格内才能"看见"对象）
      { x: 5.5, z: 2.0, lookAt: [3, 0], expect: "面前是stone（墙）" },
      { x: 8.5, z: 2.5, lookAt: [6, 0], expect: "面前是gold_block（金垫）" },
      { x: 10.5, z: -2.5, lookAt: [0, 0], expect: "任意（远场）" },
    ];
    out("── 泛化验证（新位置读出概念）──");
    for (const s of spots) {
      bot.chat(`/tp @s ${s.x} ${Y} ${s.z}`);
      await sleep(400);
      await lookAtBlock(s.lookAt[0], Y, s.lookAt[1]);
      await sleep(300);
      const frame = observe();
      const resolved = em.resolveFrame(frame);
      const active = enc.encode(frame);
      const matched = concepts
        .map((c) => ({ c, overlap: c.memberNeuronIds.filter((n) => active.includes(n)).length }))
        .filter((m) => m.overlap >= Math.max(2, Math.ceil(m.c.memberNeuronIds.length * 0.5)))
        .sort((a, b) => b.overlap - a.overlap);
      const labels = matched.slice(0, 4).map((m) => labelMap.get(m.c.conceptId) ?? `概念#${m.c.conceptId}`);
      out(`  (${s.x},${s.z}) 面向(${s.lookAt}) → 期望：${s.expect}；读出：${labels.length ? labels.join("、") : "（无概念激活）"}`);
    }
  }

  // ── 状态面板 ────────────────────────────────────────────
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    const lines = [`概念层状态：已采 ${frameCount} 帧，自形成概念 ${concepts.length} 个`];
    for (const c of concepts) {
      lines.push(`  概念#${c.conceptId} [${labelMap.get(c.conceptId) ?? "未标注"}] 维度=${c.dimension} 中心=${c.centerValue.toFixed(2)} 成员=${c.memberNeuronIds.length} 内强度=${c.meanInternalWeight.toFixed(3)}`);
    }
    if (lastFrame) lines.push("", `最近一帧：${JSON.stringify(lastFrame)}`, `最近读出：${JSON.stringify(lastResolved)}`);
    res.end(lines.join("\n"));
  });

  bot.once("spawn", async () => {
    bot.chat("/gamemode spectator @s"); // 观察者：不干扰 ProtoAgent 的世界
    viewer(bot, { port: 3012, firstPerson: true, viewDistance: 6 });
    server.listen(3011);
    out("[系统] 概念层面板：http://localhost:3011 ｜ ConceptBot 视角：http://localhost:3012");
    await sleep(1500);

    // 采样目标点：对象旁边（保证对象帧频率）+ 随机位置（覆盖背景）
    const objectSpots = [
      { x: 3, z: 0, r: 2.5, name: "墙" }, { x: 6, z: 0, r: 2.5, name: "金垫" }, { x: 0, z: 0, r: 2.5, name: "箱源" },
    ];
    let rngState = 777;
    const rng = () => { rngState = (rngState * 1664525 + 1013904223) >>> 0; return rngState / 4294967296; };

    for (;;) {
      // 采样位置：70% 对象旁精确瞄准对象中心，30% 随机游走
      if (rng() < 0.7) {
        const t = objectSpots[Math.floor(rng() * objectSpots.length)];
        const ax = t.x + (rng() - 0.5) * 2 * t.r, az = t.z + (rng() - 0.5) * 2 * t.r;
        bot.chat(`/tp @s ${ax.toFixed(1)} ${Y} ${az.toFixed(1)}`);
        await sleep(350);
        await lookAtBlock(t.x, Y, t.z); // 瞄准对象基底中心（墙/垫在 y=5，箱源柱跨 5-6）
      } else {
        bot.chat(`/tp @s ${(-3 + rng() * 12).toFixed(1)} ${Y} ${(-3 + rng() * 8).toFixed(1)}`);
        await sleep(350);
        await bot.look(rng() * Math.PI * 2 - Math.PI, rng() * 0.5, true).catch(() => {}); // 只俯视不上扬
      }
      await sleep(250);
      const frame = observe();
      formation.presentExperiment(frame, 4);
      frameCount++;
      lastFrame = frame;
      if (em) lastResolved = em.resolveFrame(frame);
      if (frameCount % 50 === 0) {
        refreshConcepts();
        out(`[概念] ${frameCount} 帧，${concepts.length} 个概念`);
      }
      if (frameCount % 300 === 0) await generalizationTest();
    }
  });
  bot.once("error", (e) => { console.error("bot error:", e.message); process.exit(1); });
}

main().catch((e) => { console.error(e); process.exit(1); });

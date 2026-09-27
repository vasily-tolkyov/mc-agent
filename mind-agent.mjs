/**
 * mind-agent：多层模拟神经网络核心（energy-network-sim）驱动 mc-agent——连续流架构。
 *
 * 不分阶段、互不停止：
 *   - 概念学习永不停止（每个真实感知帧都喂共现成阱）；
 *   - 规则学习永不停止（每个动作写 R1 情节（只记变化结果维）→ R2A 分组 → R2B 差分成因素规则）；
 *   - 目标模式随时可进（R3 因素规则网反查规划链 + 缺规则前沿探索；RULES_ENGINE=legacy 可切回样本登记做 A/B）；
 *   - 概念索引稳定：稳定注册表只追加不洗牌（成员重叠 ≥0.5 继承索引），规则记忆不漂；
 *   - 状态空间固定：每维 cap+1 档（含未知档），TransitionMemory 启动即建；
 *   - 视觉流（mind/retina.mjs）：8×8 体素视网膜 → 独立概念网络成井 → viewWell 维进主层；
 *   - 空间流：掉落物实体进感知帧（itemDist/itemType/itemBearing——"走过去能捡到"可学可规划）；
 *   - 无目标空转时主动控制变量实验（mind/experiments.mjs）：对"全历史从未变化"的存疑因素维
 *     做干预（变体状态下走 step() 喂 R1），排除/确认判决交给 R2B 重差分，调度器只设计与记账。
 *
 * 教师期（CURRICULUM 巡回）：教师用 pathfinder 带 bot 逐个标本巡回（导航是教师的本事，
 * 不记为学习者转移），到位后 bot 用自己的原始动作看/挖/记——被动规则学习。
 * 教师期结束 → 自主探索（随机前向偏置），概念与规则继续双轨增长。
 *
 * 具身无作弊（无传送/无物品/无填方块/无创造指令）。观看：26.3 客户端 127.0.0.1:25568。
 * 状态 http://127.0.0.1:3008/status ；概念面板 http://127.0.0.1:3008/concepts ；
 * 目标 POST /goal {"<dim>":{"gte|lte|eq":v} 或 {"name":"oak_log"}}。
 * 事件流落盘 runs/mind-episodes.jsonl（回放可重建）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createBody, ACTION_NAMES } from './mind/body.mjs';
import { sensoryFrame, SENSORY_DIMS, DIM_NAMES, BLOCK_IDS, raycastForward } from './mind/sensory.mjs';
import { RetinaStream, retinaGrid } from './mind/retina.mjs';
import { EpisodeBuffer } from './mind/r1-episodes.mjs';
import { DifferentialExtractor } from './mind/r2-diff.mjs';
import { FactorRuleNet, setR3NetClass } from './mind/r3-rules.mjs';
import { planBackward } from './mind/plan-back.mjs';
import { ExperimentScheduler } from './mind/experiments.mjs';
import { SpikingEnergyNetwork } from './mind/spiking-network.mjs';
import { CompassRing, PathIntegrator, bearingSector } from './mind/space.mjs';

/** 网络基质：'binary'（默认二值 EnergyNetwork）|'spiking'（脉冲载体，语义逐位等价——
 * 对拍证据：verify-spiking-equiv / anneal / structures.mjs）。脉冲化后全部上层结构
 * （概念形成/视网膜/R3/反查规划）原样复用，无任何工程近似。 */
const NET_SUBSTRATE = process.env.NET_SUBSTRATE ?? 'binary';
const NetClass = NET_SUBSTRATE === 'spiking' ? SpikingEnergyNetwork : null;
if (NetClass) setR3NetClass(NetClass);

const ENS = 'D:/kimi_kairos/energy-network-sim';
const imp = (p) => import(pathToFileURL(`${ENS}/${p}`).href);
const { SensoryEncoder } = await imp('dist/src/pop/concept/sensory.js');
const { ConceptFormation } = await imp('dist/src/pop/concept/formation.js');
const { TransitionMemory } = await imp('dist/src/planning/transition-memory.js');
const { planGoalAsync } = await imp('dist/src/planning/planner.js');
const { executeGoal } = await imp('dist/src/planning/execute.js');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
const RUNS = path.join(ROOT, 'runs');
fs.mkdirSync(RUNS, { recursive: true });
const LOG = path.join(RUNS, 'mind.log');
const EPISODES = path.join(RUNS, 'mind-episodes.jsonl');
fs.writeFileSync(LOG, '');
const out = (s) => { console.log(s); fs.appendFileSync(LOG, s + '\n'); };

const ID_NAMES = Object.fromEntries(Object.entries(BLOCK_IDS).map(([k, v]) => [v, k]));
const DIAMETER = 14;

/** 每维概念容量上限（+1 未知档）：类型维=方块字母表，连续维=8 个区，viewWell=13 视觉井槽+未识别 */
const CONCEPT_CAPS = { nearDist: 8, nearType: 13, belowType: 13, grip: 8, logGrip: 8, speed: 8, onGround: 2, viewWell: 14, itemDist: 9, itemType: 13, itemBearing: 9, goalBearing: 9, goalDist: 9 };

/** 教师程序：概念中心值 → 语义标签（设计第 8 条的教师路径；自命名待文字流接入） */
function labelOf(dim, center) {
  const v = Math.round(center);
  if (dim === 'nearType') return `面前是${ID_NAMES[v] ?? '其他'}`;
  if (dim === 'belowType') return `脚下是${ID_NAMES[v] ?? '其他'}`;
  if (dim === 'itemType') return `掉落物是${ID_NAMES[v] ?? '其他'}`;
  if (dim === 'nearDist') return center < 1.5 ? '贴脸' : center < 3 ? '近处' : center < 5.5 ? '中距' : '远眺';
  if (dim === 'itemDist') return center < 1.5 ? '贴脸' : center < 3 ? '近处' : center < 5.5 ? '中距' : '远眺';
  if (dim === 'itemBearing') { // bin 0..8 = 扇区 -4..4：bin4=正前，α>0 向右，α<0 向左；0=正中（无掉落物/贴脚默认档）
    const BEARING = ['正中', '后左', '左侧', '前左', '正前', '前右', '右侧', '后右', '正后'];
    return BEARING[Math.min(8, Math.max(0, v))];
  }
  if (dim === 'goalBearing') {
    const BEARING = ['无目标', '后左', '左侧', '前左', '正前', '前右', '右侧', '后右', '正后'];
    return v <= 0 ? '无目标' : `目标${BEARING[Math.min(8, v)]}`;
  }
  if (dim === 'goalDist') return center >= 7.5 ? '目标远/无' : center < 1.5 ? '目标贴脸' : center < 3 ? '目标近处' : center < 5.5 ? '目标中距' : '目标远处';
  if (dim === 'grip' || dim === 'logGrip') return center < 0.5 ? '空手' : `持有≈${Math.max(1, v)}件`;
  if (dim === 'onGround') return center < 0.5 ? '空中' : '着地';
  if (dim === 'viewWell') { // 视网膜井槽位 → 教师标签（有的话）
    const i = Math.round(center);
    if (i >= 13) return '视野未识别';
    const label = retina?.stable[i]?.label;
    return label ? `视野:${label}` : `视野井#${i}`;
  }
  if (dim === 'speed') return center < 0.05 ? '静止' : center < 0.15 ? '慢行' : '快动';
  return `${dim}≈${center.toFixed(2)}`;
}

/** R3 周期重建：R1 裸值经当前概念透镜回填重读 → R2 全量重差分 → 网络物化。
 * 概念是后置形成的：旧情节当时解析成未知档，只有回填才能让早期的拾取/挖掘
 * 转移在概念成形后显出真值（课程期 L3 无链的真根因）。 */
function rebuildR3() {
  r2.reset();
  const centerOf = (d, raw) => {
    const idx = registry.resolve(d, raw);
    return idx == null ? CONCEPT_CAPS[d] + 0.5 : registry.concept(d, idx).centerValue; // 中心值化（大修地基）：规则存含义不存编号
  };
  for (const ep of r1.recent()) {
    if (!ep.rawConditions) continue; // 无裸值的历史段（兼容）跳过
    const cond = {}, chg = {};
    for (const d of DIM_NAMES) {
      cond[d] = centerOf(d, ep.rawConditions[d]);
      const nextRaw = ep.rawNext?.[d] ?? ep.rawConditions[d];
      if (nextRaw !== ep.rawConditions[d]) chg[d] = centerOf(d, nextRaw); // 变化判定按裸值相等（索引漂移不再断链）
    }
    r2.ingest({ conditions: cond, act: ep.act, outcomes: chg, tick: ep.tick });
  }
  const altValues = new Map();
  for (const ep of r1.recent(1500)) {
    if (!ep.rawConditions) continue;
    for (const [d, v] of Object.entries(ep.rawConditions)) {
      if (!altValues.has(d)) altValues.set(d, new Set());
      altValues.get(d).add(centerOf(d, v)); // 否决源也用中心值
    }
  }
  // 罕见但关键的单次观察规则（support=1）也放行：计票制管的是"改判"，不是"存在"
  r3.rebuild(r2.allRules().filter((r) => Object.keys(r.outcomes).length > 0 && r.support >= 1), altValues);
  st.rules = ENGINE === 'r123' ? r3.rules.length : mem.mem.ruleCount;
  if (process.env.CURRIC_DEBUG === '1') {
    const lg = r3.rules.filter((r) => r.outcomes.logGrip !== undefined);
    const lgEps = r1.recent().filter((e) => e.rawNext && e.rawNext.logGrip !== e.rawConditions.logGrip);
    out(`[R3调试] logGrip 结果规则 ${lg.length}，裸值变化情节 ${lgEps.length}，样例 ${lgEps.slice(0, 3).map((e) => `raw ${e.rawConditions.logGrip}→${e.rawNext.logGrip} 中心 ${centerOf('logGrip', e.rawConditions.logGrip).toFixed(2)}→${centerOf('logGrip', e.rawNext.logGrip).toFixed(2)}`)}`);
  }
}

/** 稳定概念注册表：新概念按出现顺序追加，旧索引永不变（成员重叠 ≥0.5 继承索引）。
 * EmergentMap 每次提取按中心值排序会重排索引——规则记忆按索引存储，重排即毁。 */
class StableConceptRegistry {
  constructor(encoder, caps) {
    this.encoder = encoder;
    this.caps = caps;
    this.byDim = new Map(Object.keys(caps).map((d) => [d, []]));
  }
  refresh(concepts) {
    for (const c of concepts) {
      const arr = this.byDim.get(c.dimension);
      if (!arr) continue;
      let best = -1, bestIou = 0;
      for (const [i, old] of arr.entries()) {
        const oldSet = new Set(old.memberNeuronIds);
        let inter = 0;
        for (const id of c.memberNeuronIds) if (oldSet.has(id)) inter++;
        const iou = inter / (oldSet.size + c.memberNeuronIds.length - inter);
        if (iou > bestIou) { bestIou = iou; best = i; }
      }
      if (bestIou >= 0.5 && best >= 0) arr[best] = { ...c, stableIndex: best };
      else if (arr.length < this.caps[c.dimension]) arr.push({ ...c, stableIndex: arr.length });
      // 溢出不进注册表——如实落未知档，不硬并
    }
  }
  resolve(dim, value) {
    const arr = this.byDim.get(dim) ?? [];
    const activated = new Set(this.encoder.encodeDimension(dim, value));
    let bestIdx = -1, bestOverlap = 0, tie = false;
    for (const [i, c] of arr.entries()) {
      const overlap = c.memberNeuronIds.filter((id) => activated.has(id)).length;
      if (overlap > bestOverlap) { bestIdx = i; bestOverlap = overlap; tie = false; }
      else if (overlap === bestOverlap && overlap > 0) tie = true;
    }
    if (bestOverlap < 2 || tie) return null;
    return bestIdx;
  }
  count(dim) { return this.byDim.get(dim)?.length ?? 0; }
  concept(dim, i) { return this.byDim.get(dim)?.[i]; }
  all() { return [...this.byDim.values()].flat(); }
}

// ── 全局状态 ─────────────────────────────────────────────
const st = {
  phase: 'connecting', frames: 0, decisions: 0, writes: 0,
  concepts: 0, rules: 0, lastFrame: null, lastCState: null, lastDecision: null,
  goal: null, goalReport: null, paused: false, teacher: true,
};

let body, enc, formation, registry, mem, retina, r1, r2, r3, ring, pInt, ringYawOffset, experiments = null, rngState = 20260924;
/** 规则引擎：'r123'（默认，R1 经验→R2 差分→R3 因素规则+反向链接）|'legacy'（样本登记 A/B 对照） */
const ENGINE = process.env.RULES_ENGINE ?? 'r123';
const rng = () => { rngState = (rngState * 1664525 + 1013904223) >>> 0; return rngState / 4294967296; };
const actionObs = {};
const actionAffects = new Map();
/** 地标记忆：概念被认出的位置（"原木曾出没于此"）——空间记忆是回家/回访的基础。
 * key `${dim}:${conceptIdx}` → {x, z}（该概念最近一次被认出时 bot 的位置）。 */
const landmarks = new Map();

// 概念空间（固定档，启动即建）
const CONCEPT_SPACE = {
  states: DIM_NAMES.map((name) => ({ name, outcome: 'next' + name[0].toUpperCase() + name.slice(1), bins: CONCEPT_CAPS[name] + 1 })),
  actions: [{ name: 'act', bins: ACTION_NAMES.length }],
  diameter: DIAMETER,
};

function resolveFrame(frame) {
  const out = {};
  for (const d of DIM_NAMES) out[d] = registry.resolve(d, frame[d]) ?? CONCEPT_CAPS[d]; // 未知档
  return out;
}
/** 中心值语义（大修地基）：raw → 概念**中心值**（含义），未知 → caps+0.5（范围外标记）。
 * 规则/规划全程用中心值：索引随概念形成顺序漂移，中心值是物理意义本身。 */
function resolveFrameCenter(frame) {
  const out = {};
  for (const d of DIM_NAMES) {
    const idx = registry.resolve(d, frame[d]);
    out[d] = idx == null ? CONCEPT_CAPS[d] + 0.5 : registry.concept(d, idx).centerValue;
  }
  return out;
}
function outcomesOf(cNext) {
  return Object.fromEntries(CONCEPT_SPACE.states.map((d) => [d.outcome, cNext[d.name]]));
}
function actionOf(index) { return mem.actions.find((a) => a.values.act === index); }

function cStateReadable(cState) {
  const out_ = {};
  for (const d of DIM_NAMES) {
    const idx = cState[d];
    if (idx && typeof idx === 'object' && 'min' in idx) { out_[d] = `∈[${idx.min.toFixed(1)},${idx.max.toFixed(1)}]`; continue; } // 区间目标
    if (typeof idx === 'number' && (!Number.isInteger(idx) || idx > CONCEPT_CAPS[d])) { out_[d] = labelOf(d, idx); continue; } // 中心值态直接翻译
    out_[d] = idx === CONCEPT_CAPS[d] ? '未知' : (registry.concept(d, idx) ? labelOf(d, registry.concept(d, idx).centerValue) : `概念#${idx}`);
  }
  return out_;
}

// ── 教师课程（巡回标本；导航是教师的本事，不记为学习者转移）──
const SKIP_PICKUP = process.env.LEVEL4 === '1'; // L4 验收：教师故意不教拾取（缺失规则留给原型自己探索）
const CURRICULUM = [ // 教师真值命名进课程表（消灭"射线猜标签"：贴地瞄准擦草误贴 看-grass_block 的教训）
  { x: -9, z: 0, name: 'stone' }, { x: 3, z: -11, name: 'dirt' }, { x: 9, z: 0, name: 'sand' },
  { x: 0, z: 9, name: 'gravel' }, { x: 13, z: 5, name: 'water' }, { x: 0.5, z: -10, name: 'oak_log' },
  { x: -12, z: 6, name: 'oak_planks' }, { x: 4, z: 12, name: 'gold_block' }, { x: -4, z: 12, name: 'emerald_block' },
  { x: 16.5, z: -14, name: 'oak_log' }, { x: -16.5, z: 14, name: 'oak_log' }, // 加密的原木点（资源加密）
];
/** 教师视觉课：环绕标本 4 个视角注视（背景随视角变、标本不变——变的洗淡，不变的成井），
 * 然后用面前射线命中的真实方块名给落进的井赋标签（设计第 8 条教师路径）。 */
async function orbitLearn(target, label) {
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + 0.4;
    await body.goto(target.x + 3.4 * Math.cos(a), target.z + 3.4 * Math.sin(a), 0.8);
    await body.lookAt(target.x, -59.5, target.z);
    for (let r = 0; r < 3; r++) retina.observe(retinaGrid(body.bot));
  }
  retina.refreshWells();
  const tagged = retina.labelCurrent(retinaGrid(body.bot), label);
  out(`[视觉课] ${label} → ${tagged ? `井#${tagged.stableIndex}（成员 ${tagged.members}，能量 ${tagged.energy.toFixed(1)}）` : '未落井（继续攒视角）'}`);
}

/** 拾取课：教师导航到掉落物跟前（goto 是教师的本事，不记转移），最后一步用学习者
 * 原语动作完成吸入——"接近→grip+1"这条转移必须以学习者动作记入规则（L3 技能链的关键环）。
 * 教训：盲步逼近不可靠（行走/视线 yaw 约定 z 镜像 + 800ms 步长冲过拾取半径），
 * 实体导航交给教师，规则学习留给原型。 */
async function collectLesson() {
  const gripBefore = st.lastFrame?.grip ?? 0, logBefore = st.lastFrame?.logGrip ?? 0;
  const pickedUp = () => (st.lastFrame?.grip ?? 0) > gripBefore || (st.lastFrame?.logGrip ?? 0) > logBefore;
  const nearestItem = () => {
    const p = body.bot.entity.position;
    return Object.values(body.bot.entities).filter((e) => e.displayName === 'Item' && e.position.distanceTo(p) < 8)
      .sort((a, b) => a.position.distanceTo(p) - b.position.distanceTo(p))[0] ?? null;
  };
  // 第一步：原地记录步盲捞（不轮询不导航——轮询等待期 bot 就站在吸入半径上，
  // 会把拾取偷藏进不可见的等待里——规则永远缺货的真根因）；每轮带一次转向，
  // 弹飞到哪个方向的掉落物都会被扫到（拾取物理的最后一层补丁）
  for (let k = 0; k < 3 && !pickedUp(); k++) {
    await step(9); // 俯身（记转移）
    await step(0); // 前开（记转移）
    await step(1); // 'back' 朝视线方向（记转移）
    await step(2); // 换方向再扫（记转移）
  }
  if (pickedUp()) {
    const p = body.bot.entity.position;
    landmarks.set(`produce:${st.lastCState?.nearType ?? 0}`, { x: p.x, z: p.z });
    return;
  }
  // 第二步：轮询等待实体可见（只有盲捞失败才走到这里），掉落物实体跟踪有延迟
  let it = null;
  for (let w = 0; w < 4 && !it; w++) {
    await new Promise((r) => setTimeout(r, 500));
    const p = body.bot.entity.position;
    const items = Object.values(body.bot.entities).filter((e) => e.displayName === 'Item' && e.position.distanceTo(p) < 8);
    it = items.sort((a, b) => a.position.distanceTo(p) - b.position.distanceTo(p))[0] ?? null;
  }
  if (!it) { if (process.env.CURRIC_DEBUG === '1') out('[拾取课] 轮询后仍无掉落物实体'); return; }
  if (process.env.CURRIC_DEBUG === '1') out(`[拾取课] 目标掉落物 ${it.position.toString()}（距 ${it.position.distanceTo(body.bot.entity.position).toFixed(2)}m）`);
  // 掉落物就在脚边（≤1.8m）：不做任何 goto（导航先走进 1.2m 吸入半径，把拾取偷藏进
  // 不可见的航行里——规则永远缺货的真根因），直接原地记录步捞，让吸入发生在 step 内部
  const nearFoot = nearestItem();
  if (nearFoot && nearFoot.position.distanceTo(body.bot.entity.position) <= 1.8) {
    for (let k = 0; k < 4; k++) {
      await body.lookAt(nearFoot.position.x, nearFoot.position.y, nearFoot.position.z);
      await step(9); // 俯身对坑
      await step(0); // 前开跌入（记转移）
      if (pickedUp()) { landmarks.set(`produce:${st.lastCState?.nearType ?? 0}`, { x: body.bot.entity.position.x, z: body.bot.entity.position.z }); return; }
      await step(1); // 'back' 朝视线方向（记转移）
      if (pickedUp()) { landmarks.set(`produce:${st.lastCState?.nearType ?? 0}`, { x: body.bot.entity.position.x, z: body.bot.entity.position.z }); return; }
    }
  }
  await body.goto(it.position.x, it.position.z, 4.0); // 长途教师导航（不记转移）
  // 学习者原语逼近 ×2（'back' 朝视线方向）——"朝掉落物走→itemDist 减小"的规则素材
  for (let k = 0; k < 2; k++) {
    const near = nearestItem();
    if (!near) break;
    await body.lookAt(near.position.x, near.position.y, near.position.z);
    await step(1);
    if (pickedUp()) { landmarks.set(`produce:${st.lastCState?.nearType ?? 0}`, { x: body.bot.entity.position.x, z: body.bot.entity.position.z }); return; }
  }
  // 保险分两段：先停在拾取半径外（1.8m），再用记转移的逼近步穿过半径——
  // 让"吸入"发生在 step 内部，否则拾取永远藏在 goto 里、规则永远缺货（上轮根因）
  for (let k = 0; k < 3; k++) {
    const near = nearestItem();
    if (!near) break;
    await body.goto(near.position.x, near.position.z, 1.5); // 压到坑沿
    await body.lookAt(near.position.x, near.position.y, near.position.z);
    await step(9); // 俯身对坑
    await step(0); // 前开跌进坑：掉落物在 1 米深坑里时平走掠过坑沿垂直距 1.7 吸不到（记录步抓不到拾取的真根因）
    if (pickedUp()) { landmarks.set(`produce:${st.lastCState?.nearType ?? 0}`, { x: body.bot.entity.position.x, z: body.bot.entity.position.z }); return; }
  }
  // 兜底（放弃规则素材，保拾取）：直接压点
  const near0 = nearestItem();
  if (near0) {
    await body.goto(near0.position.x, near0.position.z, 0.5);
    await step(0);
    if (pickedUp()) { landmarks.set(`produce:${st.lastCState?.nearType ?? 0}`, { x: body.bot.entity.position.x, z: body.bot.entity.position.z }); return; }
  }
  // 还没捡到：再挖一块柱体并重试记录步（拾取规则入档率是 L3 命门——多轮死在它缺席）
  const stillThere = nearestItem();
  if (stillThere && !pickedUp()) {
    await step(5);
    for (let k = 0; k < 3; k++) {
      const near = nearestItem();
      if (!near) break;
      await body.goto(near.position.x, near.position.z, 1.5);
      await body.lookAt(near.position.x, near.position.y, near.position.z);
      await step(9);
      await step(0);
      if (pickedUp()) { landmarks.set(`produce:${st.lastCState?.nearType ?? 0}`, { x: body.bot.entity.position.x, z: body.bot.entity.position.z }); return; }
    }
  }
}

/** 阻塞式巡回：完整走完课程才返回（goto 在 loop 内不被打断）；
 * 学习者的看/挖原语动作仍走 step()（记转移、学概念）。 */
async function runCurriculum() {
  // 视网膜校准期：原地环顾+俯仰 20 帧攒环境基线统计（校准期不供能不成阱——先睁眼，再上学）
  for (let k = 0; k < 20; k++) {
    const a = (k / 10) * Math.PI * 2;
    await body.lookAt(Math.cos(a) * 10, k % 10 < 5 ? -60.5 : (k < 10 ? -59.5 : -55), Math.sin(a) * 10);
    retina.observe(retinaGrid(body.bot));
  }
  out(`[视觉课] 视网膜校准完成（${retina.observations} 帧，${retina.frameCount} 个文档）`);
  for (const [i, target] of CURRICULUM.entries()) {
    if (i < (parseInt(process.env.LEVELS_START_AT ?? '0') || 0)) continue; // 调试跳段（默认 0 不跳）
    const t0 = performance.now();
    await body.lookAt(target.x, -59.5, target.z);
    await body.goto(target.x, target.z, 2.2); // 教师带路（真实寻路，不记转移）
    // 视觉课先行（趁标本完整）：环绕注视成井 + 教师赋标签（课程表真值命名）
    await orbitLearn(target, `看-${target.name}`);
    // 到位后：学习者原语动作（记转移、学概念）。先贴脸（1.0m）再挖——掉落物在零距离
    // 垂直同层处弹出，0.5s 拾取延迟内自动吸入，"挖→吸入"就记录在 dig 的 step 里
    // （此前 2.2m 外挖再追：坑内垂直 1.7m 吸不到，拾取规则永远要靠运气入档——L3 总根因）
    const pillarish = target.name.includes('log') || target.name.includes('planks');
    if (pillarish) await body.goto(target.x, target.z, 0.4); // 贴到标本脚下（掉落物弹出点全在 1.2m 吸入圈内）
    await body.lookAt(target.x, pillarish ? -58.5 : -59.4, target.z);
    if (process.env.CURRIC_DEBUG === '1') {
      const h = raycastForward(body.bot, 4);
      out(`[电池] dig 命中: ${h ? `${h.block.name}@${h.block.position.toString()} d=${h.dist.toFixed(2)}` : 'null'}`);
    }
    await step(5); // 挖（对准标本）
    if (!SKIP_PICKUP) await collectLesson(); // 拾取课（L4 故意不教：缺失规则留给原型自探）
    if (pillarish && !SKIP_PICKUP) { // 柱状标本挖 3 次：拾取规则要重复次数（计票制本意）；
      // 两根柱体加顶块轮流挖——挖同一坑位只会挖到草（实测根因）
      await body.lookAt(target.x + 1, -58.5, target.z);
      await step(5);
      await collectLesson();
      await body.lookAt(target.x, -57.5, target.z); // 顶块
      await step(5);
      await collectLesson();
    }
    if (process.env.CURRIC_DEBUG === '1') out(`[电池] 拾取课后 grip=${st.lastFrame?.grip} logGrip=${st.lastFrame?.logGrip}`);
    await step(9); // 俯身对地
    await step(6); // 放一次（学放置：手里有挖下来的方块）
    await step(6); // 再放一次
    await step(8); // 看远
    if (i % 2 === 0) { await step(2); await step(3); await step(4); await step(1); await step(7); } // 转向/跳/后退/换槽全动作覆盖
    out(`[课程] 标本 ${i + 1}/${CURRICULUM.length} (${target.x},${target.z}) 完成，耗时 ${((performance.now() - t0) / 1000).toFixed(0)}s，规则 ${st.rules}`);
  }
  st.teacher = false;
  out('[系统] 教师课程结束，转自主探索（概念/规则继续双轨学习）');
}

function exploreAction() {
  const r = rng();
  if (r < 0.40) return 0;
  if (r < 0.50) return 2;
  if (r < 0.60) return 3;
  if (r < 0.70) return 5;
  if (r < 0.76) return 6;
  if (r < 0.82) return 4;
  if (r < 0.88) return 9;
  if (r < 0.94) return 8;
  if (r < 0.97) return 1;
  return 7;
}

/** 目标前沿动作（自适应神经化偏好）：
 * 打分 = R3 匹配规则预测的目标维推进（直达 > 变化）+ 共变关联维变化（从 R1 情节学的
 * "哪些维常和目标维一起动"）+ 原有统计通道（actionAffects）+ 欠探索奖励。
 * 规则库更新 → 匹配结果更新 → 偏好自动更新——偏好是从经验长出来的，不是手工写死。 */
function coChange(d, g) { // d 在 g 变化的情节里也变化的比例（R1 情节统计，0 样本=0）
  let both = 0, tot = 0;
  for (const ep of r1.recent(1500)) {
    if (ep.outcomes[g] !== undefined) { tot++; if (ep.outcomes[d] !== undefined) both++; }
  }
  return tot ? both / tot : 0;
}
function frontierAction(goalDims, goalTargets = null) {
  let bestIdx = 0, bestScore = -Infinity;
  for (let idx = 0; idx < ACTION_NAMES.length; idx++) {
    let score = rng() * 0.5;
    if (ENGINE === 'r123' && r3.rules.length && st.lastCenterState) {
      const ms = r3.matchRules(st.lastCenterState, idx); // 轻量近似匹配（不退火；中心值态）
      if (ms.length) {
        const out = ms[0].rule.outcomes;
        for (const d of goalDims) {
          if (out[d] === undefined) continue;
          const t = goalTargets?.[d];
          if (t !== undefined && (Array.isArray(t) ? t.includes(out[d]) : out[d] === t)) score += 3;
          else score += 0.5;
        }
        for (const d of Object.keys(out)) {
          for (const g of goalDims) if (d !== g && coChange(d, g) > 0.3) score += 1.2;
        }
      }
    }
    for (const d of goalDims) if (actionAffects.has(`${idx}:${d}`)) score += 2;
    score += 1 / (1 + (actionObs[idx] ?? 0));
    if (score > bestScore) { bestScore = score; bestIdx = idx; }
  }
  return bestIdx;
}

/** 抢占注意力（果蝇式 onset 显著性）：掉落物突然出现 = 刺激驱动注意捕获。
 * 掉落物进视野 → 抢占当前注意力 → 它自然成为新目标（自适应长出，非手工偏好）。
 * 抢占窗内主循环把"接近掉落物"作为微目标（规则打分驱动）；窗口过期或吸入了就释放。 */
function updateAttentionCapture() {
  const cur = st.lastFrame;
  const prevDist = st._prevItemDist ?? 8;
  const curDist = cur?.itemDist ?? 8;
  // itemDist 从 8（无）跳到 <8（有）= 突然出现
  if (prevDist >= 8 && curDist < 8) {
    const item = Object.values(body.bot.entities).filter((e) => e.displayName === 'Item' && e.position.distanceTo(body.bot.entity.position) < 8)
      .sort((a, b) => a.position.distanceTo(body.bot.entity.position) - b.position.distanceTo(body.bot.entity.position))[0];
    st.attentionCapture = { until: st.decisions + 12 };
    if (item) landmarks.set('item:capture', { x: item.position.x, z: item.position.z }); // 空间层跟踪它
    out(`[注意力] 掉落物出现（itemDist=${curDist}）→ 抢占注意力，微目标：接近它（${st.decisions}+12 步内有效）`);
  }
  // 掉落物消失（被吸/消失）→ 提前释放抢占
  if (st.attentionCapture && curDist >= 8) st.attentionCapture = null;
  st._prevItemDist = curDist;
}
function perceive() {
  const frame = sensoryFrame(body.bot);
  const grid = retinaGrid(body.bot);
  retina.observe(grid);
  const { value, recognition } = retina.viewWellValue(grid);
  frame.viewWell = value;
  st.lastRecognition = { label: recognition.label, ratio: +recognition.ratio.toFixed(3), energy: +recognition.energy.toFixed(1), ms: +recognition.ms.toFixed(1) };
  // 空间维（果蝇中央复合体基序）：罗盘环航向 + 路径积分 → 目标地标方位/距离
  Object.assign(frame, spatialFields());
  return frame;
}

/** 空间层初始化：罗盘环点燃 + 路径积分归零 + 环位与 bot yaw 对齐 */
function initSpatial() {
  ring = new CompassRing({});
  ring.ignite(0);
  pInt = new PathIntegrator();
  ringYawOffset = body.bot.entity.yaw; // 环位 0 = 角度 0，偏移 = 初始 yaw
}
/** 当前航向（罗盘环读出——环是真变量，不是装饰）：环位角 + 对齐偏移 */
function heading() { return ringYawOffset + (ring.position() / 64) * Math.PI * 2; }

/** 空间维：最近地标（按积分器估计）的相对方位扇区与距离档 */
function spatialFields() {
  if (!landmarks.size) return { goalBearing: 0, goalDist: 8 };
  let best = null, bestD = Infinity;
  for (const lm of landmarks.values()) {
    const d = Math.hypot(lm.x - pInt.x, lm.z - pInt.z);
    if (Number.isFinite(d) && d < bestD) { bestD = d; best = lm; }
  }
  if (!best || !Number.isFinite(pInt.x) || !Number.isFinite(pInt.z)) {
    if (!st._nanWarned) { st._nanWarned = true; out(`[空间] 检测到非有限积分/地标坐标（pInt=${pInt.x},${pInt.z}）——如实降级为无目标，待查`); }
    return { goalBearing: 0, goalDist: 8 };
  }
  const bd = pInt.bearingDist(best.x, best.z);
  const h = heading();
  const sector = bearingSector(bd.angle, h);
  if (!Number.isFinite(sector) || !Number.isFinite(bd.dist)) {
    if (!st._nanWarned2) { st._nanWarned2 = true; out(`[空间] 方位计算非有限（bd.angle=${bd.angle}, heading=${h}, ringPos=${ring.position()}）——如实降级，待查`); }
    return { goalBearing: 0, goalDist: 8 };
  }
  return { goalBearing: sector, goalDist: Math.min(8, Math.round(bd.dist)) };
}

/** 单个决策步：感知帧喂概念 → 概念态 → 动作 → 真实后继 → 写规则 + 效果直方图。所有学习永不停止。 */
async function step(actIdx, { learn = true } = {}) {
  const frame = perceive();
  st.lastFrame = frame;
  formation.presentExperiment(frame, 4); // 概念学习永不停止
  const cState = resolveFrame(frame);
  const action = actionOf(actIdx);
  const yaw0 = body.bot.entity.yaw, pos0 = body.bot.entity.position.clone();
  await body.act(ACTION_NAMES[actIdx]);
  // 空间积分（果蝇自身运动积分）：真实转角进罗盘环，真实位移投影进路径积分器
  const yaw1 = body.bot.entity.yaw, pos1 = body.bot.entity.position;
  let dYaw = yaw1 - yaw0;
  while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
  while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
  if (Number.isFinite(dYaw)) ring.shift(dYaw);
  const h = heading();
  const dot = (pos1.x - pos0.x) * -Math.sin(h) + (pos1.z - pos0.z) * Math.cos(h);
  if (Number.isFinite(h) && Number.isFinite(dot)) pInt.forward(h, dot); // 非有限即跳过该步积分（防 NaN 污染积分器——上轮崩点）
  const next = perceive();
  // 地标重校准（果蝇消漂移机制）：认出已知视觉井且站在某地标 4m 内 → 积分器吸附回该点
  if (st.lastRecognition?.label && landmarks.size) {
    const p = body.bot.entity.position;
    for (const lm of landmarks.values()) {
      if (Math.hypot(lm.x - p.x, lm.z - p.z) < 4) { pInt.recalibrate(lm.x, lm.z); break; }
    }
  }
  st.lastFrame = next;
  formation.presentExperiment(next, 4); // 后继帧也学概念
  const cNext = resolveFrame(next);
  if (learn) {
    // R1 经验登记：结果只记实际变化的维；裸值帧一并存（概念后置形成，回填重读用——
    // R2/R3 在 rebuildR3 里从裸值全量重差分，这里不再增量 ingest）
    const changed = {};
    for (const d of DIM_NAMES) if (cNext[d] !== cState[d]) changed[d] = cNext[d];
    // 效价门控（果蝇多巴胺广播）：抢占窗内 / 背包变化 / 掉落物拉近 = 重要事件——
    // 单次顶多次（支持度加权 ×3 + 概念强写入一遍），规则单次成型不等重复
    const valence = (st.attentionCapture && st.decisions < st.attentionCapture.until)
      || cNext.grip !== cState.grip || cNext.logGrip !== cState.logGrip
      || (next.itemDist ?? 8) < (frame.itemDist ?? 8);
    r1.record(cState, actIdx, changed, frame, next, valence ? 3 : 1);
    if (valence) { formation.presentExperiment(next, 4); formation.presentExperiment(frame, 4); }
    if (ENGINE === 'legacy') mem.observe(cState, action, outcomesOf(cNext)); // A/B 对照才走样本登记
    actionObs[actIdx] = (actionObs[actIdx] ?? 0) + 1;
    for (const d of DIM_NAMES) if (cNext[d] !== cState[d]) {
      const key = `${actIdx}:${d}`;
      actionAffects.set(key, (actionAffects.get(key) ?? 0) + 1);
    }
    st.writes++;
    st.rules = ENGINE === 'r123' ? r3.rules.length : mem.mem.ruleCount;
  }
  st.decisions++;
  if (st.decisions % 50 === 0) { // 概念注册表/R3 随决策滚动刷新（课程期不刷=全未知档废料、L2 空心的真根因）
    registry.refresh(formation.extractConcepts(0.5));
    retina.refreshWells();
    rebuildR3();
    st.concepts = registry.all().length;
  }
  st.lastCState = cNext;
  st.lastCenterState = resolveFrameCenter(next); // 中心值态（大修地基：R3/规划全走这个）
  st.lastDecision = { action: ACTION_NAMES[actIdx], from: cState, to: cNext };
  updateAttentionCapture(); // 掉落物突然出现 → 抢占注意力（果蝇式 onset 显著性，自适应）
  // 地标记忆：记"产出发生地"（挖掘导致背包变化的位置 = 资源点），不是"概念被看见的地方"
  // （教训：看见村庄栅栏记成原木地标，回访挖栅栏一无所获）
  if (cNext.grip !== cState.grip || cNext.logGrip !== cState.logGrip) {
    const p = body.bot.entity.position;
    landmarks.set(`produce:${cState.nearType}`, { x: p.x, z: p.z });
  }
  if (st.decisions % 100 === 0) out(`[决策] ${st.decisions}，规则 ${st.rules}，概念 ${st.concepts}，写入 ${st.writes}，地标 ${landmarks.size}`);
  return cNext;
}

const embodiedBench = {
  async conduct(_state, action) { // 具身：不能传送设状态，只真实执行并读出真实后继
    await body.act(ACTION_NAMES[action.act]);
    const next = perceive();
    formation.presentExperiment(next, 4); // 执行帧也学概念
    return outcomesOf(resolveFrame(next));
  },
};

/** {dim:{gte|lte|eq:v} 或 {dim:{name:"oak_log"}} → 概念目标帧（只含目标维的**区间**）。
 * 区间语义是 gte/lte 的原生形态（gte:1 = [0.7, +∞)——中心值化后区间就是含义本身）。
 * eq/name → 单值中心。未知档（caps+0.5）恒不满足任何区间（不把"不知道"冒充"满足"）。 */
function resolveGoalSpec(spec) {
  const cur = st.lastCenterState ?? st.lastCState;
  if (!cur) throw new Error('尚无感知状态');
  const goal = {};
  for (const [dim, cond] of Object.entries(spec)) {
    if (!DIM_NAMES.includes(dim)) throw new Error('未知维度: ' + dim);
    if (cond.name !== undefined) {
      const count = registry.count(dim);
      let best = null;
      for (let i = 0; i < count; i++) {
        const c = registry.concept(dim, i).centerValue;
        const idName = ID_NAMES[Math.round(c)] ?? '';
        const label = labelOf(dim, c);
        const want = String(cond.name);
        if (idName === want || label.includes(want) || idName.includes(want)) { best = c; break; }
      }
      if (best === null) throw new Error(`维度 ${dim} 上还没有叫 ${cond.name} 的自形成概念（需先探索）`);
      goal[dim] = best;
      continue;
    }
    if (cond.gte !== undefined) goal[dim] = { min: cond.gte - 0.3, max: CONCEPT_CAPS[dim] + 0.4 };
    else if (cond.lte !== undefined) goal[dim] = { min: -0.5, max: cond.lte + 0.3 };
    else if (cond.eq !== undefined) goal[dim] = { min: cond.eq - 0.26, max: cond.eq + 0.26 };
    // 区间内有自形成概念才算可达（否则驱动前沿探索去形成——概念后置形成的兜底）
    const range = goal[dim];
    if (range && typeof range === 'object') {
      let any = false;
      for (let i = 0; i < registry.count(dim); i++) {
        const c = registry.concept(dim, i).centerValue;
        if (c >= range.min && c <= range.max) { any = true; break; }
      }
      if (!any) throw new Error(`维度 ${dim} 上还没有落入区间的自形成概念（需先探索）`);
    }
  }
  return goal;
}

/** 一轮目标前沿探索：地标回访（奇数轮，最近且 ≤40m）+ 40 个前沿决策（双引擎共用） */
async function frontierRound(goalDims, round, goalTargets = null) {
  if (landmarks.size && round % 2 === 1) {
    const p = body.bot.entity.position;
    const sorted = [...landmarks.values()].sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
    const lm = sorted[0];
    if (lm && Math.hypot(lm.x - p.x, lm.z - p.z) <= 40) {
      out(`[前沿] 回访产出地标 (${lm.x.toFixed(1)},${lm.z.toFixed(1)})，在产地环视挖掘`);
      await body.goto(lm.x, lm.z, 2.0);
      for (let s = 0; s < 4 && (st.lastFrame?.logGrip ?? 0) === 0; s++) {
        await body.lookAt(lm.x, -58.5, lm.z); // 柱状残余（挖剩的原木浮在空中）
        await step(5);
        if (!SKIP_PICKUP) await collectLesson();
        else { await step(0); await step(0); } // L4：只有原语动作，拾取靠自己撞上
        await step(2);
      }
    } else out('[前沿] 地标都在 40m 外，跳过回访');
  }
  for (let i = 0; i < 40; i++) await step(st.attentionCapture && st.decisions < st.attentionCapture.until
    ? frontierAction(['itemDist'], { itemDist: [0, 1] })  // 抢占窗内：微目标接近掉落物
    : frontierAction(goalDims, goalTargets));
}

/** 缺口→控制变量实验（通用机制，不是拾取特例）：
 * 规划链缺口 = 结果命中目标维但因素集过宽的规则（小簇规则把整帧都当因素）。
 * 对每个这样的规则，在 4 个变体情境下重放它的动作（转向/前进各变一个情境维，
 * 动作不变）——R2B 拿到反例后：该维变化而结果不变 → 该维非影响因素 → 从因素集剔除。
 * 这就是"主动做控制变量实验补全规则"：不是走过去捡东西（任务特例），
 * 而是对任何缺口的规则补证据（通用机制）。 */
async function probeOverSpecific(goalDims, maxRules = 3) {
  const gaps = r3.rules
    .filter((r) => goalDims.some((g) => r.outcomes[g] !== undefined) && Object.keys(r.factors).length >= 3)
    .sort((a, b) => b.support - a.support)
    .slice(0, maxRules);
  for (const rule of gaps) {
    const before = Object.keys(rule.factors).length;
    out(`[实验] 规则 ${ACTION_NAMES[rule.action]}→${JSON.stringify(rule.outcomes)}（${before} 因素）做控制变量探针：4 变体情境重放`);
    for (const ctx of [2, 3, 0, 1]) { // 左/右/前/后 各变一个情境维
      await step(ctx);
      await step(rule.action);
    }
  }
  return gaps.length;
}

/** r123 目标模式：反向链接规划（R3 因素规则）→ 逐节执行核对（捕获）→ 缺规则前沿探索 */
async function runGoalR123(spec) {
  const goalDims = Object.keys(spec).filter((d) => DIM_NAMES.includes(d));
  // 概念未形成 → 朝目标维前沿探索到形成为止（与 legacy 同一策略）
  let goal = null, waits = 0;
  while (!goal && waits < 15) {
    try { goal = resolveGoalSpec(spec); break; }
    catch (e) {
      if (waits === 0) out(`目标的概念尚未形成（${e.message}）——开始朝目标维主动探索`);
      st.phase = 'goal-frontier';
      const lmList = [...landmarks.values()];
      if (lmList.length) {
        const lm = lmList[Math.floor(rng() * lmList.length)];
        out(`[前沿] 回访地标 (${lm.x.toFixed(1)},${lm.z.toFixed(1)})`);
        await body.lookAt(lm.x, -59.5, lm.z);
        await body.goto(lm.x, lm.z, 2.0);
      }
      for (let i = 0; i < 40; i++) await step(frontierAction(goalDims));
      waits++;
    }
  }
  if (!goal) {
    st.goalReport = { error: '前沿探索后目标概念仍未形成', goalDims, frontierWaits: waits, engine: 'r123' };
    out(`目标结果：${JSON.stringify(st.goalReport)}`);
    st.goal = null; st.phase = 'running';
    return;
  }
  const targets = Object.fromEntries(goalDims.map((d) => [d, goal[d]]));
  out(`目标：${JSON.stringify(targets)}（可读 ${JSON.stringify(cStateReadable(goal))}）`);
  // 反查规划链：缺规则 → 前沿探索攒经验（R1/R2 持续 ingest），有界重试
  let chain = null, retries = 0;
  while (retries < 10) {
    rebuildR3(); // 规划前物化最新差分
    if (retries === 0) {
      out(`[R3] 规划时状态 logGrip 中心=${st.lastCenterState?.logGrip?.toFixed?.(2)}`);
      const changeRules = r3.rules.filter((r) => Object.keys(r.outcomes).length > 0);
      const lgRules = changeRules.filter((r) => r.outcomes.logGrip !== undefined);
      out(`[R3] 物化规则 ${r3.rules.length}（变化规则 ${changeRules.length}，logGrip 结果规则 ${lgRules.length}：${lgRules.slice(0, 3).map((r) => `${ACTION_NAMES[r.action]}→${JSON.stringify(r.outcomes)}`).join(' | ')}）：${changeRules.slice(0, 10).map((r) => `${ACTION_NAMES[r.action]}[${Object.entries(r.factors).map(([d, v]) => `${d}=${typeof v === 'number' ? v.toFixed(1) : v}`).join(',')}]→${JSON.stringify(r.outcomes)}(s${r.support})`).join(' | ')}${changeRules.length > 10 ? ' …' : ''}`);
    }
    chain = planBackward({ rules: r3.rules, current: st.lastCenterState, goalDims: targets, maxDepth: 6 });
    if (chain.status === 'found') break;
    retries++;
    st.phase = 'goal-frontier';
    out(`目标无规划链（R3 缺规则），前沿探索第 ${retries} 轮`);
    await probeOverSpecific(goalDims); // 先对"结果命中目标维但因素过宽"的规则做控制变量探针，剔薄因素集
    await frontierRound(goalDims, retries, targets);
  }
  if (chain.status !== 'found') {
    st.goalReport = { targets, reached: false, terminationReason: 'no-known-route', frontierRetries: retries, engine: 'r123' };
    out(`目标结果：${JSON.stringify(st.goalReport)}`);
    st.goal = null; st.phase = 'running';
    return;
  }
  // 执行规划链：逐节因素核对 → 执行 → 结果核对（捕获），断裂即停（如实上报）
  // 全部按概念中心值容差比较（语义大修：规则存含义不存编号）
  out(`规划链（${chain.steps.length} 节）：${chain.steps.map((r) => `${ACTION_NAMES[r.action]}→${JSON.stringify(r.outcomes)}`).join(' → ')}`);
  const closeEnough = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 0.6;
  const satTarget = (d, v) => (v && typeof v === 'object' && 'min' in v)
    ? (st.lastCenterState[d] >= v.min - 1e-9 && st.lastCenterState[d] <= v.max + 1e-9)
    : closeEnough(st.lastCenterState[d], v);
  let broke = null;
  for (const [i, rule] of chain.steps.entries()) {
    const missing = Object.fromEntries(Object.entries(rule.factors).filter(([d, v]) => !closeEnough(st.lastCenterState[d], v)));
    if (Object.keys(missing).length) { broke = { step: i, reason: '因素不满足', missing }; break; }
    await step(rule.action);
    const wrong = Object.fromEntries(Object.entries(rule.outcomes).filter(([d, v]) => !closeEnough(st.lastCenterState[d], v)));
    if (Object.keys(wrong).length) { broke = { step: i, reason: '结果不符（捕获）', wrong }; break; }
  }
  const reached = !broke && Object.entries(targets).every(([d, v]) => satTarget(d, v));
  st.goalReport = { targets, reached, chainLen: chain.steps.length, broke, frontierRetries: retries, engine: 'r123' };
  out(`目标结果：${JSON.stringify(st.goalReport)}`);
  st.goal = null;
  st.phase = 'running';
}

async function runGoal(spec) {
  if (ENGINE === 'r123') return runGoalR123(spec); // 新架构：R1→R2→R3→反向链接
  const goalDims = Object.keys(spec).filter((d) => DIM_NAMES.includes(d));
  // 概念未形成 → 朝目标维前沿探索到形成为止（push the boundary：不报"先探索"就停）
  let goal = null, waits = 0;
  while (!goal && waits < 15) {
    try { goal = resolveGoalSpec(spec); break; }
    catch (e) {
      if (waits === 0) out(`目标的概念尚未形成（${e.message}）——开始朝目标维主动探索`);
      st.phase = 'goal-frontier';
      // 地标回访：概念没形成时，回到见过稀罕东西的地方探（"原木曾出没于树柱那边"），
      // 而不是在原地瞎挖——空间盲的前沿探索证明过是徒劳的
      const lmList = [...landmarks.values()];
      if (lmList.length) {
        const lm = lmList[Math.floor(rng() * lmList.length)];
        out(`[前沿] 回访地标 (${lm.x.toFixed(1)},${lm.z.toFixed(1)})`);
        await body.lookAt(lm.x, -59.5, lm.z);
        await body.goto(lm.x, lm.z, 2.0);
      }
      for (let i = 0; i < 40; i++) await step(frontierAction(goalDims, targets));
      waits++;
    }
  }
  if (!goal) {
    st.goalReport = { error: '前沿探索后目标概念仍未形成', goalDims, frontierWaits: waits };
    out(`目标结果：${JSON.stringify(st.goalReport)}`);
    st.goal = null; st.phase = 'running';
    return;
  }
  const cur = st.lastCState;
  out(`目标：${JSON.stringify(goal)}（当前 ${JSON.stringify(cur)}，可读 ${JSON.stringify(cStateReadable(goal))}）`);
  let exec = await executeGoal(mem, embodiedBench, cur, goal, 1, { planFn: planGoalAsync });
  let retries = 0;
  // 无路线 → 目标前沿探索（push the boundary：攒规则再攻，不报做不到），有界重试
  while (!exec.reached && exec.plans[0]?.status !== 'found' && retries < 10) {
    retries++;
    st.phase = 'goal-frontier';
    out(`目标无路线，前沿探索第 ${retries} 轮（40 决策攒规则后重试规划）`);
    await frontierRound(goalDims, retries, targets);
    exec = await executeGoal(mem, embodiedBench, st.lastCState, goal, 1, { planFn: planGoalAsync });
  }
  st.goalReport = {
    goal, goalReadable: cStateReadable(goal), reached: exec.reached, terminationReason: exec.terminationReason,
    planStatus: exec.plans.at(-1)?.status, planSteps: exec.plans.at(-1)?.steps.length,
    executed: exec.steps.length, replans: exec.replans.length, frontierRetries: retries,
  };
  out(`目标结果：${JSON.stringify(st.goalReport)}`);
  st.goal = null;
  st.phase = 'running';
}

// ── 四级验收协议（--levels 模式）────────────────────────────
/** L2 撤教师自主验证：原型自己行动 K 步，每步行动前先预测、行动后对比真实结果。
 * 经验是否学到 = 逐维预测准确率（可用率=网络敢回答的比例）。 */
async function verifyLearning(k = 40) {
  let usable = 0, hit = 0, tot = 0;
  const perDimHit = Object.fromEntries(DIM_NAMES.map((d) => [d, 0]));
  const perDimN = Object.fromEntries(DIM_NAMES.map((d) => [d, 0]));
  for (let i = 0; i < k; i++) {
    const frame = perceive();
    formation.presentExperiment(frame, 4);
    const cState = ENGINE === 'r123' ? resolveFrameCenter(frame) : resolveFrame(frame); // r123 全程中心值态
    const idx = exploreAction();
    const action = actionOf(idx);
    let pred;
    if (ENGINE === 'r123') { // R3 预测（反转点火门：满足因素即可答）；预测下一帧 = 当前帧+规则结果
      const p3 = r3.predict(cState, idx, (1000 + i) >>> 0);
      pred = p3.kind === 'usable'
        ? { kind: 'usable', next: Object.fromEntries(DIM_NAMES.map((d) => [d, p3.outcomes[d] ?? cState[d]])) }
        : { kind: p3.kind };
    } else {
      pred = mem.predict(cState, action, (1000 + i) >>> 0); // legacy 样本登记预测（A/B 对照）
    }
    await body.act(ACTION_NAMES[idx]);
    const next = perceive();
    formation.presentExperiment(next, 4);
    const cNext = ENGINE === 'r123' ? resolveFrameCenter(next) : resolveFrame(next);
    // 自己的行动也继续学（与 step() 同一登记路径：R1 只记变化维 + 裸值帧）
    const changed = {};
    for (const d of DIM_NAMES) if (cNext[d] !== cState[d]) changed[d] = cNext[d];
    r1.record(cState, idx, changed, frame, next);
    if (ENGINE === 'legacy') mem.observe(cState, action, outcomesOf(cNext));
    st.writes++; st.decisions++;
    if (st.decisions % 50 === 0) { registry.refresh(formation.extractConcepts(0.5)); retina.refreshWells(); rebuildR3(); st.concepts = registry.all().length; }
    if (pred.kind !== 'usable' || !pred.next) continue;
    usable++;
    for (const d of DIM_NAMES) {
      perDimN[d]++; tot++;
      // 中心值态按容差比对（0.6）；索引态按精确（legacy 路径）
      const ok = ENGINE === 'r123' ? Math.abs(pred.next[d] - cNext[d]) <= 0.6 : pred.next[d] === cNext[d];
      if (ok) { perDimHit[d]++; hit++; }
    }
  }
  return {
    steps: k, usableRate: +(usable / k).toFixed(2), accuracy: tot ? +(hit / tot).toFixed(2) : null,
    perDim: Object.fromEntries(DIM_NAMES.map((d) => [d, perDimN[d] ? +(perDimHit[d] / perDimN[d]).toFixed(2) : null])),
  };
}

/** 四级验收：L1 教师接管观察学习 → L2 自主验证 → L3/L4 目标（L4 教师不教拾取） */
async function runLevelsProtocol(level4) {
  const t0 = Date.now();
  const report = { mode: level4 ? 'L4（教师未教拾取，缺失规则待自探）' : 'L1-L3', startedAt: new Date().toISOString() };
  // ── L1：教师接管身体，原型只观察学习 ──
  await runCurriculum();
  registry.refresh(formation.extractConcepts(0.5));
  retina.refreshWells();
  rebuildR3(); // 课程经验差分结果物化进 R3（目标模式前必须有规则）
  st.concepts = registry.all().length;
  const labeled = retina.stable.filter((w) => w.label && w.label !== '看-未知');
  report.L1 = {
    wells: retina.wellSummary(), labeledWells: labeled.length, concepts: st.concepts, rules: st.rules,
    conceptCenters: Object.fromEntries(DIM_NAMES.map((d) => [d, registry.byDim.get(d).map((c) => +c.centerValue.toFixed(2))])),
    verdict: labeled.length >= 3 && st.rules >= 10 ? '达成' : '存疑',
  };
  out(`[L1] 教师课程结束：井 ${retina.stable.length}（已标签 ${labeled.length}：${labeled.map((w) => w.label).join('、')}），规则 ${st.rules}，概念 ${st.concepts} → ${report.L1.verdict}`);
  // ── L2：撤教师，自主行动验证经验 ──
  if (!level4) {
    const v = await verifyLearning(40);
    report.L2 = { ...v, verdict: v.usableRate >= 0.5 && v.accuracy >= 0.7 ? '达成' : '存疑' };
    out(`[L2] 自主验证：网络敢答率 ${v.usableRate}，逐维预测准确率 ${v.accuracy}，分维 ${JSON.stringify(v.perDim)} → ${report.L2.verdict}`);
  }
  // ── L3/L4：目标 logGrip≥1（L4 途中缺"走过去拾取"规则）──
  const key = level4 ? 'L4' : 'L3';
  report[key] = { goal: { logGrip: { gte: 1 } }, note: level4 ? '检查目标引导下能否自探出缺失的拾取规则' : '所需规则全部在课程演示过' };
  out(`[${key}] 目标：拿到一块原木（logGrip≥1）`);
  // 目标非平凡化：开局前把课上捡到手的原木放回世界（保证开局 logGrip=0，目标必须真做，
  // 否则 executeGoal 第一步就判已达成，验收空转）
  let clears = 0;
  for (;;) { // 丢弃原木 stacks（Q 键抛出成掉落物）：放置会被首格拴绳卡死，toss 无视首格顺序
    const logs = body.bot.inventory.items().filter((i) => i.name === 'oak_log');
    if (!logs.length || clears >= 4) break;
    for (const it of logs) await body.bot.tossStack(it).catch(() => {});
    clears++;
    const p = body.bot.entity.position;
    await body.goto(p.x + 12, p.z, 1.5); // 丢完立刻远离 12m：走出重吸半径（边走边吸回、8 批仍剩 1 的根因）
    await step(7); // 刷新帧读裸值
  }
  const trivial = (st.lastFrame?.logGrip ?? 0) > 0;
  out(`[${key}] 丢弃检查：clears=${clears} raw.logGrip=${st.lastFrame?.logGrip} cState.logGrip=${st.lastCState?.logGrip} trivial=${trivial}`);
  if (clears) out(`[${key}] 开局前丢弃原木 ${clears} 批（剩余 logGrip=${st.lastFrame?.logGrip}）${trivial ? '——未清空，若 0 步达成属平凡，如实标注' : ''}`);
  report[key].trivialStart = trivial;
  await runGoal({ logGrip: { gte: 1 } });
  report[key].result = st.goalReport;
  report[key].verdict = st.goalReport?.reached ? '达成' : '未达成';
  out(`[${key}] ${report[key].verdict}：${JSON.stringify(st.goalReport)}`);
  report.totalMin = +((Date.now() - t0) / 60000).toFixed(1);
  fs.writeFileSync(path.join(RUNS, `levels-acceptance${level4 ? '-L4' : ''}.json`), JSON.stringify(report, null, 1));
  out(`[验收] 完成，总耗时 ${report.totalMin}min，报告 runs/levels-acceptance${level4 ? '-L4' : ''}.json`);
  await body.quit();
  process.exit(0);
}

// ── 状态 / 控制 API ──────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      phase: st.phase, teacher: st.teacher, frames: st.frames, decisions: st.decisions, writes: st.writes,
      concepts: st.concepts, rules: st.rules,
      lastFrame: st.lastFrame, lastCState: st.lastCState,
      cStateReadable: st.lastCState ? cStateReadable(st.lastCState) : null,
      lastDecision: st.lastDecision, goal: st.goal, goalReport: st.goalReport,
      retina: retina ? { wells: retina.stable.length, labeled: retina.stable.filter((s) => s.label).length, last: st.lastRecognition ?? null } : null,
      spatial: ring ? { ringPos: +ring.position().toFixed(1), heading: +heading().toFixed(2), integ: { x: +pInt.x.toFixed(1), z: +pInt.z.toFixed(1) }, landmarks: landmarks.size } : null,
      experiments: experiments ? experiments.summary() : null,
    }, null, 1));
    return;
  }
  if (req.method === 'GET' && req.url === '/concepts') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    const lines = [`概念层（连续流动，无冻结）：已采 ${st.frames} 帧，注册概念 ${st.concepts} 个`];
    if (registry) for (const c of registry.all())
      lines.push(`  概念#${c.stableIndex} [${labelOf(c.dimension, c.centerValue)}] 维度=${c.dimension} 中心=${c.centerValue.toFixed(3)} 成员=${c.memberNeuronIds.length} 内强度=${c.meanInternalWeight.toFixed(3)}`);
    if (retina) {
      lines.push(`视觉井（8×8 材质网格，${retina.observations} 次观察）：`);
      for (const w of retina.wellSummary())
        lines.push(`  井#${w.stableIndex} [${w.label ?? '未标注'}] 成员=${w.members}`);
    }
    res.end(lines.join('\n'));
    return;
  }
  if (req.method === 'POST' && req.url === '/goal') {
    let bodyText = '';
    req.on('data', (c) => { bodyText += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      try {
        const spec = JSON.parse(bodyText || '{}');
        st.goal = spec; st.goalReport = null;
        res.end(JSON.stringify({ accepted: true, goal: spec }));
      } catch (e) { res.end(JSON.stringify({ accepted: false, error: e.message })); }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/pause') { st.paused = true; res.writeHead(200); res.end('{"paused":true}'); return; }
  res.writeHead(404); res.end();
});

async function connect() {
  body = createBody({});
  await body.ready;
  out('[系统] 具身已连接（生存模式，无任何作弊指令）');
}

async function main() {
  server.listen(3008, '127.0.0.1');
  out('[系统] 状态 API：http://127.0.0.1:3008/status ｜ 概念面板：/concepts');
  enc = new SensoryEncoder(SENSORY_DIMS, 25);
  formation = new ConceptFormation(enc);
  registry = new StableConceptRegistry(enc, CONCEPT_CAPS);
  mem = new TransitionMemory(CONCEPT_SPACE);
  retina = new RetinaStream({}); // 视觉流：独立概念网络（64 格×12 感受野=768 神经元），viewWell 低位输出进主层
  if (NetClass) { // 脉冲基质：换两个概念网络的底座（语义等价，结构不动）
    formation.net = new NetClass({ neuronCount: enc.neuronCount, activationEnergy: 1.0, maintenanceEnergy: 0.5, learningRate: 0.1, maxWeight: 3.0 });
    retina.formation.net = new NetClass({ neuronCount: retina.enc.neuronCount, activationEnergy: 1.0, maintenanceEnergy: 0.5, learningRate: 0.1, maxWeight: 3.0 });
    out(`[系统] 网络基质：脉冲载体（SpikingEnergyNetwork，语义与二值逐位等价）`);
  }
  // R1/R2A/R2B/R3：经验→差分→因素规则（默认引擎；样本登记架构降级为 A/B 对照）
  r1 = new EpisodeBuffer({ capacity: 4000, persistPath: EPISODES });
  r2 = new DifferentialExtractor({ quorum: 3 });
  r3 = new FactorRuleNet(CONCEPT_CAPS, ACTION_NAMES.length);

  if (process.argv.includes('--levels')) { // 四级验收模式：重建场地、全新身份、跑协议、退出
    execFileSync(process.execPath, [path.join(ROOT, 'build-flat-map.cjs')], { stdio: 'inherit' });
    body = createBody({ username: `LV${Date.now() % 100000}` });
    await body.ready;
    initSpatial(); // 空间层：罗盘环点燃 + 路径积分归零 + 环位对齐初始 yaw
    out('[系统] 验收模式：场地已重建，全新身份接入（教师接管，原型只观察学习）');
    await runLevelsProtocol(process.env.LEVEL4 === '1');
    return;
  }

  await connect();
  initSpatial(); // 空间层：罗盘环点燃 + 路径积分归零 + 环位对齐初始 yaw
  // 主动控制变量实验调度器：空转分支里对"从未变化的存疑因素维"做干预实验（判决靠 R2B 重差分）
  experiments = new ExperimentScheduler({
    getBody: () => body, st, r1, r3, registry, caps: CONCEPT_CAPS,
    step: (i) => step(i), probe: () => resolveFrame(perceive()),
    rng, out, ACTION_NAMES, DIM_NAMES,
    ledgerPath: path.join(RUNS, 'experiments.jsonl'),
  });
  st.phase = 'running';
  out(`[系统] 连续流启动：概念空间 ${CONCEPT_SPACE.states.map((d) => `${d.name}=${d.bins}档`).join(' ')}`);
  for (;;) {
    if (st.paused) { st.phase = 'paused'; await new Promise((r) => setTimeout(r, 1000)); continue; }
    try {
      if (!body.isOnline()) { out('[系统] 断线，重连中…'); await connect(); }
      // 决策：目标 > 教师课程 > 自主探索
      if (st.goal && !st.goalReport) { await runGoal(st.goal).catch((e) => { st.goalReport = { error: e.message }; st.goal = null; }); continue; }
      if (st.teacher) {
        await runCurriculum(); // 阻塞式巡回：课程走完才返回（goto 在 loop 内不被打断）
        continue;
      }
      const t0 = performance.now();
      // 抢占注意力优先于随机探索：掉落物在抢占窗内 → 微目标"接近它"（自适应偏好打分驱动）
      if (st.attentionCapture && st.decisions < st.attentionCapture.until) {
        await step(frontierAction(['itemDist'], { itemDist: [0, 1] }));
      } else {
        await step(exploreAction());
      }
      if (st.frames % 20 === 0) out(`[节奏] step ${((performance.now() - t0) / 1000).toFixed(1)}s`);
      if (st.frames % 100 === 0) {
        registry.refresh(formation.extractConcepts(0.5));
        retina.refreshWells(); // 视觉井也周期重检（标签随成员重叠继承，槽位稳定）
        rebuildR3(); // R3 因素规则网周期物化（R2 差分结果 → 网络）
        st.concepts = registry.all().length;
        out(`[概念] ${st.frames} 帧，注册表 ${st.concepts} 个概念（稳定索引），视觉井 ${retina.stable.length}，R3规则 ${r3.rules.length}`);
      }
      if (experiments) await experiments.maybeRun(); // 控制变量实验（内部自节流：每 20 决策一次，无目标非教师期才动手）
      st.frames++;
    } catch (e) {
      out(`[系统] 循环异常（继续）：${e.message}`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

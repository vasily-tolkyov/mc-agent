/** 体素视网膜：不做 GPU 渲染，直接从 bot 已加载的区块数据做视锥射线采样，
 * 得到 8×8"材质网格"（每格一个材质类别，视线中心 = 注视点——眼球跟着转头，
 * 所以"新位置认出旧物"等价于"重新注视后落进同一口井"）。
 * 色彩近似如实声明：格值来自 方块名→材质类 查表，不是真实纹理。
 * 零新依赖、零渲染（64 条算术射线，复用 raycastForward 的纯算术步进——
 * 教训：本环境的 vec3.plus/scale 不可靠，只用 Vec3 构造器 + blockAt）。
 *
 * 三轮实测失败换来的三个机制（v1/v2 场景粘连、v3 首学对象被自身频次抑制）：
 *
 * 1) 中央凹窗口：学习与识别只在中央 6×6 格进行。开阔世界里对跖点互视
 *    （石头场地看得见木板柱）会把一切共现成一团；foveation（注视即对象）
 *    是通用的解剖学事实，不是场景特定的预承诺。
 *
 * 2) 去相关文档频率门控：稀罕度按"独立文档"统计——相邻帧 IoU ≥ 0.3 视为同一文档
 *    不重复计数。否则环绕学习 12 帧会把正在学的东西刷成"常见"而被自家门控吃掉
 *    （v3 原木柱 0.54 超阈被抑制的实测教训）。天空/草地出现在每个文档 → 永久抑制；
 *    稀罕材质在哪都凸显。副作用：常见材质习惯化（采石场里石头不再凸显），如实说明。
 *
 * 3) 场景切换对比抑制（Γ，架构自带机制——formation.ts 设计原语"替代区之间写上抑制"）：
 *    相邻两次供能呈现的激活集 IoU < 0.15 视为场景切换，前后集合互写对称抑制。
 *    有 Γ 后：井内 W 吸引、井间 Γ 互斥，钳置线索只补全自己那口井——单核胜出。
 *
 * 势阱的操作定义：井 = 教师标记时刻 settle 收敛到的吸引子激活模式
 * （detectWells 的严格局部极大边在致密共享背景图上会碎裂/合并，如实弃用，
 * 改用"settle 不动点 = 井"这一等价操作化定义）；读出用仓库 ReadoutModule（要求 9）。
 */
import Vec3 from 'vec3';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ENS = process.env.ENS_PATH ?? fileURLToPath(new URL('../../energy-network-sim', import.meta.url)); // 同级克隆 energy-network-sim，或用 ENS_PATH 指定
const imp = (p) => import(pathToFileURL(`${ENS}/${p}`).href);
const { SensoryEncoder, iou } = await imp('dist/src/pop/concept/sensory.js');
const { ConceptFormation } = await imp('dist/src/pop/concept/formation.js');
const { ReadoutModule } = await imp('dist/src/readout.js');

// ── 材质调色板（10 类；类别顺序无语义，仅编码）──────────────
export const MATERIALS = ['sky', 'plant', 'soil', 'stone', 'wood', 'plank', 'sand', 'fluid', 'special', 'other'];
export function materialOf(name) {
  if (!name || name === 'air' || name === 'cave_air' || name === 'void_air') return 0;
  if (name.includes('leaves') || name === 'grass_block' || name === 'grass' || name.includes('fern')
    || name.includes('flower') || name.includes('sapling') || name.includes('vine')) return 1;
  if (name === 'dirt' || name.includes('dirt') || name === 'podzol' || name === 'farmland' || name === 'mud') return 2;
  if (name.includes('ore') || name.includes('stone') || name === 'gravel' || name === 'bedrock'
    || name === 'andesite' || name === 'diorite' || name === 'granite' || name === 'cobblestone') return 3;
  if (name.includes('log') || name.includes('stem')) return 4;
  if (name.includes('planks') || name === 'crafting_table' || name === 'chest' || name.includes('fence')
    || name.includes('door') || name.includes('sign') || name === 'ladder') return 5;
  if (name === 'sand' || name === 'red_sand' || name.includes('sandstone')) return 6;
  if (name === 'water' || name === 'lava' || name.includes('ice') || name.includes('snow')) return 7;
  if (name.includes('gold') || name.includes('emerald') || name.includes('diamond') || name.includes('iron')
    || name === 'glass' || name === 'glowstone' || name.includes('lapis')) return 8;
  return 9;
}

/** 视锥射线采样：size×size 网格，注视点在中心。返回 Int16Array（材质类 0-9）。 */
export function retinaGrid(bot, { size = 8, hfov = 1.05, vfov = 0.75, maxDist = 10, step = 0.3 } = {}) {
  const p = bot.entity.position;
  const yaw = bot.entity.yaw, pitch = bot.entity.pitch;
  const EYE = 1.62;
  const cells = new Int16Array(size * size);
  for (let row = 0; row < size; row++) {
    const pitchOff = (row / (size - 1) - 0.5) * vfov; // row 0 = 顶 = 负俯角（抬头）
    for (let col = 0; col < size; col++) {
      const yawOff = (0.5 - col / (size - 1)) * hfov; // col 0 = 左（yaw 增大方向）
      const y = yaw + yawOff, pt = pitch + pitchOff;
      const cp = Math.cos(pt);
      const dx = -Math.sin(y) * cp, dy = -Math.sin(pt), dz = Math.cos(y) * cp;
      let cls = 0; // 无命中 = 天空
      for (let d = step; d <= maxDist; d += step) {
        const b = bot.blockAt(new Vec3(p.x + dx * d, p.y + EYE + dy * d, p.z + dz * d));
        if (b && b.name !== 'air') { cls = materialOf(b.name); break; }
      }
      cells[row * size + col] = cls;
    }
  }
  return cells;
}

const CELL_DIMS = (size) => Array.from({ length: size * size }, (_, i) => ({
  name: `r${i}`, min: -0.5, max: MATERIALS.length - 0.5, sigma: 0.3, // 类别维：窄 σ，邻类不串味
}));

/** 视觉流：自己的概念网络（高维感受野，类比视觉皮层），经 viewWell 低位输出进主概念层。 */
export class RetinaStream {
  constructor({ size = 8, fieldsPerDim = 12, maxWells = 13, minDocs = 5, docIou = 0.5, salienceDf = 0.65, contrastIou = 0.15, contrastDelta = 0.4, windowMargin = 1 } = {}) {
    this.size = size;
    this.maxWells = maxWells;
    this.minDocs = minDocs;         // 攒够 5 个独立文档才供能（8 会吃掉首个标本的学习窗——v6 实测）
    this.docIou = docIou;           // 相邻帧 IoU ≥ 0.5 = 同一文档，稀罕度不重复计数
                                    //（0.3 太严：校准环顾几乎记不到文档，门控永不启动——v4 实测）
    this.salienceDf = salienceDf;   // 材质值的文档频率 ≥0.65 → 寻常，抑制不供能
                                    //（0.5 会误杀"正在密集学习"的对象：环绕 12 帧 + 校准期入镜
                                    // 把原木 df 刷到 0.50 恰好压线——v5 实测；天空 0.92/草地 0.75 与
                                    // 原木 0.50 之间有干净间隔，阈值取 0.65）
    this.contrastIou = contrastIou; // 相邻供能呈现 IoU < 0.15 = 场景切换 → 写对比抑制
    this.contrastDelta = contrastDelta; // 0.4/次：切换事件稀少，单次剂量要够压住桥接 W
    /** 中央凹窗口下标（预计算） */
    this.windowCells = [];
    for (let r = windowMargin; r < size - windowMargin; r++)
      for (let c = windowMargin; c < size - windowMargin; c++) this.windowCells.push(r * size + c);
    this.enc = new SensoryEncoder(CELL_DIMS(size), fieldsPerDim);
    this.formation = new ConceptFormation(this.enc, { maxWeight: 3.0 });
    /** 稀罕度统计：材质值 → 出现过的独立文档数 */
    this.valueFrames = new Map();
    this.frameCount = 0; // 独立文档计数
    this.lastCounted = null; // 上一个计入文档的窗口激活集
    this.prevActive = null; // 上一次供能呈现的激活集（对比抑制的"前任"）
    /** 吸引子井：append-only，索引即稳定槽位（不进检出循环，永不漂） */
    this.wells = []; // { wellId, memberNeuronIds, label, energy }
    this.readout = new ReadoutModule([], 0.5);
    this.observations = 0;
  }

  /** 材质值的文档频率；未见过的值 df=0（最稀罕） */
  df(value) { return this.frameCount === 0 ? 0 : (this.valueFrames.get(value) ?? 0) / this.frameCount; }

  /** 凸显格 = 中央凹窗口内、当前值稀罕（df < 阈值）的格子下标 */
  deviantCells(grid) {
    if (this.frameCount < this.minDocs) return [...this.windowCells]; // 校准期全部凸显（但不供能）
    return this.windowCells.filter((c) => this.df(grid[c]) < this.salienceDf);
  }

  encodeCells(grid, cells) {
    const v = {};
    for (const c of cells) v[`r${c}`] = grid[c];
    return this.enc.encode(v);
  }

  /** 学习永不停止：稀罕格共现成阱（W）；场景切换时前后激活集互写抑制（Γ） */
  observe(grid, repeats = 4) {
    this.observations++;
    const windowActive = this.encodeCells(grid, this.windowCells);
    if (!this.lastCounted || iou(windowActive, this.lastCounted) < this.docIou) { // 新文档才计稀罕度
      for (const v of new Set(this.windowCells.map((c) => grid[c]))) this.valueFrames.set(v, (this.valueFrames.get(v) ?? 0) + 1);
      this.frameCount++;
      this.lastCounted = windowActive;
    }
    if (this.frameCount < this.minDocs) { this.prevActive = null; return 0; } // 校准期：静息不供能
    const dev = this.deviantCells(grid);
    if (dev.length < 4) { this.prevActive = null; return 0; } // 窗口内全是寻常 → 静息；前任清空（下帧不算切换）
    const active = this.encodeCells(grid, dev);
    this.formation.presentExperiment(Object.fromEntries(dev.map((c) => [`r${c}`, grid[c]])), repeats);
    // 场景切换对比抑制：与前任几乎不重叠 → 互斥（同一物体的环绕视角共享标本神经元，IoU 高，不触发）
    if (this.prevActive && iou(active, this.prevActive) < this.contrastIou) {
      for (const a of active) for (const b of this.prevActive) this.formation.net.strengthenInhibitory(a, b, this.contrastDelta);
    }
    this.prevActive = active;
    return dev.length;
  }

  /**
   * 教师程序接口（设计第 8 条后半句）：当前画面 settle 到的吸引子登记为井并赋标签。
   * 与既有井 IoU ≥ 0.7 → 同一物体再看一眼：刷新该井成员（吸引子快照），不新增。
   */
  labelCurrent(grid, label) {
    const dev = this.deviantCells(grid);
    if (dev.length < 4) return null;
    const settled = this.formation.net.settle(this.encodeCells(grid, dev));
    const members = settled.activeNeurons;
    const mSet = new Set(members);
    let best = -1, bestIou = 0;
    for (const [i, w] of this.wells.entries()) {
      const wSet = new Set(w.memberNeuronIds);
      let inter = 0;
      for (const id of members) if (wSet.has(id)) inter++;
      const j = inter / (mSet.size + wSet.size - inter);
      if (j > bestIou) { bestIou = j; best = i; }
    }
    if (best >= 0 && bestIou >= 0.7) {
      this.wells[best] = { ...this.wells[best], memberNeuronIds: members, label, energy: settled.energy };
    } else {
      if (this.wells.length >= this.maxWells) return null; // 溢出：如实 null
      this.wells.push({ wellId: this.wells.length, memberNeuronIds: members, label, energy: settled.energy });
    }
    this.readout = new ReadoutModule(this.wells.map((w) => ({
      wellId: w.wellId, peak: { from: 0, to: 0, weight: 0 }, // 吸引子井无峰边语义，占位
      memberNeuronIds: w.memberNeuronIds, edgeCount: 0,
    })), 0.5);
    for (const w of this.wells) if (w.label) this.readout.labelWell(w.wellId, w.label);
    return { stableIndex: best >= 0 && bestIou >= 0.7 ? best : this.wells.length - 1, members: members.length, energy: settled.energy };
  }

  /**
   * 识别（设计第 7/9/10 条）：钳置凸显格 → settle 到最小能耗激活模式 → 读激活的井。
   * 双向匹配（v11 金块误判教训：6 格偏离擦到石头井边就被级联补全成 100%）：
   *   recall    = 井成员被激活比例（井被点燃）；
   *   coverage  = 钳置输入中落在井内的比例（输入被解释）——陌生物体的钳置神经元
   *               不属于任何井，coverage 低，否决。
   *   score = recall × coverage；单核胜出原则：次佳差距 < 0.10 判未识别。
   */
  recognize(grid) {
    const t0 = performance.now();
    const dev = this.deviantCells(grid);
    if (dev.length < 4 || !this.wells.length) {
      return { stableIndex: null, label: null, ratio: 0, energy: 0, deviants: dev.length, ms: performance.now() - t0, hits: [] };
    }
    const clamped = this.encodeCells(grid, dev);
    // 新材质否决（侧重否决）：窗口内出现经验里从未见过的材质类（df=0）→ 画面含有
    // 未知物体，任何井都不能算认出（这也是后续自形成新概念的触发信号）
    const novel = dev.filter((c) => this.df(grid[c]) === 0).length;
    if (novel > 0) {
      return { stableIndex: null, label: null, ratio: 0, energy: 0, deviants: dev.length, novel, ms: performance.now() - t0, hits: [] };
    }
    const settled = this.formation.net.settle(clamped);
    const hits = this.readout.identify(settled.activeNeurons).map((h) => {
      const wSet = new Set(this.wells[h.wellId]?.memberNeuronIds ?? []);
      const coverage = clamped.filter((id) => wSet.has(id)).length / Math.max(1, clamped.length);
      return { wellId: h.wellId, ratio: h.activationRatio, coverage, score: h.activationRatio * coverage, label: h.label };
    }).sort((a, b) => b.score - a.score || a.wellId - b.wellId);
    const ms = performance.now() - t0;
    const base = {
      label: null, energy: settled.energy, deviants: dev.length, ms,
      hits: hits.map((h) => ({ wellId: h.wellId, ratio: +h.ratio.toFixed(3), coverage: +h.coverage.toFixed(3), score: +h.score.toFixed(3), label: h.label })),
    };
    if (!hits.length) return { ...base, stableIndex: null, ratio: 0 };
    const best = hits[0];
    const margin = hits[1] ? best.score - hits[1].score : best.score;
    if (best.score < 0.4 || margin < 0.10) return { ...base, stableIndex: null, ratio: best.ratio, ambiguous: margin < 0.10 };
    return { ...base, stableIndex: best.wellId, label: best.label ?? null, ratio: best.ratio };
  }

  /** 给主概念层的低位输出：认出的井稳定槽位，未识别 = maxWells（未知档） */
  viewWellValue(grid) {
    const r = this.recognize(grid);
    return { value: r.stableIndex ?? this.maxWells, recognition: r };
  }

  /** 井是 append-only 吸引子快照（索引即稳定槽位），不做周期重检 */
  get stable() { return this.wells; } // mind-agent labelOf 读取 .stable[i].label

  /** 稀罕度报表（调参透明化）：材质值 → 文档频率 */
  dfReport() {
    return MATERIALS.map((name, v) => ({ value: v, name, df: +this.df(v).toFixed(2), docs: this.valueFrames.get(v) ?? 0 }))
      .filter((r) => r.df > 0);
  }

  wellSummary() {
    return this.wells.map((w, i) => ({ stableIndex: i, label: w.label, members: w.memberNeuronIds.length, energy: +w.energy.toFixed(1) }));
  }
}

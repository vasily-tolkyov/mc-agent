/** 主动控制变量实验调度器：对"全历史从未变化"的存疑因素维做干预实验。
 *
 * 为什么需要它：R2B 差分只能判决"变化过"的因素维——组内变化而结果不变 → 排除。
 * 但有些维在全部经验中从未变化（onGround 恒为 1：决策步 ~1.2s 永远采不到空中帧），
 * 它们留在因素集里是"未被证伪就当因素"，逻辑上过强，本来应该是"存疑"。
 * 本调度器在无外部目标、非教师期的空转分支里主动补这一块：
 *
 *   选疑点 → 设计干预（让该维取一个不同的值）→ 变体状态下走 step() 执行规则动作
 *   （记转移、喂 R1——裁决靠它）→ 下次 rebuildR3 重差分自动判决 → 台账落盘。
 *
 * 铁律：调度器不重写差分逻辑。它只设计实验、如实记账、检测判决结果——
 *   排除 = 变体下结果复现过，且 R3 同簇规则（同动作同结果）的因素集已不含该维；
 *   确认 = 变体下结果连续未复现 ≥3 次（该维确实是必要条件）；
 *   技术存疑 = 封顶 6 次仍采不到变体/无法判决（瞬态维采不到不硬撑）。
 */
import fs from 'node:fs';
import { DifferentialExtractor } from './r2-diff.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EVERY_N = 20;      // 空转分支里每 N 个决策考虑安排一次实验（自节流）
const CAP_TRIES = 6;     // 单（规则,维）实验对封顶：6 次仍采不到变体/无法判决 → 技术存疑
const CONFIRM_FAILS = 3; // 变体下结果连续未复现 ≥3 次 → 确认该维必要

/** 长途导航唯一入口（pathfinder goto）——环境/教师的本事，不是原型的能力。
 * 用户明确要求后期路径规划与移动收归原型目标规划；届时整体替换这一个函数即可，
 * 调度器其余部分一行不动。 */
async function envNavigate(body, x, z, r = 2.0) { await body.goto(x, z, r); }

/** 结果维值签名（同 R2 簇键的结果侧：动作+结果签名 = 一个规则簇，因素集漂移不改簇身份） */
const outcomeSig = (r) => Object.keys(r.outcomes).sort().map((d) => `${d}=${r.outcomes[d]}`).join(',');
const pairKey = (rule, dim) => `${rule.action}|${outcomeSig(rule)}|${dim}`;

export class ExperimentScheduler {
  /**
   * ctx = { getBody, st, r1, r3, registry, caps, step, probe, rng, out,
   *         ACTION_NAMES, DIM_NAMES, ledgerPath }
   * probe() = 感知+解析当前概念帧（只读不写 R1）；step(i) 是 mind-agent 的决策步（记转移）。
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.pairs = new Map();  // pairKey → 实验对内存台账（jsonl 追加落盘是权威历史）
    this.current = null;     // 进行中的实验（/status 曝光用）
    this.lastRunAt = 0;      // 上次安排实验时的决策数（自节流）
  }

  /** 空转分支每轮调用；内部自节流（每 EVERY_N 个决策一次）。 */
  async maybeRun() {
    const { st, r3 } = this.ctx;
    if (this.current) return;                       // 防重入：实验严格串行
    if (st.teacher || st.goal || st.paused) return; // 双保险（调用方已在空转分支）
    if (st.decisions - this.lastRunAt < EVERY_N) return;
    this.lastRunAt = st.decisions;
    if (!r3.rules.length) return;
    this.refreshVerdicts(); // 先收割：上次实验的判决可能已随周期重建落地
    const cand = this.pickSuspect();
    if (!cand) return;
    await this.runExperiment(cand);
  }

  /** 选疑点：R3 规则的因素维里，"R1 全历史（裸值→当前概念透镜）有效取值数==1"的维。
   * 从未变化 = 未被证伪就当因素 = 存疑。排序：规则 support × 1/(1+该对实验已试次数)，取第一。 */
  pickSuspect() {
    const { r3, caps } = this.ctx;
    const distinct = this.distinctByDim();
    let best = null;
    for (const rule of r3.rules) {
      for (const [dim, v] of Object.entries(rule.factors)) {
        if (v === caps[dim]) continue;          // 恒未知档：概念没成形，先不做实验
        const vals = distinct.get(dim);
        if (!vals || vals.size !== 1) continue; // 历史里变过 → 差分可判决，不是疑点
        const key = pairKey(rule, dim);
        const pair = this.pairs.get(key);
        if (pair && pair.verdict !== '进行中') continue;
        const score = rule.support / (1 + (pair?.tries ?? 0));
        if (!best || score > best.score) best = { rule, dim, v, key, score };
      }
    }
    return best;
  }

  /** 每维在 R1 全历史中的有效概念取值集合（裸值经当前注册表解析；未知档不算有效取值） */
  distinctByDim() {
    const { r1, registry, caps, DIM_NAMES } = this.ctx;
    const m = new Map(DIM_NAMES.map((d) => [d, new Set()]));
    for (const ep of r1.recent()) {
      if (!ep.rawConditions) continue; // 无裸值的历史段（兼容）跳过
      for (const d of DIM_NAMES) {
        const raw = ep.rawConditions[d];
        if (raw === undefined) continue;
        const c = registry.resolve(d, raw) ?? caps[d];
        if (c !== caps[d]) m.get(d).add(c);
      }
    }
    return m;
  }

  /** 收割判决（不重差分，只读 R3 现状——判决本身是 rebuildR3 里 R2B 自动做出的）：
   * 排除 = 变体下结果复现过，且 R3 同簇规则（同动作同结果）因素集已不含该维；
   * 确认 = 变体下结果连续未复现 ≥ CONFIRM_FAILS；
   * 规则消亡（结果签名再也匹配不上）且无复现证据 → 技术存疑；到封顶次数 → 技术存疑。 */
  refreshVerdicts() {
    const { r3 } = this.ctx;
    for (const p of this.pairs.values()) {
      if (p.verdict !== '进行中') continue;
      if (p.consecFail >= CONFIRM_FAILS) { this.settle(p, '确认', `变体下结果连续 ${p.consecFail} 次未复现`); continue; }
      const alive = r3.rules.filter((r) => r.action === p.action && outcomeSig(r) === p.outcomeSig);
      if (p.repro >= 1 && (alive.length === 0 || alive.every((r) => !(p.dim in r.factors)))) {
        this.settle(p, '排除', `变体下结果复现 ${p.repro} 次，重建后该维已不在因素集`);
        continue;
      }
      if (alive.length === 0 && p.repro === 0) { this.settle(p, '技术存疑', '规则在重建中消亡（结果签名漂移），无法判决'); continue; }
      if (p.tries >= CAP_TRIES) this.settle(p, '技术存疑', `${CAP_TRIES} 次实验仍采不到有效变体/无法判决（未采到 ${p.miss} 次）`);
    }
  }

  settle(p, verdict, note) {
    p.verdict = verdict; p.note = note;
    this.writeLedger(p);
    this.ctx.out(`[实验] 判决 ${verdict}：${p.dim}（${p.ruleSig}）——${note}`);
  }

  /** 一次完整实验：干预 → 变体状态下走 step() 执行规则动作 → 如实记账。 */
  async runExperiment(cand) {
    const { st, caps, ACTION_NAMES, out } = this.ctx;
    const { rule, dim, v, key } = cand;
    const p = this.pairs.get(key) ?? {
      key, dim, v, action: rule.action, outcomeSig: outcomeSig(rule), outcomes: { ...rule.outcomes },
      ruleSig: DifferentialExtractor.ruleSig(rule),
      tries: 0, miss: 0, variant: 0, repro: 0, consecFail: 0, verdict: '进行中', note: null,
    };
    p.v = v; p.ruleSig = DifferentialExtractor.ruleSig(rule); // 因素集随证据漂移，签名取最新版
    this.pairs.set(key, p);
    const actName = ACTION_NAMES[rule.action];
    this.current = { ruleSig: p.ruleSig, dim, action: actName, try: p.tries + 1 };
    const phase0 = st.phase; st.phase = 'experiment';
    out(`[实验] 疑点 ${dim}=${v}（${actName} 规则 support=${rule.support}）——第 ${p.tries + 1} 次控制变量干预`);
    let cleanup = null, counted = false;
    try {
      const prep = await this.prepare(dim, v);
      cleanup = prep.cleanup ?? null;
      if (!prep.feasible) { this.settle(p, '技术存疑', prep.note ?? '无可行干预策略'); return; }
      p.tries++; counted = true;
      if (!prep.ok) {
        p.miss++;
        out(`[实验] 第 ${p.tries} 次未采到 ${dim} 变体（累计 ${p.miss} 次），如实记账不硬撑`);
        this.writeLedger(p); this.refreshVerdicts(); return;
      }
      // 实验动作必须走 step()：转移记进 R1，判决靠 R2B 重差分，调度器不私判
      await this.ctx.step(rule.action);
      const ld = st.lastDecision;
      if (!ld || ld.action !== actName) { p.miss++; this.writeLedger(p); this.refreshVerdicts(); return; }
      const got = ld.from[dim] !== v && ld.from[dim] !== caps[dim]; // 条件帧真取到变体（未知档不算有效变体）
      if (!got) {
        p.miss++;
        out(`[实验] 第 ${p.tries} 次：${dim} 仍未采到有效变体（条件帧值=${ld.from[dim]}，瞬态错过/未知档都算未采到）`);
      } else {
        p.variant++;
        const repro = Object.entries(p.outcomes).every(([od, ov]) => ld.to[od] === ov);
        if (repro) {
          p.repro++; p.consecFail = 0;
          out(`[实验] ${dim} 变体 ${v}→${ld.from[dim]} 下结果仍复现（${p.repro} 次）——待下次重建差分排除`);
        } else {
          p.consecFail++;
          out(`[实验] ${dim} 变体 ${v}→${ld.from[dim]} 下结果未复现（连续 ${p.consecFail}/${CONFIRM_FAILS} 次 → 确认）`);
        }
      }
      this.writeLedger(p);
      this.refreshVerdicts(); // step 内若恰触发周期重建，排除判决本轮即落地
    } catch (e) {
      if (!counted) p.tries++;
      p.note = String(e?.message ?? e);
      out(`[实验] 干预异常（记一笔，不硬撑）：${p.note}`);
      this.writeLedger(p); this.refreshVerdicts();
    } finally {
      if (cleanup) { try { cleanup(); } catch { /* 刹车失败无碍，下一帧感知如实反映 */ } }
      st.phase = phase0;
      this.current = null;
    }
  }

  /** 设计干预：想办法让 dim 取一个 ≠v 的有效值。返回 {feasible, ok, cleanup?, note?}：
   * feasible=false → 无策略（直接技术存疑）；ok=true → 可进实验步；
   * ok=false → 策略试过但没采到变体（记一次 miss，不硬撑）。 */
  async prepare(dim, v) {
    const { probe, caps, getBody } = this.ctx;
    const cur = probe();
    if (cur[dim] !== v && cur[dim] !== caps[dim]) return { feasible: true, ok: true }; // 变体自然出现，白捡
    const A = (n) => this.ctx.ACTION_NAMES.indexOf(n);
    switch (dim) {
      case 'onGround': {
        if (v !== 1) return { feasible: false, note: '恒为空中，没有可站立的反面可回' };
        // 瞬态维：onGround=0 窗口 ~0.5s < 决策步 1.2s，正常 step 永远采不到空中帧。
        // 压跳 200ms 后物理确认腾空（顶头/卡住时跳不起来，再试一次），立刻进实验步
        // 让条件感知帧抢在落地前采到（概念未知档接不住也算未采到，不硬撑）。
        const body = getBody();
        for (let k = 0; k < 2; k++) {
          body.bot.setControlState('jump', true); await sleep(200); body.bot.setControlState('jump', false);
          if (body.bot.entity.onGround === false) break; // 物理确认腾空
          await sleep(250); // 落地后重试一次
        }
        return { feasible: true, ok: true };
      }
      case 'speed': {
        if (v !== 0) return { feasible: true, ok: true }; // 恒在移动：静止即变体，无需准备
        // 恒静止：保持前进驱动贯穿实验步——条件帧在移动中采（cleanup 负责刹车）。
        // 血泪教训：裸速度≈0 多半是顶着墙走不动（冒烟实测连采 5 次全落空）——
        // 物理确认真在动，顶墙就转向再来一次；概念未知档不拦（移动帧喂进去概念才会成形）。
        const body = getBody();
        for (let k = 0; k < 2; k++) {
          body.bot.setControlState('forward', true); await sleep(500);
          const vel = body.bot.entity.velocity;
          if (Math.hypot(vel.x, vel.z) > 0.05)
            return { feasible: true, ok: true, cleanup: () => body.bot.setControlState('forward', false) };
          body.bot.setControlState('forward', false);
          await this.ctx.step(A('turnLeft')); // 换向再试（转向也是真实经验，照常入账）
        }
        return { feasible: true, ok: false };
      }
      case 'nearDist': // 前后移动改变面前方块距离（先后撤，不行再前压）
        return { feasible: true, ok: (await this.seek(dim, v, [A('back')], 2)) || (await this.seek(dim, v, [A('forward')], 2)) };
      case 'nearType': // 转向改变面前方块类型（每次 90°，最多转 270°）
        return { feasible: true, ok: await this.seek(dim, v, [A('turnLeft'), A('turnLeft')], 3) };
      case 'belowType': { // 走到别的地面再试：先小步走，走不出就长途导航换场
        let ok = await this.seek(dim, v, [A('forward'), A('forward'), A('turnRight')], 2);
        if (!ok) {
          const body = getBody();
          const pos = body.bot.entity.position, a = this.ctx.rng() * Math.PI * 2;
          await envNavigate(body, pos.x + 8 * Math.cos(a), pos.z + 8 * Math.sin(a), 1.5); // 教师/环境本事，见 envNavigate 注释
          const c = probe();
          ok = c[dim] !== v && c[dim] !== caps[dim];
        }
        return { feasible: true, ok };
      }
      case 'viewWell': // 换视野：掉头 180°，最多两轮
        return { feasible: true, ok: await this.seek(dim, v, [A('turnLeft'), A('turnLeft'), A('turnLeft'), A('turnLeft')], 2) };
      case 'grip': case 'logGrip': {
        if (v === 0) return { feasible: false, note: '空手恒值：具身无作弊，无可靠手段凭空造物，不硬撑' };
        return { feasible: true, ok: await this.seek(dim, v, [A('place')], 2) }; // 放一个方块消耗一件（生存模式扣背包）
      }
      case 'itemDist': case 'itemType': case 'itemBearing': {
        // 掉落物维：附近有掉落物就移动/转身改变关系量；没有就挖一块蹦一个出来
        const move = dim === 'itemBearing' ? [A('turnLeft'), A('turnLeft')] : [A('back')];
        return { feasible: true, ok: (await this.seek(dim, v, move, 2)) || (await this.seek(dim, v, [A('dig')], 2)) };
      }
      default: // 兜底：通用游走试试运气（采不到会走封顶 → 技术存疑）
        return { feasible: true, ok: await this.seek(dim, v, [A('forward'), A('turnRight'), A('forward')], 2) };
    }
  }

  /** 小步策略序列：逐动作走 step()（真实经验照常入账），每步后探测该维是否取到变体 */
  async seek(dim, v, seq, rounds) {
    const { step, probe, caps } = this.ctx;
    for (let r = 0; r < rounds; r++)
      for (const a of seq) {
        await step(a);
        const c = probe();
        if (c[dim] !== v && c[dim] !== caps[dim]) return true;
      }
    return false;
  }

  /** 台账追加：每个（规则签名,维）实验对的每次状态变化落一行（回放可重建裁决史） */
  writeLedger(p) {
    const line = { ruleSig: p.ruleSig, dim: p.dim, verdict: p.verdict, tries: p.tries, ts: new Date().toISOString() };
    if (p.note) line.note = p.note;
    fs.appendFileSync(this.ctx.ledgerPath, JSON.stringify(line) + '\n');
  }

  /** /status 曝光段 */
  summary() {
    let excluded = 0, confirmed = 0, inconclusive = 0;
    for (const p of this.pairs.values()) {
      if (p.verdict === '排除') excluded++;
      else if (p.verdict === '确认') confirmed++;
      else if (p.verdict === '技术存疑') inconclusive++;
    }
    return { tried: this.pairs.size, excluded, confirmed, inconclusive, current: this.current };
  }
}

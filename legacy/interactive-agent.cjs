/**
 * Minecraft 交互式 agent v7：常驻进程，自主活动 + 指令优先 + 断线自愈。
 *
 * 生命周期：
 *   1) 初始覆盖探索（1680 次真实物理实验；期间指令排队，探索完立即执行；
 *      断线重连后续跑——模型在内存里，重连只换 socket）；
 *   2) 自主模式：80% 时间做靶向补强实验，20% 时间自定浅层目标并完成
 *      （规划可被用户指令中断让位）；
 *   3) 用户指令 → Jev 解析 → 值域/平凡目标护栏 + 未映射要求检测 →
 *      目标变体组合搜索（未提到的维度不钉死）→ 全失败时定向复验相关动作再试 →
 *      如实报告（含"做不到"的证据）。
 *
 * 动作表：move 0-4（左右/内外/原地）× handle 0-3（无/挖箱源/放置堆垛/拆除堆垛）。
 * 第一人称 3007，第三人称 3009，固定俯瞰相机 3010（独立进程），指令面板 3008。
 * 所有物理动作经 mc-bench 超时熔断；规划走 planGoalAsync（保活 + 可中断）。
 */
const mineflayer = require("mineflayer");
const { pathfinder } = require("mineflayer-pathfinder");
const viewer = require("prismarine-viewer").mineflayer;
const http = require("http");
const path = require("path");
const fs = require("fs");
const { MC_BOX_SPACE, repairWorld, makeBench, sleep } = require("./mc-bench.cjs");
const { INTERACTIVE_PERCEPTION } = require("./perception-spec.cjs");

const REPO = path.resolve(__dirname, "..", "energy-network-sim");
const url = (p) => "file:///" + p.replace(/\\/g, "/");
const LOG = path.join(__dirname, "interactive.log");
fs.writeFileSync(LOG, "");
const out = (s) => { console.log(s); fs.appendFileSync(LOG, s + "\n"); };
const TOTAL_EXPERIMENTS = 7 * 2 * 2 * 3 * 20; // 1680（状态 84 × 动作 20：5 移动 × 4 操作）

const PAGE = `<!doctype html><meta charset="utf-8"><title>ProtoAgent 指令面板</title>
<body style="font-family:monospace;max-width:780px;margin:2em auto">
<h2>ProtoAgent 指令面板</h2>
<p>第一人称 <a href="http://localhost:3007" target="_blank">3007</a> ｜ 第三人称 <a href="http://localhost:3009" target="_blank">3009</a> ｜ 固定俯瞰 <a href="http://localhost:3010" target="_blank">3010</a>（如画面异常请 Ctrl+F5）</p>
<p style="color:#888">可识别的目标维度：堆垛层数（摞一层/摞两层/清空）、是否拿箱子、位置（最左边/最右边）、通道（内侧/外侧）。
未提到的维度它会自己挑最近的目标变体尝试。没有指令时它自己做实验、自定小目标；指令会插队优先执行。
做不到的事它会先做定向物理复验，仍做不到就如实报告。</p>
<input id="t" style="width:70%;font-size:16px" placeholder="例：把箱子摞起来，摞两层 / 把箱子清空 / 拿个箱子">
<button style="font-size:16px" onclick="send()">下达指令</button>
<pre id="st" style="background:#111;color:#9d9;padding:1em;white-space:pre-wrap;min-height:9em"></pre>
<script>
async function send(){
  const text = document.getElementById("t").value.trim(); if (!text) return;
  const r = await fetch("/instruct", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
  document.getElementById("st").textContent = await r.text();
}
async function poll(){ try { const r = await fetch("/status"); document.getElementById("st").textContent = await r.text(); } catch (e) {} setTimeout(poll, 3000); }
poll();
</script>`;

async function main() {
  const { TransitionMemory } = await import(url(path.join(REPO, "dist/src/planning/transition-memory.js")));
  const { collectTransitions } = await import(url(path.join(REPO, "dist/src/planning/collect.js")));
  const { planGoalAsync } = await import(url(path.join(REPO, "dist/src/planning/planner.js")));
  const { executeGoal } = await import(url(path.join(REPO, "dist/src/planning/execute.js")));
  const { frames } = await import(url(path.join(REPO, "dist/src/planning/space.js")));
  const { JevApiBackend } = await import(url(path.join(REPO, "dist/src/perception/decision-backend.js")));
  const { SceneParser } = await import(url(path.join(REPO, "dist/src/perception/scene-parser.js")));

  const key = process.env.TYPESAFE_API_KEY;
  const jevBackend = key ? new JevApiBackend("https://api.typesafe.ai/v1/systemone", key) : null;
  const parser = jevBackend ? new SceneParser(jevBackend) : null;

  // ── 会话状态 ─────────────────────────────────────────────
  let phase = "boot"; // boot | exploring | autonomous | serving
  let phaseDetail = "";
  let model = null;
  let bot = null;
  let bench = null;
  let online = false;
  let predictCount = 0;
  let exploreCount = 0;
  let extraCount = 0;
  let selfGoalCount = 0;
  let pendingInstruction = null;
  let currentJob = null;
  let autoActivity = "";
  let viewerClosers = [];

  const phaseName = () => ({ boot: "启动中", exploring: "初始自由探索", autonomous: "自主活动", serving: "执行用户指令" }[phase]);
  const statusText = () => {
    const lines = [`阶段：${phaseName()}${phaseDetail ? "（" + phaseDetail + "）" : ""}${online ? "" : "（连接中断，重连中…）"}`];
    if (phase === "exploring") lines.push(`覆盖进度：${Math.min(exploreCount, TOTAL_EXPERIMENTS)}/${TOTAL_EXPERIMENTS} 次实验（此时下达的指令会排队，探索完成后立即执行）`);
    if (phase === "autonomous") lines.push(`正在：${autoActivity}`, `补强实验累计 ${extraCount} 次，自主目标累计 ${selfGoalCount} 个`);
    if (model) lines.push(`模型：${model.mem.ruleCount} 条规则，${model.mem.net.neuronCount} 个神经元`);
    if (pendingInstruction) lines.push(`排队指令：「${pendingInstruction}」`);
    if (currentJob) {
      lines.push(`指令：${currentJob.text}`, `详情：${currentJob.detail}`);
      if (phase === "serving") lines.push(`本次退火预测：${predictCount} 次`);
      if (currentJob.done) lines.push(`结果：${currentJob.result}`);
    }
    return lines.join("\n");
  };

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(PAGE); return; }
    if (req.method === "GET" && req.url === "/status") { res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }); res.end(statusText()); return; }
    if (req.method === "POST" && req.url === "/instruct") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        const text = (JSON.parse(body || "{}").text ?? "").trim();
        if (!text) { res.end("空指令。"); return; }
        if (pendingInstruction || phase === "serving") { res.end("已有指令在执行/排队，完成后再试。\n\n" + statusText()); return; }
        pendingInstruction = text;
        res.end(`已受理：「${text}」\n` + (phase === "exploring" ? "正在初始探索，探索完成后立即执行。" : "将在当前小动作完成后插队（≤1 分钟）。"));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  server.listen(3008);

  // ── bot 生命周期：断线自愈（模型在内存，重连只换 socket）──
  function connect() {
    online = false;
    bot = mineflayer.createBot({ host: "localhost", port: 25565, username: "ProtoAgent", version: "1.20.1" });
    bot.loadPlugin(pathfinder);
    bench = makeBench(bot, { isOnline: () => online });
    bot.once("spawn", async () => {
      online = true;
      bot.chat("/gamemode survival @s");
      repairWorld(bot);
      for (const c of viewerClosers) { try { c(); } catch { /* */ } }
      viewerClosers = [];
      viewer(bot, { port: 3007, firstPerson: true, viewDistance: 6 });
      viewerClosers.push(bot.viewer.close);
      viewer(bot, { port: 3009, firstPerson: false, viewDistance: 6 });
      viewerClosers.push(bot.viewer.close);
      await bot.look(Math.PI / 2, 0.6, true).catch(() => {});
      bot.chat("[ProtoAgent] 已上线");
      out("[系统] bot 已连接");
    });
    bot.once("end", (reason) => {
      online = false;
      out(`[系统] 连接断开（${reason}），3s 后重连`);
      setTimeout(connect, 3000);
    });
    bot.once("error", (e) => { out(`[系统] bot 错误：${e.message}`); }); // end 事件会跟上，由它触发重连
  }
  const waitFor = async (cond) => { while (!cond()) await sleep(500); };

  // ── 用户指令：组合变体搜索 + 失败定向复验；执行不可抢占 ──
  async function serveInstruction(text) {
    phase = "serving";
    const t0 = performance.now();
    currentJob = { text, detail: "Jev 解析中…", done: false, result: "" };
    out(`══ 指令：${text}`);
    try {
      if (!parser) throw new Error("无 TYPESAFE_API_KEY，无法解析中文指令");
      await waitFor(() => online);
      const cur = activeBench.readState();
      const got = await parser.parse(text, INTERACTIVE_PERCEPTION);
      out(`Jev 解析：${JSON.stringify(got.details)}，unknown=${JSON.stringify(got.unknownDims)}`);
      if (!Object.keys(got.frame).length) {
        currentJob.result = "✘ 没听懂：四个目标维度都没映射上，换个说法试试（如：摞两层/清空/拿个箱子/走到最右边）";
        out(currentJob.result);
        return;
      }
      // 任务语义默认：提到堆垛目标时，终点默认在堆垛点旁、空手（未提到的维度仍走变体搜索）
      const semanticDefaults = (got.frame.stack ?? 0) > 0 ? { zone: 6, lane: 1, carry: 0 } : {};
      const goal = { ...cur, ...semanticDefaults, ...got.frame };
      // 值域护栏：超出状态字母表的目标值（如"摞三层"）如实拒绝
      const outOfRange = Object.entries(goal).filter(([d, v]) => {
        const dim = MC_BOX_SPACE.states.find((s) => s.name === d);
        return !dim || v < 0 || v >= dim.bins;
      });
      if (outOfRange.length) {
        currentJob.result = `✘ 目标超出表达能力：${outOfRange.map(([d, v]) => `${d}=${v}`).join(",")}（这个世界 stack 只到 2 层，zone 只到 6）`;
        out(currentJob.result);
        bot.chat("[ProtoAgent] 这个目标超出我的世界表达能力");
        return;
      }
      // 诚实性护栏 2：未映射要求检测（一次额外 Jev 判定；失败不阻塞）
      let warning = "";
      const labelOf = (d, v) => INTERACTIVE_PERCEPTION.dims.find((x) => x.name === d)?.values.find((x) => x.value === v)?.label ?? String(v);
      try {
        const mapped = Object.entries(got.frame).map(([d, v]) => labelOf(d, v)).join("、") || "（无）";
        const cover = await jevBackend.ask(text, { kind: "noul",
          text: `我把这条指令理解成了目标：${mapped}。这条指令里是否还有没被这个目标体现的要求（比如具体位置、具体对象、先后顺序等）？` });
        out(`未映射要求检测：${JSON.stringify(cover)}`);
        if (cover.value && cover.confidence >= 0.2) warning = " ⚠ Jev 认为指令里还有没被体现的要求——结果可能不符合预期，请对照目标帧";
      } catch { /* 检测失败不阻塞 */ }
      // 未提到的维度 = "无所谓"：生成目标变体（按离现状最近排序，上限 8 个），逐个尝试直到可达
      const fixedDims = new Set([...Object.keys(got.frame), ...Object.keys(semanticDefaults)]);
      const freeDims = MC_BOX_SPACE.states.filter((d) => !fixedDims.has(d.name));
      let combos = [{}];
      for (const d of freeDims) combos = combos.flatMap((c) => Array.from({ length: d.bins }, (_, v) => ({ ...c, [d.name]: v })));
      const dist = (g) => freeDims.reduce((n, d) => n + (g[d.name] !== cur[d.name] ? 1 : 0), 0);
      const variants = combos.map((c) => ({ ...goal, ...c })).sort((a, b) => dist(a) - dist(b))
        .filter((g) => JSON.stringify(g) !== JSON.stringify(cur)).slice(0, 4); // 上限 4 个变体
      out(`目标：${JSON.stringify(goal)}（变体 ${variants.length} 个）${warning}`);
      bot.chat("[ProtoAgent] 收到目标，规划中（直播保持流畅，画面每几秒更新）");
      let exec = null, usedGoal = null;
      const attempts = [];
      let consecutiveFullFails = 0;
      for (const [i, g] of variants.entries()) {
        if (consecutiveFullFails >= 2) { out(`变体早停：连续 2 个满预算失败，剩余变体结构性不可达（失败在固定维，不在自由维）`); break; }
        currentJob.detail = `尝试目标变体 ${i + 1}/${variants.length}：${JSON.stringify(g)}（规划中…）`;
        await waitFor(() => online);
        predictCount = 0;
        exec = await executeGoal(model, activeBench, cur, g, 1, { planFn: planGoalAsync });
        const st = exec.plans[0]?.status ?? "?";
        attempts.push(`${JSON.stringify(g)} → ${st}${exec.reached ? "/到达" : ""}`);
        out(`变体 ${i + 1}：${JSON.stringify(g)} → ${st}${exec.reached ? "/到达" : ""}`);
        if (exec.reached || st === "found") { usedGoal = g; break; }
        consecutiveFullFails = (st === "no-known-route" || st === "prediction-budget") ? consecutiveFullFails + 1 : 0;
      }
      // 定向复验：所有变体都没路时，对能影响目标维度的动作做一轮真实物理实验，再试一轮——
      // 做不到就去探索尝试，而不是报不可达后停止
      let reverifyNote = "";
      if (!usedGoal) {
        const goalDims = new Set(Object.keys(got.frame));
        const relevant = model.actions.filter((a) =>
          ((goalDims.has("stack") || goalDims.has("carry")) && a.values.handle !== 0) ||
          ((goalDims.has("zone") || goalDims.has("lane")) && a.values.move !== 4));
        const pairs = [];
        for (const s of frames(MC_BOX_SPACE.states)) for (const a of relevant) pairs.push([s, a]);
        pairs.sort((p1, p2) => Math.abs(p1[0].zone - cur.zone) - Math.abs(p2[0].zone - cur.zone));
        const capped = pairs.slice(0, 80);
        bot.chat(`[ProtoAgent] 模型里没路——开始定向复验（${capped.length} 次真实实验）`);
        currentJob.detail = `模型无路线，定向复验 ${capped.length} 次实验中…`;
        let n = 0;
        for (const [s, a] of capped) {
          await waitFor(() => online);
          const outcomes = await activeBench.conduct(s, a.values);
          model.observe(s, a, outcomes);
          if (++n % 20 === 0) out(`[复验] ${n}/${capped.length}`);
        }
        reverifyNote = `（中途定向复验了 ${n} 次相关实验）`;
        for (const g of variants) {
          await waitFor(() => online);
          exec = await executeGoal(model, activeBench, cur, g, 1, { planFn: planGoalAsync });
          if (exec.reached || exec.plans[0]?.status === "found") { usedGoal = g; break; }
        }
      }
      const secs = ((performance.now() - t0) / 1000).toFixed(0);
      if (usedGoal) {
        const plan0 = exec.plans[0];
        const changedNote = JSON.stringify(usedGoal) !== JSON.stringify(goal) ? `（实际达成的是变体 ${JSON.stringify(usedGoal)}）` : "";
        currentJob.result = `${exec.reached ? "✔ 到达目标" : "✘ 执行偏离"}（终止：${exec.terminationReason}，规划 ${plan0.status}/${plan0.steps.length} 步，执行 ${exec.steps.length} 步，重规划 ${exec.replans.length} 次，耗时 ${secs}s）${changedNote}${reverifyNote}${warning}`;
        currentJob.detail = `最终状态 ${JSON.stringify(exec.finalState)}`;
      } else {
        currentJob.result = `✘ 做不到：模型中无路线${reverifyNote ? "，定向复验后仍无路线" : ""}（尝试变体 ${attempts.length} 个，耗时 ${secs}s）${warning}——我现有的动作确实做不到这件事`;
        currentJob.detail = `变体尝试：${attempts.join("；")}`;
      }
      out(`执行：${currentJob.result} ${currentJob.detail}`);
      bot.chat(`[ProtoAgent] ${usedGoal ? (exec.reached ? "完成！" : "试了但没完全到达") : "做不到——试过探索复验仍无路线"}`);
    } catch (e) {
      currentJob.result = `✘ 执行出错：${e.message}`;
      out(currentJob.result);
    } finally {
      currentJob.done = true;
      phase = "autonomous";
    }
  }

  // ── 自主活动单元：每个单元都短，间隙检查指令队列；单元内容错（断线续跑）──
  const allQueries = () => frames(MC_BOX_SPACE.states).flatMap((state) => model.actions.map((action) => ({ state, action })));
  let rngState = 12345;
  const rng = () => { rngState = (rngState * 1664525 + 1013904223) >>> 0; return rngState / 4294967296; };

  async function targetedExperiment(queries) {
    const q = queries[Math.floor(rng() * queries.length)];
    autoActivity = `补强实验：在 ${JSON.stringify(q.state)} 试 ${JSON.stringify(q.action.values)}`;
    const outcomes = await activeBench.conduct(q.state, q.action.values);
    model.observe(q.state, q.action, outcomes);
    extraCount++;
    if (extraCount % 25 === 0) out(`[自主] 补强实验累计 ${extraCount} 次`);
  }

  async function shallowSelfGoal() {
    const cur = activeBench.readState();
    const roll = rng();
    const goal = { ...cur };
    if (roll < 0.4) goal.zone = Math.max(0, Math.min(6, cur.zone + (rng() < 0.5 ? -1 : 1) * (1 + Math.floor(rng() * 2))));
    else if (roll < 0.6) goal.lane = 1 - cur.lane;
    else if (roll < 0.8) goal.carry = 1 - cur.carry;
    else goal.stack = Math.max(0, Math.min(2, cur.stack + (rng() < 0.5 ? -1 : 1)));
    if (JSON.stringify(goal) === JSON.stringify(cur)) return;
    selfGoalCount++;
    autoActivity = `自主目标：从 ${JSON.stringify(cur)} 到 ${JSON.stringify(goal)}`;
    bot.chat(`[ProtoAgent] 我自己试试：${autoActivity.slice(5)}`);
    const plan = await planGoalAsync(model, cur, goal, (1000 + selfGoalCount) >>> 0, { shouldAbort: () => !!pendingInstruction });
    if (plan.status === "interrupted") { autoActivity += " → 用户指令到来，规划让位"; return; }
    if (plan.status !== "found") { autoActivity += ` → 没找到路（${plan.status}），换下一个`; return; }
    // 手动逐步执行（每步间隙可被指令抢占；自主目标不做重规划，走偏就放弃这次）
    let reached = false;
    for (const step of plan.steps) {
      if (pendingInstruction) { autoActivity += " → 用户指令到来，主动中断"; return; }
      await waitFor(() => online);
      const outcomes = await activeBench.conduct(cur, step.action.values);
      model.observe(cur, step.action, outcomes);
      for (const d of MC_BOX_SPACE.states) cur[d.name] = outcomes[d.outcome]; // 用真实读出推进状态
      if (JSON.stringify(cur) === JSON.stringify(goal)) { reached = true; break; }
    }
    // 如实报告：到达才算完成
    if (reached) out(`[自主] 目标 ${JSON.stringify(goal)} 到达（第 ${selfGoalCount} 个）`);
    else out(`[自主] 目标 ${JSON.stringify(goal)} 未到达（走完 ${plan.steps.length} 步停在 ${JSON.stringify(cur)}，观测已并入经验）`);
  }

  // ── 主流程 ─────────────────────────────────────────────
  connect();
  out("[系统] 直播：3007（第一人称）/ 3009（第三人称）｜ 指令面板：http://localhost:3008");
  await waitFor(() => online);

  phase = "exploring";
  model = new TransitionMemory(MC_BOX_SPACE);
  const origPredict = model.predict.bind(model);
  model.predict = (s, a, seed) => {
    const t = performance.now();
    const r = origPredict(s, a, seed);
    const ms = performance.now() - t;
    predictCount++;
    if (ms > 5000) fs.writeSync(1, `  [慢预测] ${ms.toFixed(0)}ms（非收敛退火，事件循环被堵的真实时长）\n`);
    else if (predictCount % 20 === 0) fs.writeSync(1, `  [predict] ${predictCount} 次\n`);
    return r;
  };
  // 动态转发代理：重连后 bench 重建，所有调用始终走当前 bench（executeGoal 等长任务也安全）
  const activeBench = {
    readState: (...args) => bench.readState(...args),
    async conduct(s, a) {
      if (phase === "exploring") {
        exploreCount++;
        if (exploreCount % 25 === 0) fs.writeSync(1, `  [探索] ${Math.min(exploreCount, TOTAL_EXPERIMENTS)}/${TOTAL_EXPERIMENTS}\n`);
        if (exploreCount % 100 === 0) out(`[探索] ${Math.min(exploreCount, TOTAL_EXPERIMENTS)}/${TOTAL_EXPERIMENTS}`);
      }
      return bench.conduct(s, a);
    },
  };
  const t0 = performance.now();
  // 经验回放持久化：探索结束后存 episodes（纯数据）；下次启动用回放台重放观察，
  // 确定性学习得到同一模型，分钟级重建，免 1 小时物理探索。FORCE_EXPLORE=1 强制重新探索。
  const EPISODES_FILE = path.join(__dirname, "exploration-episodes.json");
  const spaceSig = `${MC_BOX_SPACE.states.map((d) => d.bins).join("x")}|${MC_BOX_SPACE.actions.map((d) => d.bins).join("x")}`;
  let collection = null;
  if (!process.env.FORCE_EXPLORE && fs.existsSync(EPISODES_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(EPISODES_FILE, "utf8"));
      if (saved.spaceSig === spaceSig && saved.episodes?.length >= TOTAL_EXPERIMENTS) {
        phaseDetail = "回放经验存档重建模型中";
        out(`[系统] 发现经验存档 ${saved.episodes.length} 条（${saved.savedAt}），回放重建模型…`);
        const table = new Map(saved.episodes.map((e) => [JSON.stringify([e.conditions.zone, e.conditions.lane, e.conditions.carry, e.conditions.stack, e.conditions.move, e.conditions.handle]), e.outcomes]));
        const replayBench = { async conduct(state, action) {
          const o = table.get(JSON.stringify([state.zone, state.lane, state.carry, state.stack, action.move, action.handle]));
          if (!o) throw new Error("回放缺集：" + JSON.stringify([state, action]));
          return { ...o };
        } };
        collection = await collectTransitions(model, replayBench, TOTAL_EXPERIMENTS, 1);
        out(`[系统] 回放完成：${model.mem.ruleCount} 条规则（存档时 ${saved.ruleCount}），耗时 ${((performance.now() - t0) / 1000).toFixed(0)}s`);
      }
    } catch (e) { out(`[系统] 经验存档读取失败（${e.message}），改为物理探索`); collection = null; }
  }
  if (!collection) {
    bot.chat("[ProtoAgent] 开始自由探索（指令会排队，探索完立即执行）");
    for (;;) { // 断线中断后整个收集续跑（观察是累积的，重复采样只加深证据）
      try { collection = await collectTransitions(model, activeBench, TOTAL_EXPERIMENTS, 1); break; }
      catch (e) { out(`[系统] 探索中断（${e.message}），待连接恢复后续跑`); await waitFor(() => online); }
    }
    fs.writeFileSync(EPISODES_FILE, JSON.stringify({ spaceSig, savedAt: new Date().toISOString(), ruleCount: model.mem.ruleCount, episodes: collection.episodes }) + "\n");
    out(`探索完成：${model.mem.ruleCount} 条规则，${model.mem.net.neuronCount} 神经元，耗时 ${((performance.now() - t0) / 60000).toFixed(0)}min（经验已存盘）`);
  }
  bot.chat("[ProtoAgent] 探索完成，进入自主模式");
  phase = "autonomous";

  const queries = allQueries();
  for (;;) {
    if (pendingInstruction) {
      const text = pendingInstruction;
      pendingInstruction = null;
      await serveInstruction(text);
      continue;
    }
    try {
      if (rng() < 0.8) await targetedExperiment(queries);
      else await shallowSelfGoal();
    } catch (e) {
      out(`[系统] 自主活动中断（${e.message}），待连接恢复后继续`);
      await waitFor(() => online);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

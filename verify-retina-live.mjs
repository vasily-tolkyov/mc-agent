/** 视网膜实机验收（runs/retina-live.json）：
 * 1. 环绕学习 3 个标本（原木柱/石头地/木板柱），教师赋标签；
 * 2. 从未用过的距离+角度注视 → 应认出对应标签（泛化）；
 * 3. 陌生金块（从未学习）→ 应如实报未识别；
 * 4. 半幅线索补全 + 学过/陌生的 settle 能耗对比；
 * 5. 各环节耗时统计（回答性能问题）。
 * 全程真实物理（pathfinder 走动 + lookAt），无作弊指令。
 * 前提：127.0.0.1:25567 超平坦训练场在跑。运行：node verify-retina-live.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createBody } from './mind/body.mjs';
import { RetinaStream, retinaGrid, MATERIALS } from './mind/retina.mjs';

// 先修复训练场地形（历次课程挖掘留下的坑会卡住寻路——v4 实测 z=-2.3 反复卡死）
execFileSync(process.execPath, [path.join(path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))), 'build-flat-map.cjs')], { stdio: 'inherit' });

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
const report = { startedAt: new Date().toISOString(), learning: [], tests: [], timing: {}, notes: [] };
const out = (s) => { console.log(s); };
const gridText = (g) => { // 8×8 网格转可读字符画
  const glyphs = ['·', 'g', 'd', 'S', 'W', 'P', 's', '~', '*', '?'];
  let lines = [];
  for (let r = 0; r < 8; r++) lines.push([...g.slice(r * 8, r * 8 + 8)].map((v) => glyphs[v]).join(''));
  return lines.join('\n');
};

const body = createBody({ username: `RT${Date.now() % 100000}` }); // 每run新身份：服务器按玩家名存位置，重名会在上次掉线处复活（v9 漂流事故教训）
await body.ready;
out('[系统] 测试 bot 已连接');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const retina = new RetinaStream({});
let tGrid = 0, nGrid = 0, tObs = 0, nObs = 0;
const grid = () => { const t = performance.now(); const g = retinaGrid(body.bot); tGrid += performance.now() - t; nGrid++; return g; };
const observe = (g) => { const t = performance.now(); const r = retina.observe(g); tObs += performance.now() - t; nObs++; return r; };

/** 直视行走导航（测试专用）：超平坦训练场不需要 pathfinder——面向目标直走，
 * 停滞就跳、再停滞就左右平移绕障。
 * 两个教训：① pathfinder 在标本带边界确定性卡死（v6/v7/v8 同点复现）；
 * ② 本环境视线与行走的 yaw 约定相差 z 镜像（看：dz=+cos(yaw)，走：dz=−cos(yaw)，
 * 探针实证）——行走转向必须看向镜像点 2·p.z−z。 */
async function gotoR(x, z, tol = 1.2) {
  const bot = body.bot;
  let side = 0;
  for (let i = 0; i < 50; i++) {
    const p = bot.entity.position;
    const d = Math.hypot(x - p.x, z - p.z);
    if (d <= tol) { bot.setControlState('forward', false); return true; }
    await body.lookAt(x, p.y, 2 * p.z - z); // 镜像 z（本环境行走约定）
    bot.setControlState('forward', true);
    await sleep(350);
    const p2 = bot.entity.position;
    if (Math.hypot(p2.x - p.x, p2.z - p.z) < 0.12) { // 停滞
      bot.setControlState('jump', true);
      await sleep(300);
      bot.setControlState('jump', false);
      if (++side >= 2) { // 连跳两次没出来 → 平移绕障（同样镜像）
        bot.setControlState('forward', false);
        await body.lookAt(p.x + Math.sin(i), p.y, p.z - Math.cos(i));
        bot.setControlState('forward', true);
        await sleep(500);
        side = 0;
      }
    }
  }
  bot.setControlState('forward', false);
  const p = bot.entity.position;
  out(`[到位校验] 未到达 (${x.toFixed(1)},${z.toFixed(1)})，当前 (${p.x.toFixed(1)},${p.z.toFixed(1)})（如实记录）`);
  return false;
}

/** 环绕标本 4 个视角注视学习，然后用真实命中名赋标签 */
async function learnSite(name, tx, tz, lookY, label) {
  const t0 = performance.now();
  let devSum = 0;
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + 0.4;
    await gotoR(tx + 3.4 * Math.cos(a), tz + 3.4 * Math.sin(a), 0.8);
    await body.lookAt(tx, lookY, tz);
    for (let r = 0; r < 3; r++) devSum += observe(grid());
  }
  const tagged = retina.labelCurrent(grid(), label);
  report.learning.push({ site: name, label, avgDeviants: +(devSum / 12).toFixed(1), tagged, secs: +((performance.now() - t0) / 1000).toFixed(1) });
  out(`[学习] ${name} → ${tagged ? `井#${tagged.stableIndex}（成员 ${tagged.members}，能量 ${tagged.energy.toFixed(1)}）` : '未登记（偏离格不足）'}`);
  out(gridText(grid()).split('\n').map((l) => '    ' + l).join('\n'));
}

/** 新视角识别测试 */
async function testView(name, tx, tz, lookY, r, a, expect) {
  await gotoR(tx + r * Math.cos(a), tz + r * Math.sin(a), 0.9);
  await body.lookAt(tx, lookY, tz);
  const rec = retina.recognize(grid());
  const got = rec.label ?? (rec.ambiguous ? '未识别(竞争)' : '未识别');
  const ok = expect === null ? rec.stableIndex === null : rec.label === expect;
  report.tests.push({ name, expect, got, ratio: rec.ratio, energy: +rec.energy.toFixed(1), deviants: rec.deviants, ms: +rec.ms.toFixed(1), hits: rec.hits, ok });
  out(`[测试] ${name}：期望 ${expect ?? '未识别'}，读出 ${got}（激活率 ${rec.ratio.toFixed(2)}，能量 ${rec.energy.toFixed(1)}，偏离格 ${rec.deviants}，${rec.ms.toFixed(0)}ms）${ok ? ' ✓' : ' ✗'}`);
  out(gridText(grid()).split('\n').map((l) => '    ' + l).join('\n'));
  return rec;
}

try {
  out('── 0. 视网膜校准（20 帧环顾+俯仰变化，攒基线统计，不供能）──');
  for (let k = 0; k < 20; k++) {
    const a = (k / 10) * Math.PI * 2;
    const y = k % 10 < 5 ? -60.5 : (k < 10 ? -59.5 : -55); // 俯视草地 / 平视 / 仰视天空
    await body.lookAt(Math.cos(a) * 10, y, Math.sin(a) * 10);
    observe(grid());
  }
  out(`校准完成，已观察 ${retina.observations} 帧，文档 ${retina.frameCount} 个`);

  out('\n── 1. 环绕学习 ──');
  await learnSite('原木柱', 0.5, -10, -59, '原木柱');
  await learnSite('石头地', -9, 0, -59.5, '石头地');
  await learnSite('木板柱', -12, 6, -59.3, '木板柱');
  report.df = retina.dfReport();
  out(`[稀罕度] ${report.df.map((r) => `${r.name}=${r.df}`).join(' ')}`);

  out('\n── 2. 新视角泛化（训练没用过这些距离/角度）──');
  await testView('原木@r=5.0,a=2.9', 0.5, -10, -59, 5.0, 2.9, '原木柱');
  await testView('原木@r=2.6,a=5.9', 0.5, -10, -59, 2.6, 5.9, '原木柱');
  await testView('石头@r=4.6,a=5.0', -9, 0, -59.5, 4.6, 5.0, '石头地');
  await testView('木板@r=3.6,a=2.0', -12, 6, -59.3, 3.6, 2.0, '木板柱');

  out('\n── 3. 陌生对照（金块从未学习）──');
  await testView('金块@r=3.4,a=0.4', 4, 12, -59.5, 3.4, 0.4, null);

  out('\n── 4. 半幅线索补全（只给偏离格的上半幅）──');
  await gotoR(0.5 + 4.0 * Math.cos(1.0), -10 + 4.0 * Math.sin(1.0), 0.9);
  await body.lookAt(0.5, -59, -10);
  const g = grid();
  const dev = retina.deviantCells(g);
  const half = dev.filter((c) => Math.floor(c / 8) < 4);
  const well = retina.wells.find((w) => w.label === '原木柱'); // 按标签找井，不赌下标
  if (!well) {
    report.completion = { error: '原木柱井未登记' };
    out('原木柱井未登记，补全测试跳过');
  } else {
    const settledHalf = retina.formation.net.settle(retina.encodeCells(g, half));
    const hitN = well.memberNeuronIds.filter((id) => settledHalf.activeNeurons.includes(id)).length;
    const completion = hitN / well.memberNeuronIds.length;
    report.completion = { cueCells: half.length, totalDeviants: dev.length, completionRate: +completion.toFixed(3), energy: +settledHalf.energy.toFixed(1) };
    out(`半幅线索（${half.length}/${dev.length} 偏离格）→ 原木井补全率 ${(completion * 100).toFixed(0)}%，能量 ${settledHalf.energy.toFixed(1)}`);
  }

  report.timing = {
    retinaGridMs: +(tGrid / nGrid).toFixed(2),
    observeMs: +(tObs / Math.max(1, nObs)).toFixed(2),
    grids: nGrid, observes: nObs, wells: retina.wells.length,
  };
  const passed = report.tests.filter((t) => t.ok).length;
  report.verdict = `${passed}/${report.tests.length} 通过`;
  out(`\n[耗时] 网格采样 ${report.timing.retinaGridMs}ms/次，学习 ${report.timing.observeMs}ms/次，井 ${retina.wells.length} 口`);
  out(`[结论] ${report.verdict}`);
} finally {
  fs.mkdirSync(path.join(ROOT, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'runs', 'retina-live.json'), JSON.stringify(report, null, 1));
  await body.quit();
  setTimeout(() => process.exit(0), 500);
}

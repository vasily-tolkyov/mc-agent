import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';

const ENS = process.env.ENS_PATH ?? fileURLToPath(new URL('../energy-network-sim', import.meta.url)); // 同级克隆 energy-network-sim，或用 ENS_PATH 指定
const { SensoryEncoder } = await import(pathToFileURL(ENS + '/dist/src/pop/concept/sensory.js').href);
const { ConceptFormation } = await import(pathToFileURL(ENS + '/dist/src/pop/concept/formation.js').href);
const { EmergentMap } = await import(pathToFileURL(ENS + '/dist/src/pop/concept/emergent-map.js').href);

/** 概念自形成层（接在自我中心包装器之后）：真实感知流 → 共现成阱 → 概念通道回注核心。
 * 概念输入 = 自我中心通道（最近表面距离/方向/颜色/尺寸 + 手持量），全部是真实观察派生。
 * 回注通道 concept_<dim> = 当前帧在该维落在哪个自形成概念（索引整数，未知=概念数）——
 * 名固定、值为有限标量，符合核心感受器契约与快照锁。状态面板：http://127.0.0.1:3011 */
const CONT = (name, min, max) => ({ name, min, max });
const DIMS = [
  CONT('nearDist', 0, 8),
  CONT('nearDirX', -3, 3), CONT('nearDirZ', -3, 3),
  CONT('nearRed', 0, 1), CONT('nearGreen', 0, 1), CONT('nearBlue', 0, 1),
  CONT('nearExtent', 0, 16),
  CONT('gripCount', 0, 8),
];
const NAMES = DIMS.map(d => d.name);

export function wrapConcept(base, { port = 3011, refreshEvery = 100, debugEvery = 400 } = {}) {
  const enc = new SensoryEncoder(DIMS, 40);
  const formation = new ConceptFormation(enc);
  let em = null, concepts = [], frames = 0;
  let lastFrame = null, lastResolved = null;

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    const lines = [`概念层状态（kairos 线）：已采 ${frames} 帧，自形成概念 ${concepts.length} 个`];
    for (const c of concepts)
      lines.push(`  概念#${c.conceptId} 维度=${c.dimension} 中心=${c.centerValue.toFixed(3)} 成员=${c.memberNeuronIds.length} 内强度=${c.meanInternalWeight.toFixed(3)}`);
    if (lastFrame) lines.push('', `最近一帧：${JSON.stringify(lastFrame)}`, `最近概念解析：${JSON.stringify(lastResolved)}`);
    res.end(lines.join('\n'));
  });
  server.listen(port, '127.0.0.1');

  return {
    maintenanceGoals: base.maintenanceGoals,
    drainPassiveEvents: (...a) => base.drainPassiveEvents(...a),
    listActionOffers: (...a) => base.listActionOffers(...a),
    waitForObservationAfter: (...a) => base.waitForObservationAfter(...a),
    executeOffer: (...a) => base.executeOffer(...a),
    async observe() {
      const obs = await base.observe();
      try {
        const props = obs?.self?.properties;
        // 自我中心通道缺失 = 这一帧没有可见对象——如实跳过，不拿默认值污染成阱
        if (props && typeof props.nearDist === 'number') {
          const norm = (v) => (v > 1.5 ? v / 255 : v); // 颜色量程防御（0..1 或 0..255 自适应）
          const frame = {
            nearDist: props.nearDist, nearDirX: props.nearDirX ?? 0, nearDirZ: props.nearDirZ ?? 0,
            nearRed: norm(props.nearRed ?? 0), nearGreen: norm(props.nearGreen ?? 0), nearBlue: norm(props.nearBlue ?? 0),
            nearExtent: props.nearExtent ?? 0, gripCount: props.gripCount ?? 0,
          };
          formation.presentExperiment(frame, 4);
          lastFrame = frame;
          if (++frames % refreshEvery === 0) { concepts = formation.extractConcepts(0.5); em = new EmergentMap(concepts, enc); }
          if (em) {
            const resolved = {};
            for (const dim of NAMES) {
              const idx = em.resolve(dim, frame[dim]);
              const bin = idx ?? em.conceptCount(dim); // 未知档 = 概念数
              props[`concept_${dim}`] = bin;
              resolved[dim] = bin;
            }
            lastResolved = resolved;
          }
          if (frames % debugEvery === 0) process.stderr.write(`  [concept] frames=${frames} concepts=${concepts.length}\n`);
        }
      } catch { /* 派生失败不阻塞主循环 */ }
      return obs;
    },
  };
}

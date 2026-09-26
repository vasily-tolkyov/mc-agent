import { worldToBody } from '../kairos-v5-predictive-agent/dist/src/perception.js';

/** 自我中心关系通道包装器：在适配层观察上就地注入派生标量（不改 kairos 核心、不破坏快照锁）。
 * 注入量（核心的学习输入会自动把它们收为 self/<name> 感受器）：
 * - egoDeltaX/Y/Z：相邻观察帧位移——关系量（"位置 +N"而非"位置=5.3"），规则可迁移的表示基础
 * - nearDist/nearDirX/Y/Z：最近感知表面的体帧距离与方向（"面前的方块离我 1.2 格"）
 * - nearRed/Green/Blue/Extent：最近表面的颜色与尺寸（概念区分的感官原料）
 * 一切派生自真实观察帧本身，符合"经验必须来自真实感知/动作窗口"的约束。 */
export function wrapEgocentric(base, { debugEvery = 200 } = {}) {
  let last = null, frames = 0;
  // 类方法在原型链上，不能用展开拷贝——显式透传并保持 this 绑定
  return {
    maintenanceGoals: base.maintenanceGoals,
    drainPassiveEvents: (...a) => base.drainPassiveEvents(...a),
    listActionOffers: (...a) => base.listActionOffers(...a),
    waitForObservationAfter: (...a) => base.waitForObservationAfter(...a),
    executeOffer: (...a) => base.executeOffer(...a),
    async observe() {
      const obs = await base.observe();
      try {
        const props = obs?.self?.properties, p = obs?.self?.position;
        if (props && Array.isArray(p)) {
          if (last) {
            props.egoDeltaX = p[0] - last[0];
            props.egoDeltaY = p[1] - last[1];
            props.egoDeltaZ = p[2] - last[2];
          }
          last = [...p];
          let best = null, bestD = Infinity;
          for (const o of obs.objects ?? []) {
            const rp = o.relativePosition;
            if (!Array.isArray(rp)) continue;
            const d = Math.hypot(rp[0], rp[1], rp[2]);
            if (d < bestD) { bestD = d; best = o; }
          }
          if (best) {
            const [dx, dy, dz] = worldToBody(best.relativePosition, obs.self.yaw);
            props.nearDist = bestD; props.nearDirX = dx; props.nearDirY = dy; props.nearDirZ = dz;
            const bp = best.properties ?? {};
            for (const [src, dst] of [["red", "nearRed"], ["green", "nearGreen"], ["blue", "nearBlue"], ["extent", "nearExtent"]])
              if (typeof bp[src] === "number") props[dst] = bp[src];
          }
          if (++frames % debugEvery === 0)
            process.stderr.write(`  [ego] frames=${frames} nearDist=${props.nearDist?.toFixed(2) ?? "-"} dir=(${props.nearDirX?.toFixed(2)},${props.nearDirZ?.toFixed(2)}) d=(${props.egoDeltaX?.toFixed(2)},${props.egoDeltaZ?.toFixed(2)})\n`);
        }
      } catch { /* 派生失败不阻塞主循环 */ }
      return obs;
    },
  };
}

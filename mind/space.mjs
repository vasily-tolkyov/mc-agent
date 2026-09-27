/** 空间层（果蝇中央复合体的基序实现，不用原图——原图 bump 位置不可控已两轮实证）：
 *
 * 1) CompassRing 罗盘环：64 神经元环形吸引子（局部高斯兴奋 + 全局抑制 + 慢电流，
 *    果蝇 EPG/PEN/Delta7 的电路基序）。bump 位置 = 航向角，自维持不灭；
 *    转头动作按角度注入单侧驱动 → bump 平移（角速度→航向的积分器）。
 * 2) PathIntegrator 路径积分器：由动作原语驱动的位置向量（x,z）积分——
 *    纯自身运动积分（不读世界坐标），会漂移，如实接受；
 *    地标重校准：重新认出已知点时将积分器吸附回该点（动物消漂移的标准机制）。
 * 3) 空间维输出：goalBearing（相对目标地标的方位，9 扇区）、goalDist（距离档）。
 *
 * 果蝇对应：罗盘环=EPG bump，路径积分=航向×速度累加，重校准=地标修正路径积分。
 */
const RING_N = 64;
const TAU = Math.PI * 2;

export class CompassRing {
  constructor({ localSigma = 2.0, exc = 1.2, inh = 0.55, leak = 0.88, slowGain = 1.0 } = {}) {
    this.n = RING_N;
    this.exc = exc; this.inh = inh; this.leak = leak; this.slowGain = slowGain;
    // 环形局部高斯耦合（i 对 j 的兴奋随环距高斯衰减）+ 均匀全局抑制
    this.W = new Float64Array(RING_N * RING_N);
    for (let i = 0; i < RING_N; i++) {
      for (let j = 0; j < RING_N; j++) {
        const d = Math.min((i - j + RING_N) % RING_N, (j - i + RING_N) % RING_N);
        this.W[i * RING_N + j] = exc * Math.exp(-(d * d) / (2 * localSigma * localSigma)) - inh;
      }
    }
    this.a = new Float64Array(RING_N);   // 快活动
    this.s = new Float64Array(RING_N);   // 慢电流（驻留支撑）
  }

  /** 注入驱动（center 为环位，strength 为强度） */
  drive(center, strength) {
    for (let i = 0; i < RING_N; i++) {
      const d = Math.min((i - center + RING_N) % RING_N, (center - i + RING_N) % RING_N);
      this.a[i] += strength * Math.exp(-(d * d) / 8.0);
    }
  }

  /** 推进若干步动力学；返回 bump 中心（环位 0..63），无 bump 时 -1 */
  step(k = 4) {
    // NaN 绊线（实测环被污染 ringPos=NaN 的根因追查）：活动出现非有限即记录并修复
    if (this.a.some((v) => !Number.isFinite(v)) || this.s.some((v) => !Number.isFinite(v))) {
      if (!this._nanLog) {
        this._nanLog = true;
        console.error(`[ring-nan] 环活动非有限：aFinite=${[...this.a].filter(Number.isFinite).length}/64 sFinite=${[...this.s].filter(Number.isFinite).length}/64 lastShift=${this._lastShift ?? 'none'}`);
      }
      for (let i = 0; i < RING_N; i++) {
        if (!Number.isFinite(this.a[i])) this.a[i] = 0;
        if (!Number.isFinite(this.s[i])) this.s[i] = 0;
      }
    }
    for (let t = 0; t < k; t++) {
      const prev = this.a;
      const next = new Float64Array(RING_N);
      let total = 0;
      for (let i = 0; i < RING_N; i++) total += Math.max(0, prev[i]);
      const mean = total / RING_N;
      for (let i = 0; i < RING_N; i++) {
        let h = this.s[i] * this.slowGain;
        for (let j = 0; j < RING_N; j++) h += this.W[i * RING_N + j] * Math.max(0, prev[j]);
        h -= mean * this.inh * 0.5; // 活动越强全场越压（均场 WTA，单 bump 保证）
        next[i] = Math.max(0, this.leak * prev[i] + h);
      }
      for (let i = 0; i < RING_N; i++) this.s[i] = this.s[i] * 0.92 + next[i] * 0.08;
      this.a = next;
    }
    // bump 质心（圆统计）
    let x = 0, y = 0, m = 0;
    for (let i = 0; i < RING_N; i++) {
      const v = Math.max(0, this.a[i]);
      x += v * Math.cos((i / RING_N) * TAU);
      y += v * Math.sin((i / RING_N) * TAU);
      m += v;
    }
    if (m < 1e-6) return -1;
    const ang = Math.atan2(y, x);
    return ((ang / TAU) * RING_N + RING_N) % RING_N;
  }

  /** 初始化 bump 到指定环位 */
  ignite(center) { this.drive(center, 2.0); this.step(20); }

  /** 转头积分：把 bump（连同快/慢两层活动）按角度在环上旋转——
   * 慢电流负责驻留，旋转负责移动（只注入驱动拖不动慢场锚定的 bump，两轮实测）。
   * 亚环位余数累积进位，角度积分不丢分数部分。 */
  shift(dAngle) {
    this._shiftRemainder = (this._shiftRemainder ?? 0) + (dAngle / TAU) * RING_N;
    const k = Math.trunc(this._shiftRemainder);
    if (k === 0) { this.step(2); return; }
    this._shiftRemainder -= k;
    const rot = (arr) => {
      const out = new Float64Array(RING_N);
      for (let i = 0; i < RING_N; i++) out[i] = arr[((i - k) % RING_N + RING_N) % RING_N];
      return out;
    };
    this._lastShift = `k=${k} rem=${this._shiftRemainder.toFixed?.(3) ?? this._shiftRemainder}`; // 绊线取证
    this.a = rot(this.a);
    this.s = rot(this.s);
    this.step(4);
  }

  position() { return this.step(0); }
}

/** 路径积分器（纯自身运动；积分世界系的相对坐标，可吸附重校准） */
export class PathIntegrator {
  constructor() { this.x = 0; this.z = 0; }
  /** 前进 dist 米，当前航向 heading（世界系弧度，视觉约定 dz=+cos） */
  forward(heading, dist) {
    this.x += -Math.sin(heading) * dist;
    this.z += Math.cos(heading) * dist;
  }
  /** 地标重校准：吸附回已知点（看见并认出它时调用） */
  recalibrate(x, z) { this.x = x; this.z = z; }
  /** 相对某地标 (lx,lz) 的方位（世界系角）与距离 */
  bearingDist(lx, lz) {
    const dx = lx - this.x, dz = lz - this.z;
    return { angle: Math.atan2(-dx, dz), dist: Math.hypot(dx, dz) };
  }
}

/** 方位角 → 相对当前航向的扇区（0..8，4=正前；视觉约定） */
export function bearingSector(angle, heading) {
  let a = angle - heading;
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  const s = Math.round(a / (Math.PI / 4));
  return Math.min(8, Math.max(0, s + 4));
}

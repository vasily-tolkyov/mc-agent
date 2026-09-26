/** R1 情节缓冲（纯经验层）：只登记"发生了什么"，不做任何规则断言。
 * 每条情节 = { 条件帧(全维概念索引), 动作, 变化结果(只含实际变化的维), tick }。
 * 结果侧只记真实变化的维——全帧登记会把"动作没影响的维"也写进因果汤（结果稀释，实测教训）。
 * 环形容量 4000，持久化追加到 runs/mind-episodes.jsonl（回放可重建）。 */
import fs from 'node:fs';

export class EpisodeBuffer {
  constructor({ capacity = 4000, persistPath = null } = {}) {
    this.capacity = capacity;
    this.persistPath = persistPath;
    this.episodes = [];
    this.tick = 0;
  }

  /** 登记一条经验。conditions/outcomes 是概念索引帧（outcomes 只放变化维）；
   * rawConditions/rawNext = 裸值帧（回填用：概念是后置形成的，旧情节的概念索引当时
   * 都是未知档——留裸值才能用"今天的透镜"重读历史，R2/R3 周期性全量重差分）。 */
  record(conditions, act, outcomes, rawConditions = null, rawNext = null) {
    const ep = {
      conditions: { ...conditions }, act, outcomes: { ...outcomes }, tick: ++this.tick,
      rawConditions: rawConditions ? { ...rawConditions } : null,
      rawNext: rawNext ? { ...rawNext } : null,
    };
    this.episodes.push(ep);
    if (this.episodes.length > this.capacity) this.episodes.splice(0, this.episodes.length - this.capacity);
    if (this.persistPath) fs.appendFileSync(this.persistPath, JSON.stringify({ conditions: { ...ep.conditions, act }, outcomes: ep.outcomes }) + '\n');
    return ep;
  }

  get size() { return this.episodes.length; }

  /** 取最近 n 条（差分窗口）；n 省略 = 全部 */
  recent(n) { return n === undefined ? this.episodes : this.episodes.slice(-n); }
}

/** 指令 → 目标维度词汇规格（Jev）：四个维度都可被指令指定，未指定的维度保持当前值 */
const INTERACTIVE_PERCEPTION = {
  dims: [
    { name: "stack", values: [
      { value: 0, label: "清空堆垛/不需要堆垛" },
      { value: 1, label: "摞一层/堆一个箱子" },
      { value: 2, label: "摞两层/把箱子摞起来" },
    ], ask: "指令要求箱子堆到几层？" },
    { name: "carry", values: [
      { value: 0, label: "空手/放下箱子" },
      { value: 1, label: "拿着箱子/取一个箱子/手里有箱子" },
    ], ask: "指令要求手里是否拿着箱子？" },
    { name: "zone", values: [
      { value: 0, label: "回到起点/箱源旁/最左边" },
      { value: 6, label: "走到最右边/目标点/堆垛点旁" },
    ], ask: "指令要求 agent 去哪个位置？" },
    { name: "lane", values: [
      { value: 0, label: "内侧通道" },
      { value: 1, label: "外侧通道" },
    ], ask: "指令要求 agent 在哪条通道？" },
  ],
  confidenceThreshold: 0.6,
  clarityAsk: () => "指令对该维度的要求是否明确？",
};

module.exports = { INTERACTIVE_PERCEPTION };

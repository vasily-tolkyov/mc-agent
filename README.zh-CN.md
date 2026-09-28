# mc-agent：多层模拟神经网络驱动的 Minecraft 具身智能体

主线：`mind-agent.mjs` + `mind/`，网络基质来自兄弟仓库 [energy-network-sim](https://github.com/vasily-tolkyov/energy-network-sim)（二值能量网络 + 赫布学习 + 局部退火）。运行时无 LLM、无梯度下降；规则全部由能量网络从真实观察中学。

## 快速开始

```powershell
# 两个仓库并排克隆（mind 代码默认从同级目录 ../energy-network-sim 加载基质，也可用 ENS_PATH 环境变量指定）
git clone https://github.com/vasily-tolkyov/energy-network-sim
git clone https://github.com/vasily-tolkyov/mc-agent
cd energy-network-sim; npm install; npm run build; cd ..     # dist/ 不入库，需本地 tsc 构建
cd mc-agent; npm install
npm run verify                  # 离线回归 6 项（不需要 Minecraft，见下文"离线验证"）
# 在线验收（需要 Java 21；1.21.4 超平坦训练场由 scripts/local-server.mjs 托管在 .local-minecraft/，见 local-display/README）
npm run server:start
npm run levels                  # L1 教师课程 → L2 自主验证 → L3 目标规划（LEVEL4=1 → L4：教师不教拾取）
npm run proxy:start             # 可选：ViaProxy 127.0.0.1:25568 供 26.3 客户端旁观；npm run observe -- <玩家> <bot>
npm start                       # 常驻连续流：状态 http://127.0.0.1:3008/status，概念 /concepts，目标 POST /goal
```

## 设计 → 代码对照（十条原始设计）

| 设计 | 代码 | 状态 |
| --- | --- | --- |
| 一、能量公理（两态、Ea>Em、总能耗 E(s)=θΣs−ΣW+ΣΓ） | energy-network-sim `EnergyNetwork`；脉冲载体 `mind/spiking-network.mjs`（`NET_SUBSTRATE=spiking`） | 一致；脉冲版与二值版逐位等价（`verify-spiking-*`） |
| 二、学习 = 赫布改地形 | 概念层 `ConceptFormation.presentExperiment`（hebbianLearn） | 一致 |
| 三、响应 = 钳置输入上的最小能耗退火（局部：输入 ∪ 所触及势阱） | `settle` / `settleAnnealed(..., extraCandidates)`；R3 `predict`/`planCandidates` | 一致（候选集 = 点火门通过的规则核 + 结果场 + WTA 池） |
| 四、势阱 = 强度极大值的 80% 邻域团；落阱由能量比较决定 | 概念：`extractConcepts`（维内连通分量）；视网膜：settle 不动点 = 井（`detectWells` 在致密背景图上碎裂，如实弃用） | 操作化等价定义，注释已记录替换原因 |
| 五、势阱间有向通道 + 噪声驱动的链式转移 | energy-network-sim `sequence.ts`（learnSequence/runTransitions） | **未接入** mc-agent：R1 目前是情节数组，不是"条件阱—有向通道—结果阱"网络 |
| 六、R1 情节 → R2A 聚类 → R2B 差分 → R3 规则阱 | `mind/r1-episodes.mjs`（环形缓冲）→ `mind/r2-diff.mjs`（双臂对照统计）→ `mind/r3-rules.mjs`（物化进能量网络，证据深度=势阱深浅） | R1/R2 是**符号统计**，R3 是网络；筛选"反复出现才成规则"由 R3 地形深度带来，不设计数闸门 |
| 七、规则来自控制变量实验；教师是"只需观察"的特例 | `runCurriculum`（教师巡回，导航不记转移）；`mind/experiments.mjs` 轭式探针 | 一致；`prepare()` 的"如何扰动某维"是手写干预表（待改为用 R3 规则反查） |
| 八、概念自形成 / 效价注意力 / 罗盘环+路径积分 / 拟人优先 | `StableConceptRegistry`+`RetinaStream`；`valence`（R1 support ×3 → R3 深度）+ 抢占窗；`mind/space.mjs` | 空间层的地标记忆仍用世界坐标、重校准按真实位置就近吸附（诚实性缺口，见下） |
| 九、规划 = 目标反向链接；缺口 → 探索目标 | `mind/plan-back.mjs`（候选由 `planCandidates` 退火浮出）；`probeOverSpecific`+`frontierRound` | 一致 |
| 十、无符号数据库/无梯度/无 LLM | — | 无梯度、无 LLM；符号结构仍有：R1 数组、R2 直方图、地标 Map、执行禁忌表 |

已知的实现与设计差距（按优先级）：

1. **R1/R2 未网络化**：设计要求 R1 在网里成阱并以有向通道连"条件阱→结果阱"，R2A/R2B 用网络筛相似与共同部分；当前是数组 + Wilson 统计。energy-network-sim 已有 `learnSequence`/`runTransitions`，是接入点。
2. **空间层诚实性**：`landmarks` 记的是 `bot.entity.position` 世界坐标，`pInt` 在真实位置 4m 内就近吸附到地标，`goto` 走 pathfinder。设计要求纯自身运动积分 + 认出地标后重校准。改法：地标位置记积分器估计；识别到带标签的视觉井时，按积分器估计就近选同标签地标吸附；教师导航期间也要积分。
3. **教师/环境能力泄漏**：自主阶段的地标回访、实验准备仍用 `body.goto`（pathfinder）。设计要求移动最终收归目标规划（`experiments.mjs` 的 `envNavigate` 已标注唯一替换点）。
4. **R3 单结果维簇的共变读出**是符号合并（`mergeCo`，只并入本次查询也过点火门的规则），网络本义应是多核共激活读出——受 WTA 单胜者结构限制。

## 两种网络基质的关系（重要，别混淆）

**算法是同一套**（能量语义、赫布学习、Metropolis 退火求能耗极小），区别只在信号载体：

- **二值 EnergyNetwork**（默认）：局部场瞬时求和，异步 Glauber 动力学。
- **脉冲 SpikingEnergyNetwork**（`mind/spiking-network.mjs`）：局部场改为带符号脉冲事件传递 + 泄漏积分，决策语义与二值版**逐位等价**——`node verify-spiking-equiv.mjs` 逐点断言 |差|<1e-9，`verify-spiking-anneal.mjs` 同种子逐位复现退火轨迹，`verify-spiking-structures.mjs` 验证概念形成与 R3 换底后语义不变。

切换：`NET_SUBSTRATE=spiking node mind-agent.mjs --levels`（缺省 `binary`）。**换脉冲载体不是"去掉退火"**——退火仍是从能耗极小原理导出激活模式的核心机制，脉冲只是它的物理承载。

## 离线验证（`npm run verify`，全部返回非零表示失败）

| 脚本 | 验证内容 |
| --- | --- |
| `verify-r123.mjs` | 真实噪声谱合成流：R2 双臂对照剔薄因素、R3 新情境泛化与否决、Δ 规则重复应用成链、侥幸规则不浮出、缺口/缺失规则如实上报 |
| `verify-r2-replay.mjs` | R2 v2 快照（`test/fixtures/`）vs v3 对拍：v2 复现宽因素旧病，v3 剔薄并出链 |
| `verify-space.mjs` | 罗盘环点燃/自维持/平移、路径积分、扇区映射 |
| `verify-spiking-equiv.mjs` / `-anneal.mjs` / `-structures.mjs` | 脉冲载体 ≡ 二值语义（settle、赫布、账本、退火轨迹、概念形成、R3 预测；石头情境不得漏报原木副作用） |

另有 `verify-ab.mjs`（r123 vs 旧样本登记引擎的泛化 A/B，读 `runs/mind-episodes.jsonl`）。在线脚本（需训练场）：`verify-retina-live.mjs`、`verify-movement-calib.mjs`、`verify-pickup.mjs`；`probes/` 下是身体层探针与操作员工具，不属于默认运行链。

## 目录

```
mind-agent.mjs        主循环：感知 → 概念 → R1 情节 → 周期重建 R2/R3 → 目标反向链接 / 教师课程 / 探索 / 实验
mind/                 body(具身原语) sensory(自我中心帧) retina(体素视网膜) space(罗盘环+路径积分)
                      r1-episodes r2-diff r3-rules plan-back experiments spiking-network
build-flat-map.cjs    操作员盖教室：1.21.4 超平坦训练场标本布设（与学习无关）
scripts/              local-server / local-proxy / local-doctor（服务端与旁观代理托管，说明见 local-display/）
verify-*.mjs          离线/在线验证；probes/ 探针；test/fixtures/ 对拍快照
legacy/               归档线（box-world 实验台时代、kairos 上游运行时线），只读取证，见 legacy/README.md
```

`runs/`（日志、`mind-episodes.jsonl`、`levels-acceptance*.json`）与 `.local-minecraft/`（服务端世界）不入库。

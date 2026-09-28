# legacy/ — 归档线（只读取证，不属于当前主线）

当前主线是仓库根的 `mind-agent.mjs` + `mind/`（多层模拟神经网络：概念自形成 → R1/R2/R3 → 反向链接规划），见根 README。
本目录保存两条已停止演进的历史架构，按 `git mv` 整体迁入，历史可用 `git log --follow` 追溯。

| 目录 | 内容 | 状态 |
| --- | --- | --- |
| `box-world/` | 箱子世界/实验台时代：`mc-bench.cjs` 共享实验台（传送/发物品/重建堆垛）、三个旧入口（`interactive-agent.cjs`/`concept-agent.cjs`/`live-agent.cjs`，逐字节保留，哈希见 `original-hashes.json`）、prismarine-viewer 相关探针、Jev 指令规格、1.20.x 服务端与世界（`server/`，25565，创造模式）、`exploration-episodes.json`（旧 TransitionMemory 的探索回放）、`verify-rule-engine.mjs`（energy-network-sim 样本登记引擎 TransitionMemory 的容量回归） | 归档。使用特权重置与云端解析，违反当前"具身无作弊、无 LLM"的边界 |
| `kairos/` | 上游 [kairos-v5-predictive-agent](https://github.com/vasily-tolkyov/kairos-v5-predictive-agent) `ExperienceSession` 运行时接线：`local-agent.mjs` 入口、`local-control.mjs` 目标 API、核心锁/所有权/原子写脚本与其测试、`runtime/` 检查点指针、架构审查与迁移验证文档 | 归档。仍可独立运行：`node legacy/kairos/local-agent.mjs --check`（需要同级克隆并构建 `../kairos-v5-predictive-agent`）；测试 `node --test legacy/kairos/test/*.test.mjs` |

与当前主线共用、因此**留在根目录**的基础设施：`scripts/local-server.mjs`（1.21.4 训练场服务端，`.local-minecraft/`）、`scripts/local-proxy.mjs`（ViaProxy 25568 供 26.3 客户端旁观）、`scripts/local-doctor.mjs`（只读状态探测）、`local-display/`（以上三者的说明）。

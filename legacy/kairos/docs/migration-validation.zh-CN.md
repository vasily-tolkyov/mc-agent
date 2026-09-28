# 迁移验证记录

日期：2026-09-23。核心锁：`fb3c40a8e172e092ca6ba9a69eebc2836e255b36`，实际协议 `ExperienceSession1 / KairosExperienceMediumV11`。

## 软件与连接验证

- 上游 `npm run test:next-stage`：135/135，通过构建及当前集成门禁。原日志 [validation/core-next-stage.log](validation/core-next-stage.log)。
- 本项目 `npm test`：17/17，通过真实核心契约、Git/编译摘要锁、输入验证、旧经验拒绝、证据防覆盖、并发进程所有权等检查。[validation/mc-tests.log](validation/mc-tests.log)。
- 本地服务端和代理协议检查：[validation/local-doctor.json](validation/local-doctor.json)。`25567` 为 1.21.4/protocol 769；`25568` 为兼容 26.3/protocol 777 的 ViaProxy 入口。
- 游戏原生窗口已实际进入世界。服务端确认 `Vtolkyov` 与 `KairosLocalBot` 同时在线，观众进入旁观模式并成功跟随，见 [validation/native-client-join.log](validation/native-client-join.log)。这一步独立于只读 status ping。
- 服务端、代理和控制 API 仅监听 `127.0.0.1`；旧 3007/3009/3010/3012 浏览器 viewer 已停止。原 25565 服务和原世界保留。

## 有界真实运行

三次运行依次恢复前一会话，均使用同一保留世界。计数为检查点累计值，不能把三行直接相加。

| 运行目录（runs/ 下） | 结束原因 | 累计决策 | 累计实际动作 | 累计学习写入 | 累计被动学习 |
| --- | --- | ---: | ---: | ---: | ---: |
| migration-smoke-20260923 | budget-paused | 6 | 6 | 21 | 15 |
| migration-api-20260923 | budget-paused | 38 | 32 | 121 | 89 |
| migration-pause-20260923 | operator-paused | 55 | 49 | 183 | 134 |

相应 `result.json`、`session.json.gz`、真实事件与决策均保留在这些目录。第三次 API 暂停后正常保存并退出，随后从其检查点恢复至 `runs/native-live-20260923`。该展示运行最多新增 1024 个决策轮或运行 3600 秒，届时保存并退出，不是无限后台运行。

每轮实际反馈由上游 `MinecraftExperienceEnvironment` 输入 `ExperienceSession`。主动动作与被动窗口分开归档；退出前尚未消费的被动窗口标记为 `unconsumed-passive`，不把它们算作学习写入。

## 输入与结果真实性

1. 向运行中的 `/instruct` 发送坏 JSON，返回 HTTP 400；进程继续正常运行。
2. `/goals` 接受一个“当前 x 坐标位于现有容差范围”的目标，返回 HTTP 202。
3. 核心随后进行了多次实际观察确认，目标 `migration-already-measured` 达到 `verified`，该目标执行动作数为 **0**。这验证了“当前已满足目标”的正确处理，不是导航任务成功。
4. 后续 `/pause` 请求返回受理，最终结果为 `operator-paused`；恢复后累计统计保持连续。

提交记录见 [validation/live-api-submission.json](validation/live-api-submission.json)，交付时运行快照见 [validation/native-live-status.json](validation/native-live-status.json)。观察者的传送与视角命令仅改变观众，不作为 learner 的动作或训练数据。

## 能力边界

这些结果证明本地原生展示、新版核心接线、真实学习事件流、目标验证及暂停恢复工作正常。没有进行堆箱子、配方制作或任意中文多阶段任务验收，也没有把受限预算中缺少支持的规划当作不可达证明。自然世界中的行为主要是核心选择的探索，动作成功执行不等于目标完成。

上游历史原生保持/多阶段验收仍有失败记录；本次软件测试通过不能替代这些原生能力验证。后续优化及旧实现的问题详见 [architecture-review.zh-CN.md](architecture-review.zh-CN.md)。

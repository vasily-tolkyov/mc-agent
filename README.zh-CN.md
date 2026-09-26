# Minecraft 本地展示与 Kairos 最新核心

`npm start` 现在直接运行 GitHub Kairos 的最新经验学习核心，机器人和本地 Minecraft 客户端进入同一个真实世界。默认不启动浏览器 viewer，不调用 Typesafe/Jev 云 API。

2026-09-23 核对的 `origin/main` 为 **fb3c40a8e172e092ca6ba9a69eebc2836e255b36 / 0.4.0**。正式接口是 `ExperienceSession → ExperienceAgent → ExperienceMedium`，快照为 **ExperienceSession1 / KairosExperienceMediumV11**。上游 README 的 V10 描述落后于实际代码。源码提交和编译产物均有校验锁，旧 `energy-network-sim`、旧 lattice 记忆不用于本入口。

## 启动与原生观察

在 `D:\kimi_kairos\mc-agent` 执行：

```powershell
npm run server:start
npm run proxy:start
npm run check
npm start
```

当前安装的 **Minecraft 26.3**：多人游戏 → 直接连接 **127.0.0.1:25568**。若使用 1.21.4 客户端则直连 **127.0.0.1:25567**。玩家与机器人都在线后：

```powershell
npm run observe -- Vtolkyov KairosLocalBot
```

玩家进入旁观模式并跟随机器人，Shift 可离开跟随自由观察。服务端命令仅设置观众视角；机器人没有 OP，不会通过传送、发物品、重置方块来完成学习或执行。新世界在 `.local-minecraft/server/world`，自然地形、和平生存；旧 `server/world` 完整保留。旧浏览器机器人进程已停止，旧 `25565` 服务保留。

`npm start` 默认新建经验会话，最多运行 1024 个决策轮或 3600 秒。`--actions` 是沿用的参数名，包含观察和拒绝轮次；真实动作数看 `executed`。阶段、动作回执、假设探索与目标确认可通过日志或 `http://127.0.0.1:3008/status` 查看。展示画面始终由 Minecraft 客户端渲染；此 HTTP 地址只是 JSON 控制接口。

## 目标输入

```powershell
npm run instruct -- "向前移动1米"
npm run instruct -- "到 x=2"
```

本地语法明确只支持 `到 x/y/z=数值`、`向前移动N米`、`跳高N米`。相对目标按最新真实位置和朝向生成测量谓词，核心自行选动作。接收成功不表示能够完成；目标达成必须经过后续真实观察确认。复杂测量条件可 POST `/goals`，请求体为 `{ "goal": GroundedGoalV1 }`，支持 `all` / `any` 组合。

旧“摞箱子”“拿物品”等中文任务当前会明确拒绝，不能把旧实验台替换状态的效果冒充新版学习能力。要恢复这些任务，应先实现可信的可见物体/库存目标接地与真实连续动作验证，见[架构审查](docs/architecture-review.zh-CN.md)。

API 只监听 loopback，校验来源、JSON、8 KiB 限额、目标表达树和有限数值；不接收任意代码或 Minecraft 命令。目标只排队，动作在一个主循环串行执行。

## 暂停、恢复与证据

```powershell
Invoke-RestMethod http://127.0.0.1:3008/pause -Method Post -ContentType 'application/json' -Body '{}'
```

暂停先返回受理，当前动作结束后保存并退出。也可在对应运行目录新建名为 `PAUSE` 的文件。以 `result.json` 和 `session.json.gz` 确认完成；不要因 HTTP 已返回便立刻结束 Java 服务。

每次运行创建新的 `runs/<时间-ID>`：

- `manifest.json`：核心版本、服务器/世界标识、恢复输入哈希与预算。
- `session.json.gz`：原子更新的会话检查点，默认每 16 轮及目标确认后保存。
- `events/`、`passive-events/`：真实动作与被动感知窗口。
- `journal/`、`decisions.jsonl`：决策、动作回执和学习依据。
- `result.json`：本轮退出原因及累计计数。

最后决策后的完整被动窗口仍会归档，但不触发新的学习决策，计入 `unconsumed-passive`。日志数量因此可以比学习写入多，不能混算。断线会保存后停止；新进程恢复检查点，避免旧连接回执污染新会话。

Windows 短暂文件占用导致的 `EPERM`/`EACCES`/`EBUSY` 替换失败会有限重试（最多 12 次，退避总计约 4.25 秒）。发布前写入独立临时文件并刷盘；不会先删除旧检查点。若占用持续存在，仍如实停止，并保留未发布的 `.pending-<UUID>` 文件供恢复。

恢复最近检查点：

```powershell
$saved = Get-Content runtime\LATEST.json | ConvertFrom-Json
npm start -- --restore $saved.session --same-world
```

只有世界未更换、坐标仍相同才使用 `--same-world`；否则省略，保留学习模型但不沿用空间任务。此标志核验运行清单的服务器身份，不能检测人工替换同名世界。旧箱子 cache 和 lattice 格式会拒绝恢复。每次恢复仍写新的运行目录，原证据不覆盖。

## 验证与维护

```powershell
npm test
npm run test:core
npm run doctor
```

上游当前集成门禁 **135/135** 通过；MC 输入、恢复、核心锁和进程所有权另有本项目测试。验证记录见 [docs/validation](docs/validation)，实机迁移记录见 [migration-validation.zh-CN.md](docs/migration-validation.zh-CN.md)。这是接线、展示与回归验证，不代表通用多阶段自主任务已通过。

调整本地连接参数使用 `local.config.json`。已核对的核心编译产物若改变，执行 `npm run build:core` 重新构建并记录；升级核心提交还需审阅 API、更新 `upstream.lock.json` 和运行门禁，不能自动套用旧经验。

原 `interactive-agent.cjs`、`concept-agent.cjs`、`live-agent.cjs` 现在都是新版入口兼容包装。原始三个文件及哈希保存在 `legacy/`，其余实验台与 probe 文件只用于历史审查，不属于默认运行链。完整服务器与代理说明见 [local-display/README.zh-CN.md](local-display/README.zh-CN.md)。

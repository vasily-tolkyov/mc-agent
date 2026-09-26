# 本地 Minecraft 原生展示

展示入口是玩家自己的 Minecraft Java 游戏。Kairos 与玩家连接同一个本地服务器，世界、方块变化、动作和聊天都由 Minecraft 原生客户端渲染。无需浏览器 viewer 或云端展示服务。

## 已核对的版本与连接

| 组件 | 版本 | 本地地址/位置 |
| --- | --- | --- |
| Kairos 最新 Minecraft body 的服务器基线 | Java Edition 1.21.4，Java 21 | `127.0.0.1:25567` |
| 当前 PCL 客户端 | Java Edition 26.3，Java 25 | 通过 `127.0.0.1:25568` 进入 |
| ViaProxy | 3.4.13 | `127.0.0.1:25568` → `127.0.0.1:25567` |
| 世界 | 新建、持久保存的自然世界 | `mc-agent/.local-minecraft/server/world` |

1.21.4 客户端可直接连 `127.0.0.1:25567`；26.3 客户端使用 `127.0.0.1:25568`。26.4 snapshot 不在此方案验证范围。

旧的 `mc-agent/server/world` 与 `25565` 服务未迁移、覆盖或重置。新世界固定 seed `20260923`，生存模式、和平难度、8 人容量；不向 learner 预置目标、答案、物品或 OP 权限。服务器和代理均只监听 `127.0.0.1`。

## 启动、进入与观察

在 `D:\kimi_kairos\mc-agent` 运行：

```powershell
node scripts/local-server.mjs start
node scripts/local-proxy.mjs start
node scripts/local-doctor.mjs
```

两个 `start` 都会后台启动并隐藏控制台窗口；重复调用会显示已有实例状态，不另开服务。第一次生成世界可能超过 45 秒，此时输出 `ready: false`，稍后使用 `status` 确认。世界会在正常停止时保存，再次启动继续原来的世界。

在 PCL 已运行的 **26.3** 游戏中打开“多人游戏”→“直接连接”，输入 **`127.0.0.1:25568`**。启动 mc-agent 的本地 agent 后，玩家和 `KairosLocalBot` 都在线时运行：

```powershell
node scripts/local-server.mjs observe Vtolkyov KairosLocalBot
```

该命令只把观众切换到旁观模式，并跟随 learner 的第一人称视角。按 **Shift** 可离开跟随视角并自由飞行；重新执行命令可继续跟随。服务端必须在日志中确认命令成功，`queued: true` 仅说明命令已提交；离线玩家不会被误报为成功。

观察期间避免通过普通玩家交互修改学习环境。游戏渲染属于展示层，不作为 learner 的特权感知输入。输入与动作以 mc-agent 的 Kairos adapter 为准。

## 状态与正常停止

```powershell
node scripts/local-server.mjs status
node scripts/local-proxy.mjs status
node scripts/local-doctor.mjs
node scripts/local-proxy.mjs stop
node scripts/local-server.mjs stop
```

先停止 agent，再停止代理和服务器。server 的 `stop` 向**本脚本拥有的服务器**发送原生 `stop` 命令，等待保存，不按进程名结束其他 Java 程序。控制接口绑定 loopback 并使用随机 token；token 文件位于各自运行目录，不应加入版本控制。代理不保存世界，停止只结束本脚本的代理子进程。

日志：

- 服务器：`.local-minecraft/server/console.log`、`.local-minecraft/server/logs/latest.log`
- 代理：`viaproxy/console.log`
- 启动器异常：各运行目录中的 `supervisor.log`

`local-doctor.mjs` 使用 Minecraft 只读状态协议，分别以 1.21.4/protocol 769 与 26.3/protocol 777 检查两个入口；它不会生成测试玩家或改变世界。状态协议成功不等同于完成游戏登录，原生客户端进入世界仍需单独确认。

## 依赖来源与配置

Java 21 和 1.21.4 服务端复用 `D:/Kairos-Minecraft` 的现有安装，已有 EULA 接受文件随服务器配置复用。脚本不下载或替换游戏服务器，启动前检查固定版本 jar 的 SHA-256。

ViaProxy 来自 [官方 3.4.13 发布](https://github.com/ViaVersion/ViaProxy/releases/tag/v3.4.13)，该版本明确支持 26.3 客户端。首次缺少 jar 时执行 `node scripts/local-proxy.mjs install`，下载后核对固定 SHA-256，启动时再次核验。完整来源、字节数与校验值见 [dependencies.json](dependencies.json)。Minecraft 版本和 Java 21 要求也由 [Mojang 1.21.4 元数据](https://piston-meta.mojang.com/v1/packages/c16bd1251bdf2cab3d7c3b30393427eeb19c6b2e/1.21.4.json)核对。

可选环境变量：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `MC_JAVA21` | `D:/Kairos-Minecraft/runtime/jdk-21/bin/java.exe` | 服务端与代理 Java 可执行文件 |
| `MC_SERVER_JAR` | `D:/Kairos-Minecraft/server/1.21.4/server.jar` | 同一官方 1.21.4 jar 的其他路径 |
| `MC_LOCAL_SERVER_DIR` | `mc-agent/.local-minecraft/server` | 独立持久世界及服务端日志目录 |
| `MC_LOCAL_SERVER_PORT` | `25567` | 服务端与代理目标端口；agent 也需配置相同值 |
| `MC_LOCAL_PROXY_PORT` | `25568` | 26.3 客户端入口端口 |

服务器配置仅在目录首次创建时生成；之后不会覆盖已有配置。更换端口前正常停止，并同步调整该目录的 `server.properties`；不要在运行期间修改端口或世界目录。

## 本轮验证记录

2026-09-23 已验证：现有 server jar 与 Mojang SHA-1 一致；ViaProxy jar 与 GitHub release SHA-256 一致；新服务器实际生成世界并输出 `Done`；两个入口仅监听 loopback；重复 start 保持原 PID；只读协议检查显示 1.21.4 端口为 769、经代理的 26.3 端口为 777；`observe` 拒绝将 learner 自己作为观众。

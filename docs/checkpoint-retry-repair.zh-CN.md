# 2026-09-23 检查点替换失败与恢复

`native-live-20260923` 在运行 407.335 秒时以 `fault-paused` 结束。失败位置是 periodic save 的 `rename(session.json.gz.pending, session.json.gz)`，Windows 返回 `EPERM`；未达到 1024 轮/3600 秒预算。服务器只记录客户端主动断开，服务端与代理继续正常运行。

退出阶段再次保存成功。只读上游 `ExperienceSession.restore(snapshot, { sameWorld: true })` 验证检查点与 `result.json`、`runtime/LATEST.json` 一致：295 次决策、288 个动作、1205 次学习写入（其中 917 被动写入）。原文件 SHA-256 为 `a005ac8ee9ce0ecce3b4cb42b471f51662d84899239154ffe848380cbc4b2ded`。恢复后当前可见表面重置为 0 是上游的临时可见性语义，不是记忆丢失。

本次运行的 239 个动作事件、240 条决策（含 1 次拒绝）及事件日志计数对应；798 个被动窗口包括 783 个新增已学习窗口和 15 个退出时归档但未学习的尾部窗口。所有旧证据保留。

原因是本地保存适配层只尝试一次文件替换，未容忍 Windows 的临时共享锁/访问拒绝。具体是哪个进程占用原文件未确认；退出阶段同路径保存成功，表明该次拒绝不是持续不可写。

修复在 `scripts/atomic-write.mjs`：

- 用独立 UUID 临时文件写入完整内容并刷盘，再原子替换。
- 对 `EPERM`、`EACCES`、`EBUSY` 最多尝试 12 次，指数退避并限于 500 毫秒单次等待。
- 不删除旧检查点来绕过锁；读者始终能看到完整旧版或新版。
- 持续失败仍停止并保留未发布快照，不吞掉 I/O 错误。
- 同一逻辑覆盖会话快照、LATEST 指针及结果元数据。

新增测试覆盖临时失败恢复、持续失败不破坏旧存档、其他 I/O 错误立即上报，以及真正的 Windows FileStream 禁止删除共享锁。完整回归日志见 `validation/checkpoint-retry-suite.log`。恢复运行使用新输出目录，原失败记录不覆盖。

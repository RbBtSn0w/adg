# 中文发布草稿

负责人：rbbtsn0w。状态：未发布。发布前核对[发布清单](README.md#publication-checklist)，
按受众选择一种语言。下列代码块各是一条 X 帖子；标题和附件说明不属于正文。
文案采用作者第一人称，没有添加未经提供的个人经历或用户证言。

## D1：真实工作流

附件：[演示视频](../../website/assets/workflow.mp4)。

```text
我在做的 ADG，想解决多 agent 下插件和 skills 要分别维护的问题。

这段 10 秒回放来自真实 CLI：添加一个 skill → 连接 Codex / Claude Code → 检查注册状态。

从一个项目试起：https://adg.rbbtsn0w.me/
```

## D4：接入现有来源

附件：[静态流程图](../../website/assets/workflow-poster.png)。

```text
已有 superpowers 插件库，可以直接交给 ADG 管理，不用重写上游 manifest。

先选一个 skill，再连接需要的 agent。项目级命令放在这里：
https://github.com/RbBtSn0w/adg#install-and-quick-start
```

## D8：说清状态检查的边界

附件：[分享图](../../website/assets/social-preview.png)。

```text
ADG 的 lock 记录来源、版本与内容哈希；status 对照原生插件状态，检查是否注册。

它不证明 skill 已被模型执行，也不检查内容漂移。先把这个边界讲清楚。

演示：https://adg.rbbtsn0w.me/#workflow
```

## D12：邀请首次试用

附件可选演示视频，主要行动是通过链接反馈。

```text
想找 5 位同时用 Codex / Claude Code 的开发者，在一个项目里试用 ADG。

添加一个 skill、连接两端、检查状态，再开新会话确认发现。成功或失败都欢迎反馈，请附版本并移除隐私信息：
https://github.com/RbBtSn0w/adg/issues
```

## 回复要点

- 作用域：同一个 store 的命令一致使用 `--project` 或 `--global`。原生 agent
  也会维护自己的注册信息和缓存；项目级安装不等于插件代码被安全隔离。
- 兼容性：按[运行时规范](../agents-spec.md)说明支持范围，不承诺所有组件跨端等价。
- 现有插件库：可以导入原生 Claude/Codex manifest；标准结构与多插件仓库的发现要求不同。
- 更新：先收集对应运行时的状态，再按[更新与恢复说明](../plugin-upgrade-migrations.md)处理，
  不把删除整个配置目录作为通用建议。
- 遥测：默认发送匿名命令数据，说明收集边界和 `DO_NOT_TRACK=1` 等退出方式，
  链接到 [README 的披露](../../README.md#telemetry)。
- 反馈：请提供 ADG 与 agent 版本、系统、作用域、脱敏命令、预期与实际结果。
  分别记录注册状态和新会话中的发现结果，不把重复命令次数当作独立用户数。

社区讨论使用[英文提纲](posts.en.md#community-discussion-outline)准备，由作者结合实际经历
亲自撰写。r/LocalLLaMA 仍是待验证渠道；先确认具体使用场景和当前规则，再决定是否发布。

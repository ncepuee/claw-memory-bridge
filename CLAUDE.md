# Claw Memory Bridge — Agent 使用指南

我是跨 Agent 共享记忆桥。通过 MCP 工具提供记忆存储与检索。

## 对我来说需要做什么

### 开始新任务前
调用 `memory_context` 获取近期记忆和相关上下文：
- 传 `query`: 当前任务的关键词
- 查看 `recent`（近期记忆）、`search`（相关记忆）、`tencent_context`（TencentDB）

### 完成任务后
调用 `memory_store` 保存关键信息：
- `agent`: 填 `claude-code` 或 `codex`
- `topic`: project / decision / conclusion / note
- `content`: 用自然语言写清楚，别人能看懂

### 想知道其他人的情况
- `memory_recent` → 最近大家的记忆
- `memory_search` → 按关键词搜索
- `memory_status` → 统计信息

## 存储约定

```json
memory_store({
  agent: "claude-code",       // 或 codex / qclaw / user
  topic: "decision",          // 分类
  content: "我们在 XXX 项目上决定用 YYY 方案，因为 ZZZ",
  source: "G:\\project\\file.py",
  tags: "project=XXX,框架=YYY"
})
```


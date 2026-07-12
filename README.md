# Claw Memory Bridge

Cross-agent shared memory bridge for MCP. Connects memory across QClaw, Claude Code, and Codex via MCP tools.

跨 Agent 共享记忆桥 — 通过 MCP 工具打通 QClaw、Claude Code、Codex 的记忆，让多个 AI agent 共享笔记与结论。

## Features

- 存储与检索跨 agent 的笔记、决策、结论
- 按 agent 归档（`claude-code` / `codex` / `qclaw` / `user`）
- 全文搜索（SQLite FTS5，支持中文）
- 可选 TencentDB 集成（当存在 `~/.openclaw/state/memory-tdai/` 时自动读取）

## MCP Tools

| Tool | Description |
|------|-------------|
| `memory_store` | 存一条记忆（agent + topic + content） |
| `memory_search` | 全文搜索记忆（含 TencentDB 记忆库） |
| `memory_recent` | 查看最近记忆 |
| `memory_context` | 获取完整上下文：近期 + 相关 + TencentDB |
| `memory_status` | 查看各 Agent 记忆量统计 |

## Install

```bash
git clone https://github.com/ncepuee/claw-memory-bridge.git
cd claw-memory-bridge
npm install
```

Requires Node.js >= 22 (uses built-in `node:sqlite`).

## Configure

### Claude Code (stdio)

```bash
claude mcp add claw-memory-bridge --scope user -- node /path/to/claw-memory-bridge/server.js
```

### Claude Code Plugin (Marketplace, recommended)

```bash
claude plugin marketplace add https://github.com/ncepuee/claw-memory-bridge
claude plugin install claw-memory-bridge@claw-memory-bridge
```

Plugin install auto-runs `npm install` for dependencies. Don't enable both stdio and plugin at the same time (same MCP name).

### Codex

```bash
codex mcp add claw-memory-bridge -- node /path/to/claw-memory-bridge/server.js
```

### Claude Desktop / other MCP clients

```json
{
  "mcpServers": {
    "claw-memory-bridge": {
      "command": "node",
      "args": ["/path/to/claw-memory-bridge/server.js"]
    }
  }
}
```

## Data

- Local SQLite: `~/.claw-memory-bridge/shared.db`
- Optional TencentDB: `~/.openclaw/state/memory-tdai/` (auto-detected; skipped if absent)

## Usage

Agents call `memory_context` at the start of a task to pull recent + relevant context, and `memory_store` at the end to persist key conclusions.

```jsonc
memory_store({
  agent: "claude-code",                              // codex / qclaw / user
  topic: "decision",                                 // project / decision / conclusion / note
  content: "我们在 XXX 项目上决定用 YYY 方案，因为 ZZZ",
  source: "/path/to/file",
  tags: "project=XXX,framework=YYY"
})
```

## License

MIT © ncepuee

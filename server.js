#!/usr/bin/env node

/**
 * claw-memory-bridge — 跨 Agent 共享记忆桥
 *
 * 让 QClaw, Claude Code, Codex 三方共享记忆：
 * - 存储/搜索跨 Agent 的笔记与结论
 * - 读取 TencentDB 记忆库（当存在时）
 * - 提供 MCP 工具给 CC/Codex 调用
 *
 * MCP Tools:
 *   memory_store     — 存一条记忆（agent + topic + content）
 *   memory_search    — 搜索记忆（全文搜索）
 *   memory_recent    — 查看最近记忆
 *   memory_context   — 获取当前上下文（近期 + 相关）
 *   memory_status    — 查看各 Agent 记忆统计
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";

// ─── Paths ──────────────────────────────────────────────────────
const HOME = homedir();
const SHARED_BRAIN_DIR = join(HOME, ".claw-memory-bridge");
const SHARED_DB_PATH = join(SHARED_BRAIN_DIR, "shared.db");
const TENCENTDB_DIR = join(HOME, ".openclaw", "state", "memory-tdai");
const TENCENTDB_DB = join(TENCENTDB_DIR, "vectors.db");
const TENCENTDB_L2_DIR = join(TENCENTDB_DIR, "scene_blocks");
const TENCENTDB_L3_FILE = join(TENCENTDB_DIR, "persona.md");

// ─── DB Setup ────────────────────────────────────────────────────
mkdirSync(SHARED_BRAIN_DIR, { recursive: true });

const db = new DatabaseSync(SHARED_DB_PATH);
db.exec(`PRAGMA journal_mode=WAL`);
db.exec(`PRAGMA query_only=OFF`);

// Create schema
db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    agent       TEXT    NOT NULL DEFAULT 'unknown',
    topic       TEXT    NOT NULL DEFAULT 'general',
    content     TEXT    NOT NULL,
    source      TEXT    DEFAULT '',
    tags        TEXT    DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_memories_agent    ON memories(agent);
  CREATE INDEX IF NOT EXISTS idx_memories_topic    ON memories(topic);
  CREATE INDEX IF NOT EXISTS idx_memories_created  ON memories(created_at);
`);

// Enable FTS5 for full-text search
try {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content, topic, tags,
    content='memories',
    content_rowid='id'
  )`);
  // Triggers to keep FTS in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, topic, tags)
      VALUES (new.id, new.content, new.topic, new.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, topic, tags)
      VALUES ('delete', old.id, old.content, old.topic, old.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, topic, tags)
      VALUES ('delete', old.id, old.content, old.topic, old.tags);
      INSERT INTO memories_fts(rowid, content, topic, tags)
      VALUES (new.id, new.content, new.topic, new.tags);
    END;
  `);
  // Rebuild FTS from existing data if any
  db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`);
} catch {
  // FTS5 not available (unlikely with Node 22), fall back to LIKE search
  console.error("[claw-memory] FTS5 unavailable, using LIKE fallback");
}

const INSERT = db.prepare(`
  INSERT INTO memories (agent, topic, content, source, tags)
  VALUES (@agent, @topic, @content, @source, @tags)
`);

const SEARCH_FTS = db.prepare(`
  SELECT m.* FROM memories m
  JOIN memories_fts f ON m.id = f.rowid
  WHERE memories_fts MATCH @query
  ORDER BY rank
  LIMIT @limit
`);

const SEARCH_LIKE = db.prepare(`
  SELECT * FROM memories
  WHERE content LIKE @query
     OR topic  LIKE @query
  ORDER BY created_at DESC
  LIMIT @limit
`);

const RECENT = db.prepare(`
  SELECT * FROM memories
  ORDER BY created_at DESC
  LIMIT @limit
`);

const RECENT_BY_AGENT = db.prepare(`
  SELECT * FROM memories
  WHERE agent = @agent
  ORDER BY created_at DESC
  LIMIT @limit
`);

const STATS = db.prepare(`
  SELECT agent, COUNT(*) AS count, MAX(created_at) AS last
  FROM memories
  GROUP BY agent
  ORDER BY count DESC
`);

// ─── Helper: try reading from TencentDB ──────────────────────────

function tryOpenTencentDB() {
  if (!existsSync(TENCENTDB_DB)) return null;
  try {
    const tdb = new DatabaseSync(TENCENTDB_DB);
    tdb.exec("PRAGMA query_only = ON");
    return tdb;
  } catch {
    return null;
  }
}

function readTencentDBContext(limit = 5) {
  const results = [];
  const tdb = tryOpenTencentDB();
  if (tdb) {
    try {
      const rows = tdb
        .prepare(
          `SELECT role, message_text, timestamp FROM l0_conversations ORDER BY timestamp DESC LIMIT ?`
        )
        .all(limit);
      results.push(
        ...rows.map((r) => ({
          source: "tencentdb-l0",
          role: r.role,
          content: r.message_text,
          time: new Date(r.timestamp).toISOString(),
        }))
      );
    } catch { /* table may not exist yet */ }
    tdb.close();
  }

  // Read L3 persona
  if (existsSync(TENCENTDB_L3_FILE)) {
    results.push({
      source: "tencentdb-l3",
      role: "persona",
      content: readFileSync(TENCENTDB_L3_FILE, "utf-8").slice(0, 2000),
    });
  }

  // Read L2 scene blocks
  if (existsSync(TENCENTDB_L2_DIR)) {
    try {
      const files = readdirSync(TENCENTDB_L2_DIR)
        .filter((f) => f.endsWith(".md"))
        .slice(0, 3);
      for (const f of files) {
        const content = readFileSync(join(TENCENTDB_L2_DIR, f), "utf-8");
        results.push({
          source: "tencentdb-l2",
          role: "scene",
          file: f,
          content: content.slice(0, 1000),
        });
      }
    } catch { /* ignore */ }
  }

  return results;
}

// ─── Tool Implementations ────────────────────────────────────────

function storeMemory(args) {
  const { agent, topic, content, source, tags } = args;
  if (!content) throw new Error("content is required");

  INSERT.run({
    agent: agent || "unknown",
    topic: topic || "general",
    content,
    source: source || "",
    tags: tags || "",
  });
  return { status: "ok", message: `记忆已存储 (agent=${agent || "unknown"}, topic=${topic || "general"})` };
}

function searchMemory(args) {
  const query = args.query || "";
  const limit = Math.min(args.limit || 10, 50);
  if (!query) return { items: [], total: 0 };

  // Try FTS5 first (add * for prefix matching, critical for CJK)
  let rows = [];
  const sanitized = query.replace(/[^\w\u4e00-\u9fff\s-]/g, "");
  try {
    // FTS5 needs each CJK char to be a separate indexed token;
    // use prefix match + OR for multi-char CJK queries
    const ftsQuery = [...sanitized].map(c =>
      /[\u4e00-\u9fff]/.test(c) ? `${c}*` : c
    ).join(" ");
    rows = SEARCH_FTS.all({ query: ftsQuery, limit });
  } catch {
    // FTS5 failed, fallback silently
  }
  if (rows.length === 0) {
    rows = SEARCH_LIKE.all({ query: `%${query}%`, limit });
  }

  // Also search TencentDB
  const external = readTencentDBContext(limit);

  return {
    items: rows.map((r) => ({
      id: r.id,
      agent: r.agent,
      topic: r.topic,
      content: r.content,
      source: r.source,
      tags: r.tags,
      created_at: r.created_at,
    })),
    external, // TencentDB hits
    total: rows.length,
  };
}

function getRecent(args) {
  const limit = Math.min(args.limit || 10, 50);
  const agent = args.agent;

  let rows;
  if (agent) {
    rows = RECENT_BY_AGENT.all({ agent, limit });
  } else {
    rows = RECENT.all({ limit });
  }

  return {
    items: rows.map((r) => ({
      id: r.id,
      agent: r.agent,
      topic: r.topic,
      content: r.content,
      source: r.source,
      tags: r.tags,
      created_at: r.created_at,
    })),
    total: rows.length,
  };
}

function getContext(args) {
  const query = args.query || "";
  const recentLimit = Math.min(args.recentLimit || 5, 20);
  const searchLimit = Math.min(args.searchLimit || 3, 10);

  const recent = RECENT.all({ limit: recentLimit }).map((r) => ({
    id: r.id,
    agent: r.agent,
    topic: r.topic,
    content: r.content,
    created_at: r.created_at,
  }));

  let searchResults = [];
  if (query) {
    try {
      searchResults = SEARCH_FTS
        .all({ query: query.replace(/[^\w\u4e00-\u9fff\s-]/g, ""), limit: searchLimit })
        .map((r) => ({
          id: r.id,
          agent: r.agent,
          topic: r.topic,
          content: r.content,
          created_at: r.created_at,
        }));
    } catch {
      searchResults = SEARCH_LIKE
        .all({ query: `%${query}%`, limit: searchLimit })
        .map((r) => ({
          id: r.id,
          agent: r.agent,
          topic: r.topic,
          content: r.content,
          created_at: r.created_at,
        }));
    }
  }

  // Include TencentDB context
  const tencentCtx = query ? readTencentDBContext(searchLimit) : [];

  return {
    recent,
    search: searchResults,
    tencent_context: tencentCtx,
    context_date: new Date().toISOString(),
  };
}

function getStatus() {
  const stats = STATS.all();
  const tdbAvailable = existsSync(TENCENTDB_DB);
  const tdbL2Count = existsSync(TENCENTDB_L2_DIR)
    ? readdirSync(TENCENTDB_L2_DIR).filter((f) => f.endsWith(".md")).length
    : 0;
  const tdbL3Exists = existsSync(TENCENTDB_L3_FILE);

  return {
    agents: stats.map((s) => ({
      agent: s.agent,
      count: s.count,
      last: s.last,
    })),
    total: stats.reduce((sum, s) => sum + s.count, 0),
    tencentdb: {
      available: tdbAvailable,
      l2_blocks: tdbL2Count,
      l3_persona: tdbL3Exists,
    },
  };
}

// ─── MCP Server ──────────────────────────────────────────────────

const server = new Server(
  { name: "claw-memory-bridge", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "memory_store",
      description: "存储一条记忆到共享脑。每个 Agent 完成任务后都该存一条。",
      inputSchema: {
        type: "object",
        properties: {
          agent: {
            type: "string",
            description: "哪个 Agent (qclaw, claude-code, codex, user)",
          },
          topic: {
            type: "string",
            description: "主题分类 (project, decision, conclusion, note)",
          },
          content: {
            type: "string",
            description: "记忆内容，用自然语言写清楚",
          },
          source: {
            type: "string",
            description: "来源（如文件路径、对话ID）",
          },
          tags: {
            type: "string",
            description: "逗号分隔的标签",
          },
        },
        required: ["content"],
      },
    },
    {
      name: "memory_search",
      description: "全文搜索共享记忆。也返回 TencentDB 记忆库中的相关结果。",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词" },
          limit: { type: "number", description: "最大返回数 (默认 10)" },
        },
        required: ["query"],
      },
    },
    {
      name: "memory_recent",
      description: "查看最近的共享记忆。可指定 Agent 筛选。",
      inputSchema: {
        type: "object",
        properties: {
          agent: {
            type: "string",
            description: "按 Agent 筛选 (qclaw, claude-code, codex, 留空则全部)",
          },
          limit: { type: "number", description: "最大返回数 (默认 10)" },
        },
      },
    },
    {
      name: "memory_context",
      description: "获取完整的上下文：近期记忆 + 相关搜索 + TencentDB 记忆。开始新任务前调用。",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "当前任务的关键词，用于搜索相关的历史记忆",
          },
          recentLimit: {
            type: "number",
            description: "近期记忆条数 (默认 5)",
          },
          searchLimit: {
            type: "number",
            description: "相关搜索条数 (默认 3)",
          },
        },
      },
    },
    {
      name: "memory_status",
      description: "查看各 Agent 的记忆量统计，以及 TencentDB 连接状态。",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "memory_store":
        return {
          content: [{ type: "text", text: JSON.stringify(storeMemory(args || {})) }],
        };
      case "memory_search":
        return {
          content: [{ type: "text", text: JSON.stringify(searchMemory(args || {}), null, 2) }],
        };
      case "memory_recent":
        return {
          content: [{ type: "text", text: JSON.stringify(getRecent(args || {}), null, 2) }],
        };
      case "memory_context":
        return {
          content: [{ type: "text", text: JSON.stringify(getContext(args || {}), null, 2) }],
        };
      case "memory_status":
        return {
          content: [{ type: "text", text: JSON.stringify(getStatus(), null, 2) }],
        };
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: error.message }) }],
      isError: true,
    };
  }
});

// ─── Start ───────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[claw-memory-bridge] 共享记忆桥已启动 ✅");
  console.error(`  Shared DB: ${SHARED_DB_PATH}`);
  console.error(`  TencentDB: ${existsSync(TENCENTDB_DB) ? "✅ 已连接" : "⏳ 待生成"}`);
}

main().catch((err) => {
  console.error("[claw-memory-bridge] FATAL:", err);
  process.exit(1);
});

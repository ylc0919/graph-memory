<p align="center">
  <img src="docs/images/banner.jpg" alt="graph-memory" width="100%" />
</p>

<h1 align="center">graph-memory</h1>

<p align="center">
  <strong>Knowledge Graph Context Engine for OpenClaw</strong><br>
  By <a href="mailto:Wywelljob@gmail.com">adoresever</a> · MIT License
</p>

<p align="center">
  <a href="#installation">Installation</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="README_CN.md">中文文档</a>
</p>

---

<p align="center">
  <img src="docs/images/hero.png" alt="graph-memory overview" width="90%" />
</p>

## What it does

When conversations grow long, agents lose track of what happened. graph-memory solves three problems at once:

1. **Context explosion** — 174 messages eat 95K tokens. graph-memory compresses to ~24K by replacing raw history with structured knowledge graph nodes
2. **Cross-session amnesia** — Yesterday's bugs, solved problems, all gone in a new session. graph-memory recalls relevant knowledge automatically via FTS5/vector search + graph traversal
3. **Skill islands** — Self-improving agents record learnings as isolated markdown. graph-memory connects them: "installed libgl1" and "ImportError: libGL.so.1" are linked by a `SOLVED_BY` edge

**It feels like talking to an agent that learns from experience. Because it does.**

## Real-world results

<p align="center">
  <img src="docs/images/token-comparison.png" alt="Token comparison: 7 rounds" width="85%" />
</p>

7-round conversation installing bilibili-mcp + login + query:

| Round | Without graph-memory | With graph-memory |
|-------|---------------------|-------------------|
| R1 | 14,957 | 14,957 |
| R4 | 81,632 | 29,175 |
| R7 | **95,187** | **23,977** |

**75% compression.** Red = linear growth without graph-memory. Blue = stabilized with graph-memory.

<p align="center">
  <img src="docs/images/token-sessions.png" alt="Session tokens" width="60%" />
</p>

## How it works

### The Knowledge Graph

graph-memory builds a typed property graph from conversations:

- **3 node types**: `TASK` (what was done), `SKILL` (how to do it), `EVENT` (what went wrong)
- **5 edge types**: `USED_SKILL`, `SOLVED_BY`, `REQUIRES`, `PATCHES`, `CONFLICTS_WITH`
- **Personalized PageRank**: ranks nodes by relevance to the current query, not global popularity
- **Community detection**: automatically groups related skills (Docker cluster, Python cluster, etc.)
- **Vector dedup**: merges semantically duplicate nodes via cosine similarity

### Data flow

```
Message in → ingest (zero LLM)
  ├─ All messages saved to gm_messages
  └─ Signal detection → errors/corrections/completions → gm_signals

assemble (zero LLM)
  ├─ Graph nodes → XML (systemPromptAddition)
  ├─ PPR ranking decides injection priority
  └─ Keep last N raw messages (fresh tail)

compact (background, async, non-blocking)
  ├─ Read gm_signals + gm_messages
  ├─ LLM extracts triples → gm_nodes + gm_edges
  └─ Does NOT block user messages (fire-and-forget)

session_end
  ├─ finalize (LLM): EVENT → SKILL promotion
  └─ maintenance (zero LLM): dedup → PageRank → community detection

Next session → before_agent_start
  ├─ FTS5/vector search for seed nodes
  ├─ Community expansion (same-cluster peers)
  ├─ Recursive CTE graph traversal
  └─ Personalized PageRank ranking → inject into context
```

### Personalized PageRank (PPR)

Unlike global PageRank, PPR ranks nodes **relative to your current query**:

- Ask about "Docker deployment" → Docker-related SKILLs rank highest
- Ask about "conda environment" → conda-related SKILLs rank highest
- Same graph, completely different rankings per query
- Computed in real-time at recall (~5ms for thousands of nodes)

## Installation

### Prerequisites

- [OpenClaw](https://github.com/anthropics/openclaw) with plugin context engine support
- Node.js 22+
- An LLM provider configured in OpenClaw

### Install from GitHub

```bash
openclaw plugins install github:adoresever/graph-memory
```

From a local OpenClaw checkout:

```bash
pnpm openclaw plugins install github:adoresever/graph-memory
```

### Local development

```bash
openclaw plugins install --link /path/to/graph-memory
```

### Configure

After installation, add LLM and embedding credentials to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "graph-memory": {
        "enabled": true,
        "config": {
          "llm": {
            "apiKey": "your-api-key",
            "baseURL": "https://api.openai.com/v1",
            "model": "gpt-4o-mini"
          },
          "embedding": {
            "apiKey": "your-api-key",
            "baseURL": "https://api.openai.com/v1",
            "model": "text-embedding-3-small",
            "dimensions": 512
          }
        }
      }
    }
  }
}
```

- **llm**: Required. Used for knowledge extraction. Use a cheap/fast model.
- **embedding**: Optional. Enables semantic search + vector dedup. Without it, falls back to FTS5 full-text search.
- All other parameters have sensible defaults — no need to set them.

Restart OpenClaw after configuration changes.

### Verify

```
[graph-memory] ready | db=~/.openclaw/graph-memory.db | provider=... | model=...
[graph-memory] vector search ready
```

```bash
sqlite3 ~/.openclaw/graph-memory.db "SELECT type, name, description FROM gm_nodes LIMIT 10;"
```

## Agent tools

| Tool | Description |
|------|-------------|
| `gm_search` | Search the knowledge graph for relevant skills, events, and solutions |
| `gm_record` | Manually record knowledge to the graph |
| `gm_stats` | View graph statistics: nodes, edges, communities, PageRank top nodes |
| `gm_maintain` | Manually trigger graph maintenance: dedup → PageRank → community detection |

## Configuration

All parameters have defaults. Only set what you want to override.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `dbPath` | `~/.openclaw/graph-memory.db` | SQLite database path |
| `compactTurnCount` | `7` | Messages needed to trigger knowledge extraction |
| `recallMaxNodes` | `6` | Max nodes injected per recall |
| `recallMaxDepth` | `2` | Graph traversal hops from seed nodes |
| `freshTailCount` | `10` | Recent messages kept as-is (not compressed) |
| `dedupThreshold` | `0.90` | Cosine similarity threshold for node dedup |
| `pagerankDamping` | `0.85` | PPR damping factor |
| `pagerankIterations` | `20` | PPR iteration count |

## Database

SQLite via `better-sqlite3`. Default: `~/.openclaw/graph-memory.db`.

| Table | Purpose |
|-------|---------|
| `gm_nodes` | Knowledge nodes with pagerank + community_id |
| `gm_edges` | Typed relationships |
| `gm_nodes_fts` | FTS5 full-text index |
| `gm_messages` | Raw conversation messages |
| `gm_signals` | Detected signals |
| `gm_vectors` | Embedding vectors (optional) |

## vs lossless-claw

| | lossless-claw | graph-memory |
|--|---|---|
| **Approach** | DAG of summaries | Knowledge graph (triples) |
| **Recall** | FTS grep + sub-agent expansion | FTS5/vector → PPR → graph traversal |
| **Cross-session** | Per-conversation only | Automatic cross-session recall |
| **Compression** | Summaries (lossy text) | Structured triples (lossless semantics) |
| **Graph algorithms** | None | PageRank, community detection, vector dedup |

## Development

```bash
npm install
npm test        # 53 tests
npx vitest      # watch mode
```

### Project structure

```
graph-memory/
├── index.ts                     # Plugin entry point
├── openclaw.plugin.json         # Plugin manifest
├── src/
│   ├── types.ts                 # Type definitions
│   ├── store/                   # SQLite CRUD / FTS5 / CTE traversal
│   ├── engine/                  # Signal detection, LLM, Embedding
│   ├── extractor/               # Knowledge extraction prompts
│   ├── recaller/                # Cross-session recall (PPR)
│   ├── format/                  # Context assembly + transcript repair
│   └── graph/                   # PageRank, community, dedup, maintenance
└── test/                        # 53 vitest tests
```

## License

MIT

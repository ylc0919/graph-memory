/**
 * graph-memory — Knowledge Graph Memory plugin for OpenClaw
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 *
 * v1.0.0：
 *   - 从 kg-memory 改名为 graph-memory
 *   - 个性化 PageRank（PPR）：根据用户当前问题动态排序，不是全局固定排名
 *   - 社区感知召回：同社区节点一起拉出
 *   - 向量余弦去重：语义重复的节点自动合并
 *   - session_end 时自动运行图维护（全局 PR 基线 + 社区检测 + 去重）
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { getDb } from "./src/store/db.ts";
import {
  saveMessage, saveSignal, pendingSignals, getUnextracted,
  markExtracted, markSignalsDone,
  upsertNode, upsertEdge, findByName,
  getBySession, edgesFrom, edgesTo,
  deprecate, getStats,
} from "./src/store/store.ts";
import { detectSignals } from "./src/engine/signals.ts";
import { createCompleteFn } from "./src/engine/llm.ts";
import { createEmbedFn } from "./src/engine/embed.ts";
import { Recaller } from "./src/recaller/recall.ts";
import { Extractor } from "./src/extractor/extract.ts";
import { assembleContext } from "./src/format/assemble.ts";
import { sanitizeToolUseResultPairing } from "./src/format/transcript-repair.ts";
import { runMaintenance } from "./src/graph/maintenance.ts";
import { invalidateGraphCache } from "./src/graph/pagerank.ts";
import { DEFAULT_CONFIG, type GmConfig } from "./src/types.ts";

// ─── 从 OpenClaw config 读 provider/model ────────────────────

function readProviderModel(apiConfig: unknown): { provider: string; model: string } {
  let raw = "";

  if (apiConfig && typeof apiConfig === "object") {
    const m = (apiConfig as any).agents?.defaults?.model;
    if (typeof m === "string" && m.trim()) {
      raw = m.trim();
    } else if (m && typeof m === "object" && typeof m.primary === "string" && m.primary.trim()) {
      raw = m.primary.trim();
    }
  }

  if (!raw) {
    raw = (process.env.OPENCLAW_PROVIDER ?? "anthropic") + "/claude-haiku-4-5-20251001";
  }

  if (raw.includes("/")) {
    const [provider, ...rest] = raw.split("/");
    const model = rest.join("/").trim();
    if (provider?.trim() && model) {
      return { provider: provider.trim(), model };
    }
  }

  const provider = (process.env.OPENCLAW_PROVIDER ?? "anthropic").trim();
  return { provider, model: raw };
}

// ─── 清洗 OpenClaw metadata 包装 ─────────────────────────────

function cleanPrompt(raw: string): string {
  let prompt = raw.trim();

  if (prompt.includes("Sender (untrusted metadata)")) {
    const jsonStart = prompt.indexOf("```json");
    if (jsonStart >= 0) {
      const jsonEnd = prompt.indexOf("```", jsonStart + 7);
      if (jsonEnd >= 0) {
        prompt = prompt.slice(jsonEnd + 3).trim();
      }
    }
    if (prompt.includes("Sender (untrusted metadata)")) {
      const lines = prompt.split("\n").filter(l => l.trim() && !l.includes("Sender") && !l.startsWith("```") && !l.startsWith("{"));
      prompt = lines.join("\n").trim();
    }
  }

  prompt = prompt.replace(/^\/\w+\s+/, "").trim();
  prompt = prompt.replace(/^\[[\w\s\-:]+\]\s*/, "").trim();

  return prompt;
}

// ─── 插件对象 ─────────────────────────────────────────────────

const graphMemoryPlugin = {
  id: "graph-memory",
  name: "Graph Memory",
  description:
    "知识图谱记忆引擎：从对话提取三元组，FTS5+图遍历+PageRank 跨对话召回，社区聚类+向量去重自动维护",

  register(api: OpenClawPluginApi) {
    // ── 读配置 ──────────────────────────────────────────────
    const raw =
      api.pluginConfig && typeof api.pluginConfig === "object"
        ? (api.pluginConfig as any)
        : {};
    const cfg: GmConfig = { ...DEFAULT_CONFIG, ...raw };
    const { provider, model } = readProviderModel(api.config);

    // ── 初始化核心模块 ──────────────────────────────────────
    const db = getDb(cfg.dbPath);
    const llm = createCompleteFn(provider, model, cfg.llm);
    const recaller = new Recaller(db, cfg);
    const extractor = new Extractor(cfg, llm);

    // ── 初始化 embedding ────────────────────────────────────
    createEmbedFn(cfg.embedding)
      .then((fn) => {
        if (fn) {
          recaller.setEmbedFn(fn);
          api.logger.info("[graph-memory] vector search ready");
        } else {
          api.logger.info("[graph-memory] FTS5 search mode (配置 embedding 可启用语义搜索)");
        }
      })
      .catch(() => {
        api.logger.info("[graph-memory] FTS5 search mode");
      });

    // ── Session 运行时状态 ──────────────────────────────────
    const msgSeq = new Map<string, number>();
    const recalled = new Map<string, { nodes: any[]; edges: any[] }>();

    // ── Compact 中断机制：用户对话第一优先级 ────────────────
    //
    // 问题：compact 调 LLM 提取知识，跟用户对话抢同一个 API 额度（RPM）
    // 方案：compact 在后台异步跑（不阻塞 afterTurn），用户发新消息时
    //       设置 abort 标志，正在跑的 compact 每个 batch 前检查，立即让路
    //
    const compactAbort = new Map<string, boolean>();  // sessionId → 是否应该中断
    const compactRunning = new Map<string, boolean>(); // sessionId → 是否正在跑

    /** 通知 compact 让路：用户有新消息了 */
    function interruptCompact(sessionId: string): void {
      if (compactRunning.get(sessionId)) {
        compactAbort.set(sessionId, true);
      }
    }

    /** 后台执行 compact，每个 batch 前检查是否被用户中断 */
    async function runCompactBackground(sessionId: string): Promise<void> {
      if (compactRunning.get(sessionId)) return; // 已经在跑了
      compactRunning.set(sessionId, true);
      compactAbort.set(sessionId, false);

      try {
        let batchNum = 0;
        const MAX_BATCHES = 10;
        let remaining = getUnextracted(db, sessionId, cfg.compactTurnCount * 3);

        while (remaining.length >= cfg.compactTurnCount && batchNum < MAX_BATCHES) {
          // ★ 每个 batch 前检查：用户有新消息？立即让路
          if (compactAbort.get(sessionId)) {
            api.logger.info(
              `[graph-memory] compact interrupted by user message (after ${batchNum} batches)`,
            );
            break;
          }

          batchNum++;
          const signals = pendingSignals(db, sessionId);

          api.logger.info(
            `[graph-memory] compact batch ${batchNum}: ${remaining.length} unextracted msgs`,
          );

          const existing = getBySession(db, sessionId).map((n) => n.name);
          const result = await extractor.extract({
            messages: remaining,
            signals,
            existingNames: existing,
          });

          // 提取完 LLM 调用后再检查一次
          if (compactAbort.get(sessionId)) {
            api.logger.info(
              `[graph-memory] compact interrupted after LLM call (batch ${batchNum}, discarding result)`,
            );
            break;
          }

          const nameToId = new Map<string, string>();
          for (const nc of result.nodes) {
            const { node } = upsertNode(db, {
              type: nc.type, name: nc.name,
              description: nc.description, content: nc.content,
            }, sessionId);
            nameToId.set(node.name, node.id);
            recaller.syncEmbed(node).catch(() => {});
          }

          for (const ec of result.edges) {
            const fromId = nameToId.get(ec.from) ?? findByName(db, ec.from)?.id;
            const toId = nameToId.get(ec.to) ?? findByName(db, ec.to)?.id;
            if (fromId && toId) {
              upsertEdge(db, {
                fromId, toId, type: ec.type,
                instruction: ec.instruction, condition: ec.condition, sessionId,
              });
            }
          }

          const maxTurn = Math.max(...remaining.map((m: any) => m.turn_index));
          markExtracted(db, sessionId, maxTurn);
          markSignalsDone(db, sessionId);

          api.logger.info(
            `[graph-memory] batch ${batchNum}: ${result.nodes.length} nodes, ${result.edges.length} edges`,
          );

          remaining = getUnextracted(db, sessionId, cfg.compactTurnCount * 3);
        }

        if (batchNum > 0) {
          invalidateGraphCache();
        }
      } catch (err) {
        api.logger.error(`[graph-memory] compact failed: ${err}`);
      } finally {
        compactRunning.set(sessionId, false);
        compactAbort.set(sessionId, false);
      }
    }

    function ingestMessage(sessionId: string, message: any): void {
      const seq = (msgSeq.get(sessionId) ?? 0) + 1;
      msgSeq.set(sessionId, seq);
      saveMessage(db, sessionId, seq, message.role ?? "unknown", message);
      for (const s of detectSignals(message, seq)) {
        saveSignal(db, sessionId, s);
      }
    }

    // ── before_agent_start：召回 ────────────────────────────

    api.on("before_agent_start", async (event: any, ctx: any) => {
      try {
        const rawPrompt = typeof event?.prompt === "string" ? event.prompt : "";
        const prompt = cleanPrompt(rawPrompt);
        if (!prompt) return;
        if (prompt.includes("/new or /reset") || prompt.includes("new session was started")) return;

        // ★ 用户发了新消息 → 中断正在跑的 compact，让 API 额度给用户
        const sid = ctx?.sessionId ?? ctx?.sessionKey;
        if (sid) interruptCompact(sid);

        api.logger.info(`[graph-memory] recall query: "${prompt.slice(0, 80)}"`);

        const res = await recaller.recall(prompt);
        if (res.nodes.length) {
          if (ctx?.sessionId) recalled.set(ctx.sessionId, res);
          if (ctx?.sessionKey && ctx.sessionKey !== ctx?.sessionId) {
            recalled.set(ctx.sessionKey, res);
          }
          api.logger.info(
            `[graph-memory] recalled ${res.nodes.length} nodes, ${res.edges.length} edges`,
          );
        }
      } catch (err) {
        api.logger.warn(`[graph-memory] recall failed: ${err}`);
      }
    });

    // ── ContextEngine ────────────────────────────────────────

    const engine = {
      info: {
        id: "graph-memory",
        name: "Graph Memory",
        ownsCompaction: true,
      },

      async bootstrap({ sessionId }: { sessionId: string }) {
        return { bootstrapped: true };
      },

      async ingest({
        sessionId,
        message,
        isHeartbeat,
      }: {
        sessionId: string;
        message: any;
        isHeartbeat?: boolean;
      }) {
        if (isHeartbeat) return { ingested: false };
        ingestMessage(sessionId, message);
        return { ingested: true };
      },

      async assemble({
        sessionId,
        messages,
        tokenBudget,
      }: {
        sessionId: string;
        messages: any[];
        tokenBudget?: number;
      }) {
        const budget = tokenBudget ?? 128_000;

        const activeNodes = getBySession(db, sessionId);
        const activeEdges = activeNodes.flatMap((n) => [
          ...edgesFrom(db, n.id),
          ...edgesTo(db, n.id),
        ]);

        const rec = recalled.get(sessionId) ?? { nodes: [], edges: [] };
        const totalGmNodes = activeNodes.length + rec.nodes.length;

        if (totalGmNodes === 0) {
          return { messages, estimatedTokens: 0 };
        }

        const { xml, systemPrompt, tokens: gmTokens } = assembleContext(db, {
          tokenBudget: budget,
          activeNodes,
          activeEdges,
          recalledNodes: rec.nodes,
          recalledEdges: rec.edges,
        });

        const freshTailCount = cfg.freshTailCount ?? 10;
        let assembled: any[];

        if (messages.length <= freshTailCount) {
          assembled = messages;
        } else {
          assembled = messages.slice(-freshTailCount);
          const trimmed = messages.length - freshTailCount;
          api.logger.info(
            `[graph-memory] assemble: trimmed ${trimmed} msgs → kept ${freshTailCount} tail`,
          );
        }

        const repaired = sanitizeToolUseResultPairing(assembled);

        let systemPromptAddition: string | undefined;
        if (xml) {
          systemPromptAddition = systemPrompt
            ? `${systemPrompt}\n\n${xml}`
            : xml;
        }

        let tailTokens = 0;
        for (const msg of repaired) {
          const content = typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content) ?? "";
          tailTokens += Math.ceil(content.length / 3);
        }

        return {
          messages: repaired,
          estimatedTokens: gmTokens + tailTokens,
          ...(systemPromptAddition ? { systemPromptAddition } : {}),
        };
      },

      async compact({
        sessionId,
        force,
        currentTokenCount,
      }: {
        sessionId: string;
        sessionFile: string;
        tokenBudget?: number;
        force?: boolean;
        currentTokenCount?: number;
      }) {
        const signals = pendingSignals(db, sessionId);
        const msgs = getUnextracted(db, sessionId, cfg.compactTurnCount * 3);

        if (!msgs.length) {
          return { ok: true, compacted: false, reason: "no messages" };
        }

        try {
          const existing = getBySession(db, sessionId).map((n) => n.name);
          const result = await extractor.extract({
            messages: msgs,
            signals,
            existingNames: existing,
          });

          const nameToId = new Map<string, string>();
          for (const nc of result.nodes) {
            const { node } = upsertNode(db, {
              type: nc.type, name: nc.name,
              description: nc.description, content: nc.content,
            }, sessionId);
            nameToId.set(node.name, node.id);
            recaller.syncEmbed(node).catch(() => {});
          }

          for (const ec of result.edges) {
            const fromId = nameToId.get(ec.from) ?? findByName(db, ec.from)?.id;
            const toId = nameToId.get(ec.to) ?? findByName(db, ec.to)?.id;
            if (fromId && toId) {
              upsertEdge(db, {
                fromId, toId, type: ec.type,
                instruction: ec.instruction, condition: ec.condition, sessionId,
              });
            }
          }

          const maxTurn = Math.max(...msgs.map((m: any) => m.turn_index));
          markExtracted(db, sessionId, maxTurn);
          markSignalsDone(db, sessionId);

          return {
            ok: true, compacted: true,
            result: {
              summary: `extracted ${result.nodes.length} nodes, ${result.edges.length} edges`,
              tokensBefore: currentTokenCount ?? 0,
            },
          };
        } catch (err) {
          api.logger.error(`[graph-memory] compact failed: ${err}`);
          return { ok: false, compacted: false, reason: String(err) };
        }
      },

      async afterTurn({
        sessionId,
        messages,
        prePromptMessageCount,
        isHeartbeat,
      }: {
        sessionId: string;
        sessionFile: string;
        messages: any[];
        prePromptMessageCount: number;
        autoCompactionSummary?: string;
        isHeartbeat?: boolean;
        tokenBudget?: number;
      }) {
        if (isHeartbeat) return;

        // 消息入库（同步，零 LLM，不阻塞）
        const newMessages = messages.slice(prePromptMessageCount ?? 0);
        for (const message of newMessages) {
          ingestMessage(sessionId, message);
        }

        const totalMsgs = msgSeq.get(sessionId) ?? 0;
        api.logger.info(
          `[graph-memory] afterTurn sid=${sessionId.slice(0, 8)} newMsgs=${newMessages.length} totalMsgs=${totalMsgs}`,
        );

        // ★ compact 放到后台异步跑，不 await，不阻塞 afterTurn 返回
        // 用户发新消息时 before_agent_start 会调 interruptCompact() 让它停下来
        runCompactBackground(sessionId).catch((err) => {
          api.logger.error(`[graph-memory] background compact failed: ${err}`);
        });
      },

      async prepareSubagentSpawn({
        parentSessionKey,
        childSessionKey,
      }: {
        parentSessionKey: string;
        childSessionKey: string;
      }) {
        const rec = recalled.get(parentSessionKey);
        if (rec) recalled.set(childSessionKey, rec);
        return { rollback: () => recalled.delete(childSessionKey) };
      },

      async onSubagentEnded({ childSessionKey }: { childSessionKey: string }) {
        recalled.delete(childSessionKey);
        msgSeq.delete(childSessionKey);
      },

      async dispose() {
        msgSeq.clear();
        recalled.clear();
      },
    };

    api.registerContextEngine("graph-memory", () => engine);

    // ── session_end：finalize + 图维护 ──────────────────────

    api.on("session_end", async (event: any, ctx: any) => {
      const sid =
        ctx?.sessionKey ??
        ctx?.sessionId ??
        event?.sessionKey ??
        event?.sessionId;
      if (!sid) return;

      try {
        const nodes = getBySession(db, sid);
        if (nodes.length) {
          const summary = (
            db.prepare(
              "SELECT name, type, validated_count, pagerank FROM gm_nodes WHERE status='active' ORDER BY pagerank DESC LIMIT 20",
            ).all() as any[]
          )
            .map((n) => `${n.type}:${n.name}(v${n.validated_count},pr${n.pagerank.toFixed(3)})`)
            .join(", ");

          const fin = await extractor.finalize({
            sessionNodes: nodes,
            graphSummary: summary,
          });

          for (const nc of fin.promotedSkills) {
            if (nc.name && nc.content) {
              upsertNode(db, {
                type: "SKILL", name: nc.name,
                description: nc.description ?? "", content: nc.content,
              }, sid);
            }
          }
          for (const ec of fin.newEdges) {
            const fromId = findByName(db, ec.from)?.id;
            const toId = findByName(db, ec.to)?.id;
            if (fromId && toId) {
              upsertEdge(db, {
                fromId, toId, type: ec.type,
                instruction: ec.instruction, sessionId: sid,
              });
            }
          }
          for (const id of fin.invalidations) deprecate(db, id);
        }

        // ██ 新增：运行图维护（PageRank + 社区检测 + 去重）
        const result = runMaintenance(db, cfg);
        api.logger.info(
          `[graph-memory] maintenance: ${result.durationMs}ms, ` +
          `dedup=${result.dedup.merged}, ` +
          `communities=${result.community.count}, ` +
          `top_pr=${result.pagerank.topK.slice(0, 3).map(n => `${n.name}(${n.score.toFixed(3)})`).join(",")}`,
        );
      } catch (err) {
        api.logger.error(`[graph-memory] session_end error: ${err}`);
      } finally {
        msgSeq.delete(sid);
        recalled.delete(sid);
      }
    });

    // ── Agent Tools（改名 gm_*）──────────────────────────────

    api.registerTool(
      (_ctx: any) => ({
        name: "gm_search",
        description: "搜索知识图谱中的相关经验、技能和解决方案。遇到可能之前解决过的问题时调用。",
        parameters: Type.Object({
          query: Type.String({ description: "搜索关键词或问题描述" }),
        }),
        async execute(_toolCallId: string, params: { query: string }) {
          const { query } = params;
          const res = await recaller.recall(query);
          if (!res.nodes.length) {
            return {
              content: [{ type: "text", text: "图谱中未找到相关记录。" }],
              details: { count: 0, query },
            };
          }

          const lines = res.nodes.map(
            (n) => `[${n.type}] ${n.name} (pr:${n.pagerank.toFixed(3)})\n${n.description}\n${n.content.slice(0, 400)}`,
          );
          const edgeLines = res.edges.map((e) => {
            const from = res.nodes.find((n) => n.id === e.fromId)?.name ?? e.fromId;
            const to = res.nodes.find((n) => n.id === e.toId)?.name ?? e.toId;
            return `  ${from} --[${e.type}]--> ${to}: ${e.instruction}`;
          });

          const text = [
            `找到 ${res.nodes.length} 个节点：\n`,
            ...lines,
            ...(edgeLines.length ? ["\n关系：", ...edgeLines] : []),
          ].join("\n\n");

          return {
            content: [{ type: "text", text }],
            details: { count: res.nodes.length, query },
          };
        },
      }),
      { name: "gm_search" },
    );

    api.registerTool(
      (ctx: any) => ({
        name: "gm_record",
        description: "手动记录经验到知识图谱。发现重要解法、踩坑经验或工作流程时调用。",
        parameters: Type.Object({
          name: Type.String({ description: "节点名称（全小写连字符）" }),
          type: Type.String({ description: "实体类型：TASK、SKILL 或 EVENT" }),
          description: Type.String({ description: "一句话说明" }),
          content: Type.String({ description: "Markdown 格式的知识内容" }),
          relatedSkill: Type.Optional(
            Type.String({ description: "可选：关联的已有技能名（建立 SOLVED_BY 关系）" }),
          ),
        }),
        async execute(
          _toolCallId: string,
          p: { name: string; type: string; description: string; content: string; relatedSkill?: string },
        ) {
          const sid = ctx?.sessionKey ?? ctx?.sessionId ?? "manual";
          const { node } = upsertNode(db, {
            type: p.type as any, name: p.name,
            description: p.description, content: p.content,
          }, sid);
          if (p.relatedSkill) {
            const rel = findByName(db, p.relatedSkill);
            if (rel) {
              upsertEdge(db, {
                fromId: node.id, toId: rel.id, type: "SOLVED_BY",
                instruction: `关联 ${p.relatedSkill}`, sessionId: sid,
              });
            }
          }
          recaller.syncEmbed(node).catch(() => {});
          return {
            content: [{ type: "text", text: `✅ 已记录：${node.name} (${node.type})` }],
            details: { name: node.name, type: node.type },
          };
        },
      }),
      { name: "gm_record" },
    );

    api.registerTool(
      (_ctx: any) => ({
        name: "gm_stats",
        description: "查看知识图谱的统计信息：节点数、边数、社区数、PageRank Top 节点。",
        parameters: Type.Object({}),
        async execute(_toolCallId: string, _params: any) {
          const stats = getStats(db);
          const topPr = (db.prepare(
            "SELECT name, type, pagerank FROM gm_nodes WHERE status='active' ORDER BY pagerank DESC LIMIT 5"
          ).all() as any[]);

          const text = [
            `📊 知识图谱统计`,
            `节点：${stats.totalNodes} 个 (${Object.entries(stats.byType).map(([t, c]) => `${t}: ${c}`).join(", ")})`,
            `边：${stats.totalEdges} 条 (${Object.entries(stats.byEdgeType).map(([t, c]) => `${t}: ${c}`).join(", ")})`,
            `社区：${stats.communities} 个`,
            `PageRank Top 5：`,
            ...topPr.map((n, i) => `  ${i + 1}. ${n.name} (${n.type}, pr=${n.pagerank.toFixed(4)})`),
          ].join("\n");
          return {
            content: [{ type: "text", text }],
            details: stats,
          };
        },
      }),
      { name: "gm_stats" },
    );

    // gm_maintain：手动触发图维护
    api.registerTool(
      (_ctx: any) => ({
        name: "gm_maintain",
        description: "手动触发图维护：运行去重、PageRank 重算、社区检测。通常 session_end 时自动运行，这个工具用于手动触发。",
        parameters: Type.Object({}),
        async execute(_toolCallId: string, _params: any) {
          const result = runMaintenance(db, cfg);
          const text = [
            `🔧 图维护完成（${result.durationMs}ms）`,
            `去重：发现 ${result.dedup.pairs.length} 对相似节点，合并 ${result.dedup.merged} 对`,
            ...(result.dedup.pairs.length > 0
              ? result.dedup.pairs.slice(0, 5).map(p =>
                  `  "${p.nameA}" ≈ "${p.nameB}" (${(p.similarity * 100).toFixed(1)}%)`)
              : []),
            `社区：${result.community.count} 个`,
            `PageRank Top 5：`,
            ...result.pagerank.topK.slice(0, 5).map((n, i) =>
              `  ${i + 1}. ${n.name} (${n.score.toFixed(4)})`),
          ].join("\n");
          return {
            content: [{ type: "text", text }],
            details: {
              durationMs: result.durationMs,
              dedupMerged: result.dedup.merged,
              communities: result.community.count,
            },
          };
        },
      }),
      { name: "gm_maintain" },
    );

    api.logger.info(
      `[graph-memory] ready | db=${cfg.dbPath} | provider=${provider} | model=${model}`,
    );
  },
};

export default graphMemoryPlugin;
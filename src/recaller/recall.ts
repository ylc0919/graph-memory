/**
 * graph-memory — 跨对话召回
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 *
 * 搜索链路（四层）：
 *
 * 第 1 层 — 找种子节点（FTS5 或向量搜索）
 * 第 2 层 — 社区扩展（同社区的相关节点）
 * 第 3 层 — 图遍历扩展（递归 CTE 沿边走 1-2 跳）
 * 第 4 层 — 个性化 PageRank 排序（从种子出发的 PPR）
 *
 * 关键区别：
 *   旧版用全局 pagerank 排序 → 每次结果都一样
 *   新版用个性化 PPR 排序 → 根据当前查询动态排序
 */

import Database from "better-sqlite3";
import { createHash } from "crypto";
import type { GmConfig, RecallResult, GmNode } from "../types.ts";
import type { EmbedFn } from "../engine/embed.ts";
import {
  searchNodes, vectorSearch, graphWalk, topNodes,
  saveVector, getVectorHash,
} from "../store/store.ts";
import { getCommunityPeers } from "../graph/community.ts";
import { personalizedPageRank } from "../graph/pagerank.ts";

export class Recaller {
  private embed: EmbedFn | null = null;

  constructor(private db: Database.Database, private cfg: GmConfig) {}

  setEmbedFn(fn: EmbedFn): void { this.embed = fn; }

  async recall(query: string): Promise<RecallResult> {
    const limit = this.cfg.recallMaxNodes;
    let seeds: GmNode[] = [];

    // ── 第 1 层：找种子节点 ──────────────────────────────────
    if (this.embed) {
      try {
        const vec = await this.embed(query);
        seeds = vectorSearch(this.db, vec, Math.ceil(limit / 2));
        if (seeds.length < 2) {
          const fts = searchNodes(this.db, query, limit);
          const seen = new Set(seeds.map(n => n.id));
          seeds.push(...fts.filter(n => !seen.has(n.id)));
        }
      } catch {
        seeds = searchNodes(this.db, query, limit);
      }
    } else {
      seeds = searchNodes(this.db, query, limit);
    }

    // 兜底：返回全局 PageRank 最高的节点
    if (!seeds.length) seeds = topNodes(this.db, Math.min(3, limit));
    if (!seeds.length) return { nodes: [], edges: [], tokenEstimate: 0 };

    const seedIds = seeds.map(n => n.id);

    // ── 第 2 层：社区扩展 ────────────────────────────────────
    const expandedIds = new Set(seedIds);
    for (const seed of seeds) {
      const peers = getCommunityPeers(this.db, seed.id, 2);
      for (const peerId of peers) {
        expandedIds.add(peerId);
      }
    }

    // ── 第 3 层：递归 CTE 图遍历 ────────────────────────────
    const { nodes, edges } = graphWalk(
      this.db,
      Array.from(expandedIds),
      this.cfg.recallMaxDepth,
    );

    if (!nodes.length) return { nodes: [], edges: [], tokenEstimate: 0 };

    // ── 第 4 层：个性化 PageRank 排序 ────────────────────────
    // 从种子节点出发传播权重，离用户问题越近的节点分数越高
    const candidateIds = nodes.map(n => n.id);
    const { scores: pprScores } = personalizedPageRank(
      this.db, seedIds, candidateIds, this.cfg,
    );

    // 排序：PPR 分数 > validatedCount > updatedAt
    const filtered = nodes
      .sort((a, b) =>
        (pprScores.get(b.id) || 0) - (pprScores.get(a.id) || 0) ||
        b.validatedCount - a.validatedCount ||
        b.updatedAt - a.updatedAt
      )
      .slice(0, limit);

    const ids = new Set(filtered.map(n => n.id));
    return {
      nodes: filtered,
      edges: edges.filter(e => ids.has(e.fromId) && ids.has(e.toId)),
      tokenEstimate: Math.ceil(filtered.reduce((s, n) => s + n.content.length + n.description.length, 0) / 3),
    };
  }

  /** 异步同步 embedding，不阻塞主流程 */
  async syncEmbed(node: GmNode): Promise<void> {
    if (!this.embed) return;
    const hash = createHash("md5").update(node.content).digest("hex");
    if (getVectorHash(this.db, node.id) === hash) return;
    try {
      const text = `${node.name}: ${node.description}\n${node.content.slice(0, 500)}`;
      const vec = await this.embed(text);
      if (vec.length) saveVector(this.db, node.id, node.content, vec);
    } catch { /* 不影响主流程 */ }
  }
}

/**
 * graph-memory — 图谱维护
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 *
 * 调用时机：session_end（finalize 之后）
 *
 * 执行顺序：
 *   1. 去重（先合并再算分数，避免重复节点干扰排名）
 *   2. 全局 PageRank（基线分数写入 DB，供 topNodes 兜底用）
 *   3. 社区检测（重新划分知识域）
 *
 * 注意：个性化 PPR 不在这里跑，它在 recall 时实时计算。
 */

import Database from "better-sqlite3";
import type { GmConfig } from "../types.ts";
import { computeGlobalPageRank, invalidateGraphCache, type GlobalPageRankResult } from "./pagerank.ts";
import { detectCommunities, type CommunityResult } from "./community.ts";
import { dedup, type DedupResult } from "./dedup.ts";

export interface MaintenanceResult {
  dedup: DedupResult;
  pagerank: GlobalPageRankResult;
  community: CommunityResult;
  durationMs: number;
}

export function runMaintenance(db: Database.Database, cfg: GmConfig): MaintenanceResult {
  const start = Date.now();

  // 去重/新增节点后清除图结构缓存
  invalidateGraphCache();

  // 1. 去重
  const dedupResult = dedup(db, cfg);

  // 去重可能合并了节点，再清一次缓存
  if (dedupResult.merged > 0) invalidateGraphCache();

  // 2. 全局 PageRank（基线）
  const pagerankResult = computeGlobalPageRank(db, cfg);

  // 3. 社区检测
  const communityResult = detectCommunities(db);

  return {
    dedup: dedupResult,
    pagerank: pagerankResult,
    community: communityResult,
    durationMs: Date.now() - start,
  };
}

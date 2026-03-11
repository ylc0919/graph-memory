/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

/**
 * 社区检测 — Label Propagation Algorithm
 *
 * 原理：每个节点初始自成一个社区，迭代中每个节点采纳邻居中最频繁的社区标签。
 *       收敛后自然形成社区划分。
 *
 * 为什么选 Label Propagation 而不是 Louvain：
 *   - 实现简单（50 行核心逻辑）
 *   - 不需要外部库
 *   - 对小图（< 10000 节点）效果够好
 *   - O(iterations * edges)，几千节点 < 5ms
 *
 * 用途：
 *   - 发现知识域（Docker 相关技能自动聚成一组）
 *   - recall 时可以拉整个社区的节点
 *   - assemble 时同社区节点放一起，上下文更连贯
 *   - kg_stats 展示社区分布
 */

import Database from "better-sqlite3";
import { updateCommunities } from "../store/store.ts";

export interface CommunityResult {
  labels: Map<string, string>;
  /** 社区 ID → 成员节点 ID 列表 */
  communities: Map<string, string[]>;
  count: number;
}

/**
 * 运行 Label Propagation 并写回 gm_nodes.community_id
 *
 * 把有向边当无向边处理（知识关联不分方向）
 */
export function detectCommunities(db: Database.Database, maxIter = 50): CommunityResult {
  // 读取活跃节点
  const nodeRows = db.prepare(
    "SELECT id FROM gm_nodes WHERE status='active'"
  ).all() as any[];

  if (nodeRows.length === 0) {
    return { labels: new Map(), communities: new Map(), count: 0 };
  }

  const nodeIds = nodeRows.map((r: any) => r.id);

  // 读取边，构建无向邻接表
  const edgeRows = db.prepare("SELECT from_id, to_id FROM gm_edges").all() as any[];
  const nodeSet = new Set(nodeIds);
  const adj = new Map<string, string[]>();

  for (const id of nodeIds) adj.set(id, []);

  for (const e of edgeRows) {
    if (!nodeSet.has(e.from_id) || !nodeSet.has(e.to_id)) continue;
    adj.get(e.from_id)!.push(e.to_id);
    adj.get(e.to_id)!.push(e.from_id);
  }

  // 初始标签：每个节点 = 自己的 ID
  const label = new Map<string, string>();
  for (const id of nodeIds) label.set(id, id);

  // 迭代
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;

    // 随机打乱遍历顺序（减少震荡）
    const shuffled = [...nodeIds];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    for (const nodeId of shuffled) {
      const neighbors = adj.get(nodeId) || [];
      if (neighbors.length === 0) continue;

      // 统计邻居标签频次
      const freq = new Map<string, number>();
      for (const nb of neighbors) {
        const l = label.get(nb)!;
        freq.set(l, (freq.get(l) || 0) + 1);
      }

      // 取频次最高的标签（相同频次取字典序最小，保证确定性）
      let bestLabel = label.get(nodeId)!;
      let bestCount = 0;
      for (const [l, c] of freq) {
        if (c > bestCount || (c === bestCount && l < bestLabel)) {
          bestLabel = l;
          bestCount = c;
        }
      }

      if (label.get(nodeId) !== bestLabel) {
        label.set(nodeId, bestLabel);
        changed = true;
      }
    }

    if (!changed) break;
  }

  // 构建社区映射
  const communities = new Map<string, string[]>();
  for (const [nodeId, communityId] of label) {
    if (!communities.has(communityId)) communities.set(communityId, []);
    communities.get(communityId)!.push(nodeId);
  }

  // 给社区编号（用最大成员数排序，编号 c-1, c-2, ...）
  const sorted = Array.from(communities.entries())
    .sort((a, b) => b[1].length - a[1].length);

  const renameMap = new Map<string, string>();
  sorted.forEach(([oldId], i) => renameMap.set(oldId, `c-${i + 1}`));

  // 重命名标签
  const finalLabels = new Map<string, string>();
  for (const [nodeId, oldLabel] of label) {
    finalLabels.set(nodeId, renameMap.get(oldLabel) || oldLabel);
  }

  const finalCommunities = new Map<string, string[]>();
  for (const [oldId, members] of communities) {
    const newId = renameMap.get(oldId) || oldId;
    finalCommunities.set(newId, members);
  }

  // 写回数据库
  updateCommunities(db, finalLabels);

  return {
    labels: finalLabels,
    communities: finalCommunities,
    count: finalCommunities.size,
  };
}

/**
 * 获取同社区的节点 ID 列表
 * recall 时用：找到种子节点 → 拉同社区的其他节点作为补充
 */
export function getCommunityPeers(db: Database.Database, nodeId: string, limit = 5): string[] {
  const row = db.prepare(
    "SELECT community_id FROM gm_nodes WHERE id=? AND status='active'"
  ).get(nodeId) as any;

  if (!row?.community_id) return [];

  return (db.prepare(`
    SELECT id FROM gm_nodes
    WHERE community_id=? AND id!=? AND status='active'
    ORDER BY pagerank DESC, validated_count DESC
    LIMIT ?
  `).all(row.community_id, nodeId, limit) as any[]).map(r => r.id);
}

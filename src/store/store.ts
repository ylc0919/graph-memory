/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

import Database from "better-sqlite3";
import { createHash } from "crypto";
import type { GmNode, GmEdge, EdgeType, NodeType, Signal } from "../types.ts";

// ─── 工具 ─────────────────────────────────────────────────────

function uid(p: string): string {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function toNode(r: any): GmNode {
  return {
    id: r.id, type: r.type, name: r.name,
    description: r.description ?? "", content: r.content,
    status: r.status, validatedCount: r.validated_count,
    sourceSessions: JSON.parse(r.source_sessions ?? "[]"),
    communityId: r.community_id ?? null,
    pagerank: r.pagerank ?? 0,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function toEdge(r: any): GmEdge {
  return {
    id: r.id, fromId: r.from_id, toId: r.to_id, type: r.type,
    instruction: r.instruction, condition: r.condition ?? undefined,
    sessionId: r.session_id, createdAt: r.created_at,
  };
}

/** 标准化 name：全小写，空格转连字符，保留中文 */
function normalizeName(name: string): string {
  return name.trim().toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fff\-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

// ─── 节点 CRUD ───────────────────────────────────────────────

export function findByName(db: Database.Database, name: string): GmNode | null {
  const r = db.prepare("SELECT * FROM gm_nodes WHERE name = ?").get(normalizeName(name)) as any;
  return r ? toNode(r) : null;
}

export function findById(db: Database.Database, id: string): GmNode | null {
  const r = db.prepare("SELECT * FROM gm_nodes WHERE id = ?").get(id) as any;
  return r ? toNode(r) : null;
}

export function allActiveNodes(db: Database.Database): GmNode[] {
  return (db.prepare("SELECT * FROM gm_nodes WHERE status='active'").all() as any[]).map(toNode);
}

export function allEdges(db: Database.Database): GmEdge[] {
  return (db.prepare("SELECT * FROM gm_edges").all() as any[]).map(toEdge);
}

export function upsertNode(
  db: Database.Database,
  c: { type: NodeType; name: string; description: string; content: string },
  sessionId: string,
): { node: GmNode; isNew: boolean } {
  const name = normalizeName(c.name);
  const ex = findByName(db, name);

  if (ex) {
    const sessions = JSON.stringify(Array.from(new Set([...ex.sourceSessions, sessionId])));
    const content = c.content.length > ex.content.length ? c.content : ex.content;
    const desc = c.description.length > ex.description.length ? c.description : ex.description;
    const count = ex.validatedCount + 1;
    db.prepare(`UPDATE gm_nodes SET content=?, description=?, validated_count=?,
      source_sessions=?, updated_at=? WHERE id=?`)
      .run(content, desc, count, sessions, Date.now(), ex.id);
    return { node: { ...ex, content, description: desc, validatedCount: count }, isNew: false };
  }

  const id = uid("n");
  db.prepare(`INSERT INTO gm_nodes
    (id, type, name, description, content, status, validated_count, source_sessions, created_at, updated_at)
    VALUES (?,?,?,?,?,'active',1,?,?,?)`)
    .run(id, c.type, name, c.description, c.content, JSON.stringify([sessionId]), Date.now(), Date.now());
  return { node: findByName(db, name)!, isNew: true };
}

export function deprecate(db: Database.Database, nodeId: string): void {
  db.prepare("UPDATE gm_nodes SET status='deprecated', updated_at=? WHERE id=?")
    .run(Date.now(), nodeId);
}

/** 合并两个节点：keepId 保留，mergeId 标记 deprecated，边迁移 */
export function mergeNodes(db: Database.Database, keepId: string, mergeId: string): void {
  const keep = findById(db, keepId);
  const merge = findById(db, mergeId);
  if (!keep || !merge) return;

  // 合并 validatedCount + sourceSessions
  const sessions = JSON.stringify(
    Array.from(new Set([...keep.sourceSessions, ...merge.sourceSessions]))
  );
  const count = keep.validatedCount + merge.validatedCount;
  const content = keep.content.length >= merge.content.length ? keep.content : merge.content;
  const desc = keep.description.length >= merge.description.length ? keep.description : merge.description;

  db.prepare(`UPDATE gm_nodes SET content=?, description=?, validated_count=?,
    source_sessions=?, updated_at=? WHERE id=?`)
    .run(content, desc, count, sessions, Date.now(), keepId);

  // 迁移边：mergeId 的边指向 keepId
  db.prepare("UPDATE gm_edges SET from_id=? WHERE from_id=?").run(keepId, mergeId);
  db.prepare("UPDATE gm_edges SET to_id=? WHERE to_id=?").run(keepId, mergeId);

  // 删除自环（合并后可能出现 keepId → keepId）
  db.prepare("DELETE FROM gm_edges WHERE from_id = to_id").run();

  // 删除重复边（同 from+to+type 只保留一条）
  db.prepare(`
    DELETE FROM gm_edges WHERE id NOT IN (
      SELECT MIN(id) FROM gm_edges GROUP BY from_id, to_id, type
    )
  `).run();

  deprecate(db, mergeId);
}

/** 批量更新 PageRank 分数 */
export function updatePageranks(db: Database.Database, scores: Map<string, number>): void {
  const stmt = db.prepare("UPDATE gm_nodes SET pagerank=? WHERE id=?");
  const tx = db.transaction(() => {
    for (const [id, score] of scores) {
      stmt.run(score, id);
    }
  });
  tx();
}

/** 批量更新社区 ID */
export function updateCommunities(db: Database.Database, labels: Map<string, string>): void {
  const stmt = db.prepare("UPDATE gm_nodes SET community_id=? WHERE id=?");
  const tx = db.transaction(() => {
    for (const [id, cid] of labels) {
      stmt.run(cid, id);
    }
  });
  tx();
}

// ─── 边 CRUD ─────────────────────────────────────────────────

export function upsertEdge(
  db: Database.Database,
  e: { fromId: string; toId: string; type: EdgeType; instruction: string; condition?: string; sessionId: string },
): void {
  const ex = db.prepare("SELECT id FROM gm_edges WHERE from_id=? AND to_id=? AND type=?")
    .get(e.fromId, e.toId, e.type) as any;
  if (ex) {
    db.prepare("UPDATE gm_edges SET instruction=? WHERE id=?")
      .run(e.instruction, ex.id);
    return;
  }
  db.prepare(`INSERT INTO gm_edges (id, from_id, to_id, type, instruction, condition, session_id, created_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(uid("e"), e.fromId, e.toId, e.type, e.instruction, e.condition ?? null, e.sessionId, Date.now());
}

export function edgesFrom(db: Database.Database, id: string): GmEdge[] {
  return (db.prepare("SELECT * FROM gm_edges WHERE from_id=?").all(id) as any[]).map(toEdge);
}

export function edgesTo(db: Database.Database, id: string): GmEdge[] {
  return (db.prepare("SELECT * FROM gm_edges WHERE to_id=?").all(id) as any[]).map(toEdge);
}

// ─── FTS5 搜索 ───────────────────────────────────────────────

let _fts5Available: boolean | null = null;

function fts5Available(db: Database.Database): boolean {
  if (_fts5Available !== null) return _fts5Available;
  try {
    db.prepare("SELECT * FROM gm_nodes_fts LIMIT 0").all();
    _fts5Available = true;
  } catch {
    _fts5Available = false;
  }
  return _fts5Available;
}

export function searchNodes(db: Database.Database, query: string, limit = 6): GmNode[] {
  const terms = query.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!terms.length) return topNodes(db, limit);

  if (fts5Available(db)) {
    try {
      const ftsQuery = terms.map(t => `"${t.replace(/"/g, "")}"`).join(" OR ");
      const rows = db.prepare(`
        SELECT n.*, rank FROM gm_nodes_fts fts
        JOIN gm_nodes n ON n.rowid = fts.rowid
        WHERE gm_nodes_fts MATCH ? AND n.status = 'active'
        ORDER BY rank LIMIT ?
      `).all(ftsQuery, limit) as any[];
      if (rows.length > 0) return rows.map(toNode);
    } catch { /* FTS 查询失败，降级 */ }
  }

  const where = terms.map(() => "(name LIKE ? OR description LIKE ? OR content LIKE ?)").join(" OR ");
  const likes = terms.flatMap(t => [`%${t}%`, `%${t}%`, `%${t}%`]);
  return (db.prepare(`
    SELECT * FROM gm_nodes WHERE status='active' AND (${where})
    ORDER BY pagerank DESC, validated_count DESC, updated_at DESC LIMIT ?
  `).all(...likes, limit) as any[]).map(toNode);
}

/** 热门节点：综合 pagerank + validatedCount 排序 */
export function topNodes(db: Database.Database, limit = 6): GmNode[] {
  return (db.prepare(`
    SELECT * FROM gm_nodes WHERE status='active'
    ORDER BY pagerank DESC, validated_count DESC, updated_at DESC LIMIT ?
  `).all(limit) as any[]).map(toNode);
}

// ─── 递归 CTE 图遍历 ────────────────────────────────────────

export function graphWalk(
  db: Database.Database,
  seedIds: string[],
  maxDepth: number,
): { nodes: GmNode[]; edges: GmEdge[] } {
  if (!seedIds.length) return { nodes: [], edges: [] };

  const placeholders = seedIds.map(() => "?").join(",");

  const walkRows = db.prepare(`
    WITH RECURSIVE walk(node_id, depth) AS (
      SELECT id, 0 FROM gm_nodes WHERE id IN (${placeholders}) AND status='active'
      UNION
      SELECT
        CASE WHEN e.from_id = w.node_id THEN e.to_id ELSE e.from_id END,
        w.depth + 1
      FROM walk w
      JOIN gm_edges e ON (e.from_id = w.node_id OR e.to_id = w.node_id)
      WHERE w.depth < ?
    )
    SELECT DISTINCT node_id FROM walk
  `).all(...seedIds, maxDepth) as any[];

  const nodeIds = walkRows.map((r: any) => r.node_id);
  if (!nodeIds.length) return { nodes: [], edges: [] };

  const np = nodeIds.map(() => "?").join(",");
  const nodes = (db.prepare(`
    SELECT * FROM gm_nodes WHERE id IN (${np}) AND status='active'
  `).all(...nodeIds) as any[]).map(toNode);

  const edges = (db.prepare(`
    SELECT * FROM gm_edges WHERE from_id IN (${np}) AND to_id IN (${np})
  `).all(...nodeIds, ...nodeIds) as any[]).map(toEdge);

  return { nodes, edges };
}

// ─── 按 session 查询 ────────────────────────────────────────

export function getBySession(db: Database.Database, sessionId: string): GmNode[] {
  return (db.prepare(`
    SELECT DISTINCT n.* FROM gm_nodes n, json_each(n.source_sessions) j
    WHERE j.value = ? AND n.status = 'active'
  `).all(sessionId) as any[]).map(toNode);
}

// ─── 消息 CRUD ───────────────────────────────────────────────

export function saveMessage(
  db: Database.Database, sid: string, turn: number, role: string, content: unknown
): void {
  db.prepare(`INSERT OR IGNORE INTO gm_messages (id, session_id, turn_index, role, content, created_at)
    VALUES (?,?,?,?,?,?)`)
    .run(uid("m"), sid, turn, role, JSON.stringify(content), Date.now());
}

export function getMessages(db: Database.Database, sid: string, limit?: number): any[] {
  if (limit) {
    return db.prepare("SELECT * FROM gm_messages WHERE session_id=? ORDER BY turn_index DESC LIMIT ?")
      .all(sid, limit) as any[];
  }
  return db.prepare("SELECT * FROM gm_messages WHERE session_id=? ORDER BY turn_index")
    .all(sid) as any[];
}

export function getUnextracted(db: Database.Database, sid: string, limit: number): any[] {
  return db.prepare("SELECT * FROM gm_messages WHERE session_id=? AND extracted=0 ORDER BY turn_index LIMIT ?")
    .all(sid, limit) as any[];
}

export function markExtracted(db: Database.Database, sid: string, upToTurn: number): void {
  db.prepare("UPDATE gm_messages SET extracted=1 WHERE session_id=? AND turn_index<=?")
    .run(sid, upToTurn);
}

// ─── 信号 CRUD ───────────────────────────────────────────────

export function saveSignal(db: Database.Database, sid: string, s: Signal): void {
  db.prepare(`INSERT INTO gm_signals (id, session_id, turn_index, type, data, created_at)
    VALUES (?,?,?,?,?,?)`)
    .run(uid("s"), sid, s.turnIndex, s.type, JSON.stringify(s.data), Date.now());
}

export function pendingSignals(db: Database.Database, sid: string): Signal[] {
  return (db.prepare("SELECT * FROM gm_signals WHERE session_id=? AND processed=0 ORDER BY turn_index")
    .all(sid) as any[])
    .map(r => ({ type: r.type, turnIndex: r.turn_index, data: JSON.parse(r.data) }));
}

export function markSignalsDone(db: Database.Database, sid: string): void {
  db.prepare("UPDATE gm_signals SET processed=1 WHERE session_id=?").run(sid);
}

// ─── 统计 ────────────────────────────────────────────────────

export function getStats(db: Database.Database): {
  totalNodes: number;
  byType: Record<string, number>;
  totalEdges: number;
  byEdgeType: Record<string, number>;
  communities: number;
} {
  const totalNodes = (db.prepare("SELECT COUNT(*) as c FROM gm_nodes WHERE status='active'").get() as any).c;
  const byType: Record<string, number> = {};
  for (const r of db.prepare("SELECT type, COUNT(*) as c FROM gm_nodes WHERE status='active' GROUP BY type").all() as any[]) {
    byType[r.type] = r.c;
  }
  const totalEdges = (db.prepare("SELECT COUNT(*) as c FROM gm_edges").get() as any).c;
  const byEdgeType: Record<string, number> = {};
  for (const r of db.prepare("SELECT type, COUNT(*) as c FROM gm_edges GROUP BY type").all() as any[]) {
    byEdgeType[r.type] = r.c;
  }
  const communities = (db.prepare(
    "SELECT COUNT(DISTINCT community_id) as c FROM gm_nodes WHERE status='active' AND community_id IS NOT NULL"
  ).get() as any).c;
  return { totalNodes, byType, totalEdges, byEdgeType, communities };
}

// ─── 向量存储 + 搜索 ────────────────────────────────────────

export function saveVector(db: Database.Database, nodeId: string, content: string, vec: number[]): void {
  const hash = createHash("md5").update(content).digest("hex");
  const blob = Buffer.from(new Float32Array(vec).buffer);
  db.prepare(`INSERT INTO gm_vectors (node_id, content_hash, embedding) VALUES (?,?,?)
    ON CONFLICT(node_id) DO UPDATE SET content_hash=excluded.content_hash, embedding=excluded.embedding`)
    .run(nodeId, hash, blob);
}

export function getVectorHash(db: Database.Database, nodeId: string): string | null {
  return (db.prepare("SELECT content_hash FROM gm_vectors WHERE node_id=?").get(nodeId) as any)?.content_hash ?? null;
}

/** 获取所有向量（供去重/聚类用） */
export function getAllVectors(db: Database.Database): Array<{ nodeId: string; embedding: Float32Array }> {
  const rows = db.prepare(`
    SELECT v.node_id, v.embedding FROM gm_vectors v
    JOIN gm_nodes n ON n.id = v.node_id WHERE n.status = 'active'
  `).all() as any[];
  return rows.map(r => {
    const buf = Buffer.from(r.embedding);
    // Buffer 可能有 byteOffset，必须 slice 出精确范围
    return {
      nodeId: r.node_id,
      embedding: new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
    };
  });
}

export function vectorSearch(db: Database.Database, queryVec: number[], limit: number, minScore = 0.35): GmNode[] {
  const rows = db.prepare(`
    SELECT v.node_id, v.embedding, n.*
    FROM gm_vectors v JOIN gm_nodes n ON n.id = v.node_id
    WHERE n.status = 'active'
  `).all() as any[];

  if (!rows.length) return [];

  const q = new Float32Array(queryVec);
  const qNorm = Math.sqrt(q.reduce((s, x) => s + x * x, 0));
  if (qNorm === 0) return [];

  return rows
    .map(row => {
      const buf = Buffer.from(row.embedding);
      const v = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      let dot = 0, vNorm = 0;
      const len = Math.min(v.length, q.length);
      for (let i = 0; i < len; i++) {
        dot += v[i] * q[i];
        vNorm += v[i] * v[i];
      }
      return { sim: dot / (Math.sqrt(vNorm) * qNorm + 1e-9), node: toNode(row) };
    })
    .filter(s => s.sim > minScore)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, limit)
    .map(s => s.node);
}
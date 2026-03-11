/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

import Database from "better-sqlite3";
import type { GmNode, GmEdge } from "../types.ts";

const CHARS_PER_TOKEN = 3;

/**
 * 构建知识图谱的 system prompt 引导文字
 */
export function buildSystemPromptAddition(params: {
  selectedNodes: Array<{ type: string; src: "active" | "recalled" }>;
  edgeCount: number;
}): string {
  const { selectedNodes, edgeCount } = params;
  if (selectedNodes.length === 0) return "";

  const recalledCount = selectedNodes.filter(n => n.src === "recalled").length;
  const hasRecalled = recalledCount > 0;
  const skillCount = selectedNodes.filter(n => n.type === "SKILL").length;
  const eventCount = selectedNodes.filter(n => n.type === "EVENT").length;
  const taskCount = selectedNodes.filter(n => n.type === "TASK").length;
  const isRich = selectedNodes.length >= 4 || edgeCount >= 3;

  const sections: string[] = [];

  sections.push(
    "## Graph Memory — 知识图谱记忆",
    "",
    "Below `<knowledge_graph>` is your accumulated experience from past conversations.",
    "It contains structured knowledge — NOT raw conversation history.",
    "",
    `Current graph: ${skillCount} skills, ${eventCount} events, ${taskCount} tasks, ${edgeCount} relationships.`,
  );

  if (hasRecalled) {
    sections.push(
      "",
      `**${recalledCount} nodes recalled from OTHER conversations** — these are proven solutions that worked before.`,
      "Apply them directly when the current situation matches their trigger conditions.",
    );
  }

  sections.push(
    "",
    "**Recall priority (IMPORTANT):**",
    "1. Check `<knowledge_graph>` below FIRST for matching SKILL/EVENT nodes",
    "2. Use `gm_search` tool to find related nodes NOT shown below",
    "3. Use `gm_record` tool to save new discoveries worth remembering",
    "4. Do NOT rely on MEMORY.md for task history — the graph is your primary memory",
    "",
    "**When to use the graph:**",
    '- User asks "what did we do before" / "之前做过什么" → answer from <knowledge_graph>',
    "- Encountering an error → check EVENT nodes for matching past errors and their SOLVED_BY skills",
    "- Starting a familiar task → check TASK nodes and their USED_SKILL edges for reusable workflows",
  );

  if (isRich) {
    sections.push(
      "",
      "**Graph navigation:** Edges show how knowledge connects:",
      "- `SOLVED_BY`: an EVENT was fixed by a SKILL — apply the skill when you see similar errors",
      "- `USED_SKILL`: a TASK used a SKILL — reuse the same approach for similar tasks",
      "- `PATCHES`: a newer SKILL corrects an older one — prefer the newer version",
      "- `CONFLICTS_WITH`: two SKILLs are mutually exclusive — check conditions before choosing",
    );
  }

  return sections.join("\n");
}

/**
 * 组装知识图谱为 XML context
 */
export function assembleContext(
  db: Database.Database,
  params: {
    tokenBudget: number;
    activeNodes: GmNode[];
    activeEdges: GmEdge[];
    recalledNodes: GmNode[];
    recalledEdges: GmEdge[];
  },
): { xml: string | null; systemPrompt: string; tokens: number } {
  const maxChars = params.tokenBudget * 0.15 * CHARS_PER_TOKEN;

  // 合并去重
  const map = new Map<string, GmNode & { src: "active" | "recalled" }>();
  for (const n of params.recalledNodes) map.set(n.id, { ...n, src: "recalled" });
  for (const n of params.activeNodes) map.set(n.id, { ...n, src: "active" });

  // 排序：本 session > SKILL优先 > validatedCount > 全局pagerank基线
  const TYPE_PRI: Record<string, number> = { SKILL: 3, TASK: 2, EVENT: 1 };
  const sorted = Array.from(map.values())
    .filter(n => n.status === "active")
    .sort((a, b) =>
      (a.src === b.src ? 0 : a.src === "active" ? -1 : 1) ||
      (TYPE_PRI[b.type] ?? 0) - (TYPE_PRI[a.type] ?? 0) ||
      b.validatedCount - a.validatedCount ||
      b.pagerank - a.pagerank
    );

  // 按 token 预算选择节点
  const selected: typeof sorted = [];
  let used = 0;
  for (const n of sorted) {
    const sz = n.content.length + n.name.length + n.description.length + 50;
    if (used + sz > maxChars) break;
    selected.push(n);
    used += sz;
  }

  if (!selected.length) return { xml: null, systemPrompt: "", tokens: 0 };

  const idToName = new Map<string, string>();
  for (const n of selected) idToName.set(n.id, n.name);

  const selectedIds = new Set(selected.map(n => n.id));
  const allEdges = [...params.activeEdges, ...params.recalledEdges];
  const seen = new Set<string>();
  const edges = allEdges.filter(e =>
    selectedIds.has(e.fromId) && selectedIds.has(e.toId) && !seen.has(e.id) && seen.add(e.id)
  );

  const nodesXml = selected.map(n => {
    const tag = n.type.toLowerCase();
    const srcAttr = n.src === "recalled" ? ` source="recalled"` : "";
    return `  <${tag} name="${n.name}" desc="${escapeXml(n.description)}"${srcAttr}>\n${n.content.trim()}\n  </${tag}>`;
  }).join("\n");

  const edgesXml = edges.length
    ? `\n  <edges>\n${edges.map(e => {
        const fromName = idToName.get(e.fromId) ?? e.fromId;
        const toName = idToName.get(e.toId) ?? e.toId;
        const cond = e.condition ? ` when="${escapeXml(e.condition)}"` : "";
        return `    <e type="${e.type}" from="${fromName}" to="${toName}"${cond}>${escapeXml(e.instruction)}</e>`;
      }).join("\n")}\n  </edges>`
    : "";

  const xml = `<knowledge_graph>\n${nodesXml}${edgesXml}\n</knowledge_graph>`;

  const systemPrompt = buildSystemPromptAddition({
    selectedNodes: selected.map(n => ({ type: n.type, src: n.src })),
    edgeCount: edges.length,
  });

  const fullContent = systemPrompt + "\n\n" + xml;
  return { xml, systemPrompt, tokens: Math.ceil(fullContent.length / CHARS_PER_TOKEN) };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

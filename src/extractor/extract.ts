/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

import type { GmConfig, ExtractionResult, FinalizeResult, Signal } from "../types.ts";
import type { CompleteFn } from "../engine/llm.ts";

// ─── 提取 Prompt ──────────────────────────────────────────────

const EXTRACT_SYS = `你是知识图谱提取引擎。从对话中提取结构化的知识三元组（实体+关系）。

## 输出格式

严格 JSON，禁止任何额外文字。

{
  "nodes": [ ... ],
  "edges": [ ... ]
}

## 实体 Schema

每个 node 必须包含以下 4 个字段，缺一不可：

{
  "type": "TASK 或 SKILL 或 EVENT",
  "name": "全小写连字符，3-5个词",
  "description": "一句话，说明什么场景触发",
  "content": "markdown 格式的知识内容（见模板）"
}

### TASK content 模板
## [名称]
### 目标
### 执行步骤
1. ...
### 结果

### SKILL content 模板
## [名称]
### 触发条件
### 执行步骤
1. ...
### 常见错误
- ... → ...

### EVENT content 模板
## [名称]
### 现象
### 原因
### 解决方法

### name 命名规范
TASK：动词-对象（extract-bilibili-danmaku）
SKILL：工具-操作（conda-env-create）
EVENT：现象-工具（importerror-libgl1）

## 关系 Schema

每条 edge 必须包含 from、to、type、instruction 四个字段，缺一不可。
type 只允许以下 5 种，方向和 instruction 内容严格按照定义。

### USED_SKILL
方向：TASK → SKILL
含义：任务执行过程中使用了该技能
instruction 写：第几步用的、怎么调用的、传了什么参数

### SOLVED_BY
方向：EVENT → SKILL 或 SKILL → SKILL
含义：该问题/错误被该技能解决
instruction 写：具体执行了什么命令/操作来解决
condition 写：什么错误或条件触发了这个解决方案（必填）

### REQUIRES
方向：SKILL → SKILL
含义：执行该技能前必须先完成另一个技能
instruction 写：为什么依赖、怎么判断前置条件是否已满足

### PATCHES
方向：SKILL → SKILL（新 → 旧）
含义：新技能修正/替代了旧技能
instruction 写：旧方案有什么问题、新方案改了什么

### CONFLICTS_WITH
方向：SKILL ↔ SKILL（双向）
含义：两个技能在同一场景互斥，不能同时使用
instruction 写：冲突的表现、应该选哪个

## 提取规则

1. 有信号的时刻（报错、纠正、工具调用、任务完成）优先提取
2. 用户纠正 AI 的错误也要提取
3. 已有节点列表会提供，相同事物使用已有 name
4. 没有知识产出时返回 {"nodes":[],"edges":[]}
5. 每条 edge 的 instruction 不能为空，必须写具体内容

只返回 JSON。禁止 markdown 包裹、禁止解释、禁止额外字段。`;

const EXTRACT_USER = (msgs: string, signals: Signal[], existing: string) => `## 对话记录
${msgs}

## 检测到的信号
${JSON.stringify(signals, null, 2)}

## 已有图谱节点
${existing || "（无）"}

## 提取示例

信号：[{"type":"tool_error","turnIndex":3,"data":{"snippet":"ImportError: libGL.so.1"}}]

输出：
{
  "nodes": [
    {
      "type": "EVENT",
      "name": "importerror-libgl1",
      "description": "Python 导入 cv2/paddleocr 时报 libGL.so.1 缺失",
      "content": "## importerror-libgl1\\n### 现象\\nImportError: libGL.so.1: cannot open shared object file\\n### 原因\\nOpenCV 依赖系统级 libGL 库，conda/pip 不自动安装\\n### 解决方法\\napt install -y libgl1-mesa-glx"
    },
    {
      "type": "SKILL",
      "name": "apt-install-libgl1",
      "description": "安装 libgl1 解决 OpenCV 系统依赖缺失",
      "content": "## apt-install-libgl1\\n### 触发条件\\nImportError: libGL.so.1: cannot open shared object file\\n### 执行步骤\\n1. sudo apt update\\n2. sudo apt install -y libgl1-mesa-glx\\n### 常见错误\\n- Permission denied → 加 sudo"
    }
  ],
  "edges": [
    {
      "from": "importerror-libgl1",
      "to": "apt-install-libgl1",
      "type": "SOLVED_BY",
      "instruction": "执行 apt install -y libgl1-mesa-glx 即可解决",
      "condition": "报 ImportError: libGL.so.1 时"
    }
  ]
}

现在请根据上方的对话记录和信号提取知识图谱。`;

// ─── 整理 Prompt ──────────────────────────────────────────────

const FINALIZE_SYS = `你是知识库维护专家，对本次对话产生的节点做最终整理。

任务：
1. 有通用价值的 EVENT → 升级为 SKILL（改名+完善 content）
2. 发现节点间新的关系（整体回顾才能看到的）
3. 因本次对话失效的旧节点 → 填入 invalidations（填 node_id）

关系只能是：USED_SKILL、SOLVED_BY、REQUIRES、PATCHES、CONFLICTS_WITH

没有需要处理的返回空数组。只返回 JSON。`;

const FINALIZE_USER = (nodes: any[], summary: string) =>
  `## 本次对话节点
${JSON.stringify(nodes.map(n => ({
  id: n.id, type: n.type, name: n.name,
  description: n.description, v: n.validatedCount
})), null, 2)}

## 图谱摘要
${summary}

返回：
{
  "promotedSkills": [{"type":"SKILL","name":"...","description":"...","content":"..."}],
  "newEdges": [{"from":"...","to":"...","type":"...","instruction":"..."}],
  "invalidations": ["node-id"]
}`;

// ─── Extractor ────────────────────────────────────────────────

export class Extractor {
  constructor(private _cfg: GmConfig, private llm: CompleteFn) {}

  async extract(params: {
    messages: any[];
    signals: Signal[];
    existingNames: string[];
  }): Promise<ExtractionResult> {
    const msgs = params.messages
      .map(m => `[${(m.role ?? "?").toUpperCase()} t=${m.turn_index ?? 0}]\n${
        String(typeof m.content === "string" ? m.content : JSON.stringify(m.content)).slice(0, 800)
      }`).join("\n\n---\n\n");

    const raw = await this.llm(
      EXTRACT_SYS,
      EXTRACT_USER(msgs, params.signals, params.existingNames.join(", ")),
    );

    if (process.env.GM_DEBUG) {
      console.log("\n  [DEBUG] LLM raw response (first 2000 chars):");
      console.log("  " + raw.slice(0, 2000).replace(/\n/g, "\n  "));
    }

    return this.parseExtract(raw);
  }

  async finalize(params: { sessionNodes: any[]; graphSummary: string }): Promise<FinalizeResult> {
    const raw = await this.llm(FINALIZE_SYS, FINALIZE_USER(params.sessionNodes, params.graphSummary));
    return this.parseFinalize(raw);
  }

  private parseExtract(raw: string): ExtractionResult {
    try {
      const json = extractJson(raw);
      const p = JSON.parse(json);
      return {
        nodes: (p.nodes ?? []).filter((n: any) => n.name && n.type && n.content),
        edges: (p.edges ?? []).filter((e: any) => e.from && e.to && e.type),
      };
    } catch (err) {
      if (process.env.GM_DEBUG) {
        console.log(`  [DEBUG] JSON parse failed: ${err}`);
        console.log(`  [DEBUG] raw content: ${raw.slice(0, 500)}`);
      }
      return { nodes: [], edges: [] };
    }
  }

  private parseFinalize(raw: string): FinalizeResult {
    try {
      const json = extractJson(raw);
      const p = JSON.parse(json);
      return {
        promotedSkills: p.promotedSkills ?? [],
        newEdges: p.newEdges ?? [],
        invalidations: p.invalidations ?? [],
      };
    } catch { return { promotedSkills: [], newEdges: [], invalidations: [] }; }
  }
}

function extractJson(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?\s*```\s*$/i, "");
  s = s.trim();
  if (s.startsWith("{") && s.endsWith("}")) return s;
  if (s.startsWith("[") && s.endsWith("]")) return s;
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last > first) return s.slice(first, last + 1);
  return s;
}

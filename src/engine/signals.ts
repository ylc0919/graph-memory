/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

import type { Signal } from "../types.ts";

/**
 * 信号检测：纯规则，零 LLM
 *
 * 不做任何"过滤"——所有消息都入库。
 * 信号的作用是标记"值得提取知识的时刻"，只有有信号的消息段才会触发 LLM 提取。
 */
export function detectSignals(message: any, turnIndex: number): Signal[] {
  if (!message) return [];
  const out: Signal[] = [];
  const role = message.role ?? "";

  // 1. 工具调用结果
  if (role === "tool" || role === "toolResult" || message.type === "tool_result") {
    const t = extractText(message);
    if (hasError(t)) {
      out.push({ type: "tool_error", turnIndex, data: { snippet: t.slice(0, 300) } });
    }
    if (t.length > 20 && !hasError(t)) {
      out.push({ type: "tool_success", turnIndex, data: { snippet: t.slice(0, 200) } });
    }
  }

  // 2. assistant 调用了工具
  if (role === "assistant" && Array.isArray(message.content)) {
    for (const b of message.content) {
      if (b.type === "tool_use" || b.type === "tool_call") {
        const toolName = b.name ?? b.toolName ?? "unknown";
        out.push({ type: "skill_invoked", turnIndex, data: { tool: toolName } });
      }
    }
  }

  // 3. 用户纠正
  if (role === "user") {
    const t = extractText(message);
    if (isCorrection(t)) {
      out.push({ type: "user_correction", turnIndex, data: { text: t.slice(0, 200) } });
    }
    if (isExplicitSave(t)) {
      out.push({ type: "explicit_record", turnIndex, data: { text: t.slice(0, 200) } });
    }
  }

  // 4. 任务完成
  if (role === "assistant") {
    const t = extractText(message);
    if (isDone(t)) {
      out.push({ type: "task_completed", turnIndex, data: { snippet: t.slice(0, 200) } });
    }
  }

  return out;
}

// ─── 文本提取 ────────────────────────────────────────────────

function extractText(msg: any): string {
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map((b: any) => {
      if (typeof b === "string") return b;
      if (b.type === "text") return b.text ?? "";
      if (b.type === "tool_result" || b.type === "toolResult") {
        return Array.isArray(b.content)
          ? b.content.filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n")
          : String(b.content ?? "");
      }
      return "";
    }).join("\n");
  }
  return "";
}

// ─── 规则匹配 ────────────────────────────────────────────────

const ERR_KEYWORDS = [
  "Error", "error", "Exception", "Traceback", "traceback",
  "failed", "Failed", "错误", "失败", "异常", "报错",
  "exit code 1", "ImportError", "ModuleNotFoundError",
  "PermissionError", "FileNotFoundError", "SyntaxError",
  "TypeError", "ValueError", "ConnectionError",
  "ENOENT", "EACCES", "EPERM", "ECONNREFUSED",
  "command not found", "No such file",
];
const hasError = (t: string) => ERR_KEYWORDS.some(k => t.includes(k));

const CORRECTION_PATTERNS = [
  /不对[，,。.！!]?/, /不是这样/, /换(一种|个)方式/, /重新来/,
  /这样不行/, /错了/, /应该是/,
  /no[,，\s]+(that'?s?|this)/i, /try (again|another|different)/i,
  /actually[,，\s]/i, /wrong/i,
];
const isCorrection = (t: string) => CORRECTION_PATTERNS.some(p => p.test(t));

const SAVE_PATTERNS = [
  /记住这个/, /记录(一下|下来)?/, /保存(这个|到图谱)?/,
  /remember this/i, /save this/i, /note (this|that) down/i,
];
const isExplicitSave = (t: string) => SAVE_PATTERNS.some(p => p.test(t));

const DONE_PATTERNS = [
  /已完成/, /完成了/, /成功(了|执行|运行)/,
  /done[.!]?$/i, /completed successfully/i, /✅/,
];
const isDone = (t: string) => DONE_PATTERNS.some(p => p.test(t));

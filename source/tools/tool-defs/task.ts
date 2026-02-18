import { t } from "structural";
import { unionAll } from "../../types.ts";
import { defineTool, ToolDef, ToolError, USER_ABORTED_ERROR_MESSAGE } from "../common.ts";
import {
  Agent,
  discoverAgents,
  resolveAgentModelOverride,
  subagentChoices,
} from "../../agents/agents.ts";
import { sequenceId, HistoryItem } from "../../history.ts";
import { trajectoryArc } from "../../agent/trajectory-arc.ts";
import { toLlmIR, outputToHistory } from "../../ir/convert-history-ir.ts";
import { loadTools, runTool } from "../index.ts";
import { assertKeyForModel, getModelFromConfig, ModelConfig } from "../../config.ts";
import { ToolCallRequest } from "../../ir/llm-ir.ts";
import { AbortError } from "../../transports/transport-common.ts";
import {
  appendLiveTaskTrace,
  clearLiveTaskRun,
  makeLiveTaskID,
  markLiveTaskFailed,
  setLiveTaskResult,
  startLiveTaskRun,
} from "../task-progress.ts";

type TaskSession = {
  id: string;
  subagentName: string;
  history: HistoryItem[];
};

type PeerContext = {
  index: number;
  total: number;
  peers: Array<{ subagentName: string; description: string }>;
};

type TaskInvocation = {
  description: string;
  prompt: string;
  subagent_type: string;
  task_id?: string;
};

const taskSessions = new Map<string, TaskSession>();
const MAX_TASK_SESSIONS = 48;
const MAX_SUBAGENT_HISTORY_ITEMS = 80;
const MAX_SUBAGENT_HISTORY_CHARS = 140000;
const MAX_SUBAGENT_TOOL_CONTENT_CHARS = 24000;
const MAX_SUBAGENT_ASSISTANT_CONTENT_CHARS = 24000;

function latestAssistantText(history: HistoryItem[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (item.type === "assistant") {
      const text = item.content.trim();
      if (text.length > 0) return text;
    }
  }
  return "";
}

function summarizeTaskTrace(history: HistoryItem[]): string {
  const lines: string[] = [];

  function asObject(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value != null ? (value as Record<string, unknown>) : {};
  }

  function summarizeToolRequest(name: string, args: unknown): string {
    const parsed = asObject(args);
    switch (name) {
      case "read":
        return typeof parsed["filePath"] === "string" ? parsed["filePath"] : "";
      case "list":
        return typeof parsed["dirPath"] === "string" ? parsed["dirPath"] : process.cwd();
      case "shell":
        return typeof parsed["cmd"] === "string" ? parsed["cmd"] : "";
      case "task": {
        const description = typeof parsed["description"] === "string" ? parsed["description"] : "";
        const subagentType =
          typeof parsed["subagent_type"] === "string" ? parsed["subagent_type"] : "unknown";
        return description ? `@${subagentType} ${description}` : `@${subagentType}`;
      }
      case "edit":
      case "create":
      case "append":
      case "prepend":
      case "rewrite":
        return typeof parsed["filePath"] === "string" ? parsed["filePath"] : "";
      case "fetch":
      case "web-search":
        return typeof parsed["url"] === "string" ? parsed["url"] : "";
      case "skill":
        return typeof parsed["skillName"] === "string" ? parsed["skillName"] : "";
      default:
        return "";
    }
  }

  function trimBlock(input: string, maxChars: number) {
    const trimmed = input.trim();
    if (trimmed.length <= maxChars) return trimmed;
    return trimmed.slice(0, maxChars) + "\n... (truncated)";
  }

  function outputPreview(content: string) {
    const maxLines = 20;
    const split = content.split("\n");
    const head = split.slice(0, maxLines).join("\n");
    const withLineNote =
      split.length > maxLines ? `${head}\n... (${split.length - maxLines} more lines)` : head;
    return trimBlock(withLineNote, 2000);
  }

  for (const item of history) {
    if (item.type === "user") {
      lines.push(`[user]\n${trimBlock(item.content, 1200)}`);
      continue;
    }
    if (item.type === "assistant") {
      if (item.reasoningContent && item.reasoningContent.trim().length > 0) {
        lines.push(`[reasoning]\n${trimBlock(item.reasoningContent, 1500)}`);
      }
      lines.push(`[assistant]\n${trimBlock(item.content, 2000)}`);
      continue;
    }
    if (item.type === "tool") {
      const summary = summarizeToolRequest(item.tool.function.name, item.tool.function.arguments);
      lines.push(`[tool-request] ${item.tool.function.name}${summary ? `\n${summary}` : ""}`);
      continue;
    }
    if (item.type === "tool-output") {
      const lineCount = item.result.lines ?? item.result.content.split("\n").length;
      lines.push(`[tool-output] ${lineCount} lines\n${outputPreview(item.result.content)}`);
      continue;
    }
    if (item.type === "tool-failed") {
      lines.push(`[tool-error] ${item.toolName}\n${trimBlock(item.error, 1200)}`);
      continue;
    }
    if (item.type === "tool-malformed") {
      lines.push(`[tool-malformed]\n${trimBlock(item.error, 1200)}`);
      continue;
    }
    if (item.type === "file-outdated") {
      lines.push("[file-outdated]");
      continue;
    }
    if (item.type === "file-unreadable") {
      lines.push(`[file-unreadable] ${item.path}`);
      continue;
    }
    if (item.type === "tool-reject") {
      lines.push("[tool-rejected]");
      continue;
    }
    if (item.type === "compaction-checkpoint") {
      lines.push("[compaction-checkpoint]");
      continue;
    }
  }

  return trimBlock(lines.join("\n\n"), 12000);
}

function buildObservedTaskOutput(params: {
  taskId: string;
  subagentName: string;
  description: string;
  trace: string;
  result: string;
}) {
  const trace =
    params.trace.length > 4000 ? `${params.trace.slice(0, 4000)}\n... (truncated)` : params.trace;
  const result =
    params.result.length > 2000
      ? `${params.result.slice(0, 2000)}\n... (truncated)`
      : params.result;
  return [
    `task_id: ${params.taskId}`,
    `task_subagent: ${params.subagentName}`,
    `task_description: ${params.description}`,
    "",
    "<task_trace>",
    trace,
    "</task_trace>",
    "",
    "<task_result>",
    result,
    "</task_result>",
  ].join("\n");
}

function buildParallelObservedTaskOutput(
  observations: Array<{
    taskId: string;
    subagentName: string;
    description: string;
    trace: string;
    result: string;
  }>,
) {
  const sections = observations.map(observation => {
    const trace =
      observation.trace.length > 3000
        ? `${observation.trace.slice(0, 3000)}\n... (truncated)`
        : observation.trace;
    const result =
      observation.result.length > 1500
        ? `${observation.result.slice(0, 1500)}\n... (truncated)`
        : observation.result;
    return [
      "<task_observation>",
      `task_id: ${observation.taskId}`,
      `task_subagent: ${observation.subagentName}`,
      `task_description: ${observation.description}`,
      "",
      "<task_trace>",
      trace,
      "</task_trace>",
      "",
      "<task_result>",
      result,
      "</task_result>",
      "</task_observation>",
    ].join("\n");
  });

  return [`task_parallel_count: ${observations.length}`, "", ...sections].join("\n");
}

function buildParallelAwarenessPrefix(invocation: TaskInvocation, peer: PeerContext): string {
  if (peer.total <= 1) return "";

  const peerLines = peer.peers
    .filter((_, i) => i !== peer.index)
    .map(p => `  - @${p.subagentName}: ${p.description}`)
    .join("\n");

  return [
    `[Parallel execution context]`,
    `You are worker ${peer.index + 1} of ${peer.total} running concurrently.`,
    `Your task: ${invocation.description}`,
    peerLines.length > 0 ? `Other workers running in parallel:\n${peerLines}` : "",
    `Scope discipline: complete only your assigned task. Do not modify artefacts owned by other workers.`,
    ``,
  ]
    .filter(line => line !== "")
    .join("\n");
}

function isAbortLikeError(error: unknown): boolean {
  if (error instanceof AbortError) return true;
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return error.name === "AbortError" || message.includes("aborted");
}

function sanitizeLiveText(input: string, maxChars: number): string {
  const trimmed = input.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars) + "\n... (truncated)";
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value != null ? (value as Record<string, unknown>) : {};
}

function summarizeToolRequest(name: string, args: unknown): string {
  const parsed = asObject(args);
  switch (name) {
    case "read":
      return typeof parsed["filePath"] === "string" ? parsed["filePath"] : "";
    case "list":
      return typeof parsed["dirPath"] === "string" ? parsed["dirPath"] : process.cwd();
    case "shell":
      return typeof parsed["cmd"] === "string" ? parsed["cmd"] : "";
    case "task": {
      const description = typeof parsed["description"] === "string" ? parsed["description"] : "";
      const subagentType =
        typeof parsed["subagent_type"] === "string" ? parsed["subagent_type"] : "unknown";
      return description ? `@${subagentType} ${description}` : `@${subagentType}`;
    }
    case "edit":
    case "create":
    case "append":
    case "prepend":
    case "rewrite":
      return typeof parsed["filePath"] === "string" ? parsed["filePath"] : "";
    case "fetch":
    case "web-search":
      return typeof parsed["url"] === "string" ? parsed["url"] : "";
    case "skill":
      return typeof parsed["skillName"] === "string" ? parsed["skillName"] : "";
    default:
      return "";
  }
}

function truncateSubagentToolContent(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return `${input.slice(0, maxChars)}\n... (truncated for subagent context)`;
}

function safeJsonLength(input: unknown): number {
  try {
    const serialized = JSON.stringify(input);
    return typeof serialized === "string" ? serialized.length : 0;
  } catch {
    return 0;
  }
}

function sanitizeSubagentHistoryItem(item: HistoryItem): HistoryItem {
  if (item.type !== "assistant") return item;
  return {
    ...item,
    content: sanitizeLiveText(item.content, MAX_SUBAGENT_ASSISTANT_CONTENT_CHARS),
    reasoningContent: item.reasoningContent
      ? sanitizeLiveText(item.reasoningContent, MAX_SUBAGENT_ASSISTANT_CONTENT_CHARS)
      : undefined,
    openai: undefined,
    anthropic: undefined,
  };
}

export function subagentModelConfig(model: ModelConfig): ModelConfig {
  return model;
}

function estimateHistoryItemSize(item: HistoryItem): number {
  if (item.type === "assistant") {
    return (
      item.content.length +
      (item.reasoningContent?.length ?? 0) +
      safeJsonLength(item.openai) +
      safeJsonLength(item.anthropic)
    );
  }
  if (item.type === "user" || item.type === "notification") {
    return item.content.length;
  }
  if (item.type === "tool-output") {
    return item.result.content.length;
  }
  if (item.type === "tool") {
    return JSON.stringify(item.tool.function.arguments).length;
  }
  if (item.type === "tool-failed" || item.type === "tool-malformed") {
    return item.error.length;
  }
  if (item.type === "file-unreadable") {
    return item.path.length;
  }
  return 40;
}

export function compactSubagentHistory(history: HistoryItem[]): HistoryItem[] {
  const trimmed = history.map(item => {
    const sanitized = sanitizeSubagentHistoryItem(item);
    if (sanitized.type !== "tool-output") return sanitized;
    const next = truncateSubagentToolContent(
      sanitized.result.content,
      MAX_SUBAGENT_TOOL_CONTENT_CHARS,
    );
    if (next === sanitized.result.content) return sanitized;
    return {
      ...sanitized,
      result: {
        ...sanitized.result,
        content: next,
      },
    } satisfies HistoryItem;
  });

  const keepFirstUser = trimmed[0]?.type === "user";
  const minLength = keepFirstUser ? 2 : 1;
  const sizeOf = (entries: HistoryItem[]) =>
    entries.reduce((sum, entry) => sum + estimateHistoryItemSize(entry), 0);
  let totalChars = sizeOf(trimmed);

  while (
    (trimmed.length > MAX_SUBAGENT_HISTORY_ITEMS || totalChars > MAX_SUBAGENT_HISTORY_CHARS) &&
    trimmed.length >= minLength
  ) {
    const removeIndex = keepFirstUser ? 1 : 0;
    const removed = trimmed.splice(removeIndex, 1)[0];
    if (!removed) break;
    totalChars -= estimateHistoryItemSize(removed);
  }

  return trimmed;
}

function storeTaskSession(taskId: string, session: TaskSession) {
  if (taskSessions.has(taskId)) taskSessions.delete(taskId);
  taskSessions.set(taskId, session);
  while (taskSessions.size > MAX_TASK_SESSIONS) {
    const oldest = taskSessions.keys().next().value as string | undefined;
    if (!oldest) break;
    taskSessions.delete(oldest);
  }
}

async function executeSubagentTool(
  abortSignal: AbortSignal,
  call: ToolCallRequest,
  config: Parameters<typeof getModelFromConfig>[0],
  transport: Parameters<typeof loadTools>[0],
  agent: Agent,
  allAgents: Agent[],
  live?: {
    toolCallId: string;
    taskId: string;
  },
): Promise<HistoryItem> {
  const loaded = await loadTools(transport, abortSignal, config, { agent, agents: allAgents });

  try {
    const result = await runTool(abortSignal, transport, loaded, call.function, config, null, {
      toolCallId: call.toolCallId,
    });
    if (live) {
      const lineCount = result.lines ?? result.content.split("\n").length;
      appendLiveTaskTrace(
        live.toolCallId,
        live.taskId,
        `[tool-output] ${lineCount} lines\n${sanitizeLiveText(result.content, 900)}`,
      );
    }
    const subagentContent = truncateSubagentToolContent(
      result.content,
      MAX_SUBAGENT_TOOL_CONTENT_CHARS,
    );
    return {
      type: "tool-output",
      id: sequenceId(),
      result: {
        content: subagentContent,
        lines: result.lines ?? result.content.split("\n").length,
      },
      toolCallId: call.toolCallId,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Tool execution failed";
    if (live) {
      appendLiveTaskTrace(
        live.toolCallId,
        live.taskId,
        `[tool-error] ${call.function.name}\n${message}`,
      );
    }
    return {
      type: "tool-failed",
      id: sequenceId(),
      error: message,
      toolCallId: call.toolCallId,
      toolName: call.function.name,
    };
  }
}

async function runSubagentUntilPause({
  session,
  abortSignal,
  transport,
  config,
  agent,
  allAgents,
  live,
}: {
  session: TaskSession;
  abortSignal: AbortSignal;
  transport: Parameters<typeof loadTools>[0];
  config: Parameters<typeof getModelFromConfig>[0];
  agent: Agent;
  allAgents: Agent[];
  live: {
    toolCallId: string;
    taskId: string;
  };
}): Promise<string> {
  while (true) {
    if (abortSignal.aborted) throw new ToolError(USER_ABORTED_ERROR_MESSAGE);

    const modelOverride = resolveAgentModelOverride(agent, null);
    const model = subagentModelConfig(getModelFromConfig(config, modelOverride));
    const apiKey = await assertKeyForModel(model, config);

    const finish = await trajectoryArc({
      apiKey,
      model,
      messages: toLlmIR(session.history),
      config,
      transport,
      abortSignal,
      agent,
      agents: allAgents,
      handler: {
        startResponse: () => {},
        responseProgress: () => {},
        startCompaction: () => {},
        compactionProgress: () => {},
        compactionParsed: () => {},
        autofixingJson: () => {},
        autofixingDiff: () => {},
        retryTool: () => {},
      },
    });

    const generated = outputToHistory(finish.irs).map(sanitizeSubagentHistoryItem);
    session.history.push(...generated);
    session.history = compactSubagentHistory(session.history);
    for (const item of generated) {
      if (item.type === "assistant") {
        const reasoning = sanitizeLiveText(item.reasoningContent ?? "", 1200);
        if (reasoning.length > 0) {
          appendLiveTaskTrace(live.toolCallId, live.taskId, `[reasoning]\n${reasoning}`);
        }
        const text = sanitizeLiveText(item.content, 1200);
        if (text.length > 0)
          appendLiveTaskTrace(live.toolCallId, live.taskId, `[assistant]\n${text}`);
        continue;
      }
      if (item.type === "tool") {
        const summary = summarizeToolRequest(item.tool.function.name, item.tool.function.arguments);
        appendLiveTaskTrace(
          live.toolCallId,
          live.taskId,
          `[tool-request] ${item.tool.function.name}${summary ? `\n${sanitizeLiveText(summary, 900)}` : ""}`,
        );
      }
    }

    if (finish.reason.type === "abort" || finish.reason.type === "needs-response") {
      const response = latestAssistantText(session.history);
      return response.length > 0 ? response : "Subagent finished without additional output.";
    }

    if (finish.reason.type === "request-error") {
      appendLiveTaskTrace(
        live.toolCallId,
        live.taskId,
        `[task-error]\nSubagent request failed: ${finish.reason.requestError}`,
      );
      return `Subagent request failed: ${finish.reason.requestError}`;
    }

    session.history.push(
      await executeSubagentTool(
        abortSignal,
        finish.reason.toolCall,
        config,
        transport,
        agent,
        allAgents,
        live,
      ),
    );
    session.history = compactSubagentHistory(session.history);
  }
}

async function executeTaskInvocation({
  invocation,
  plannedTaskId,
  toolCallId,
  candidates,
  abortSignal,
  transport,
  config,
  allAgents,
  peer,
}: {
  invocation: TaskInvocation;
  plannedTaskId: string;
  toolCallId: string;
  candidates: Agent[];
  abortSignal: AbortSignal;
  transport: Parameters<typeof loadTools>[0];
  config: Parameters<typeof getModelFromConfig>[0];
  allAgents: Agent[];
  peer?: PeerContext;
}) {
  const subagentName = invocation.subagent_type;
  const subagent = candidates.find(agent => agent.name === subagentName);
  if (!subagent) throw new ToolError(`Unknown subagent: ${subagentName}`);

  const taskId = invocation.task_id ?? plannedTaskId;
  const sessionKey = makeSessionKey(taskId);

  const session = taskSessions.get(sessionKey) ?? {
    id: taskId,
    subagentName,
    history: [],
  };

  if (session.subagentName !== subagentName) {
    throw new ToolError(
      `Task ${taskId} belongs to subagent ${session.subagentName}. Resume it with that same subagent.`,
    );
  }

  const awarenessPrefix = peer ? buildParallelAwarenessPrefix(invocation, peer) : "";
  const prompt = (awarenessPrefix + invocation.prompt).trim();
  if (prompt.length > 0) {
    appendLiveTaskTrace(toolCallId, taskId, `[user]\n${sanitizeLiveText(prompt, 1200)}`);
    session.history.push({
      type: "user",
      id: sequenceId(),
      content: prompt,
    });
  }

  storeTaskSession(sessionKey, session);

  const result = await runSubagentUntilPause({
    session,
    abortSignal,
    transport,
    config,
    agent: subagent,
    allAgents,
    live: {
      toolCallId,
      taskId,
    },
  });

  const trace = summarizeTaskTrace(session.history);
  setLiveTaskResult(toolCallId, taskId, result);
  return {
    taskId,
    subagentName,
    description: invocation.description,
    trace,
    result,
  };
}

function taskObservationFromFailure(params: {
  invocation: TaskInvocation;
  error: unknown;
  taskId: string;
}) {
  const message = params.error instanceof Error ? params.error.message : String(params.error);
  return {
    taskId: params.taskId,
    subagentName: params.invocation.subagent_type,
    description: params.invocation.description,
    trace: `[task-error]\n${message}`,
    result: `Subagent task failed: ${message}`,
  };
}

// Session keys are task_id-based so callers can resume across tool calls.
function makeSessionKey(taskId: string): string {
  return taskId;
}

// Validate that all task_ids are unique within a tool call
function validateTaskIdUniqueness(invocations: TaskInvocation[]): void {
  const seen = new Set<string>();
  const duplicates: string[] = [];

  for (const invocation of invocations) {
    const taskId = invocation.task_id;
    if (taskId == null) continue; // auto-generated IDs are always unique
    if (seen.has(taskId)) {
      duplicates.push(taskId);
    } else {
      seen.add(taskId);
    }
  }

  if (duplicates.length > 0) {
    const uniqueDuplicates = [...new Set(duplicates)];
    throw new ToolError(
      `Duplicate task_id${uniqueDuplicates.length > 1 ? "s" : ""} in parallel_tasks: ${uniqueDuplicates.join(", ")}. ` +
        `Each task in parallel_tasks must have a unique task_id.`,
    );
  }
}

export default defineTool(async function taskToolFactory(signal, transport, config) {
  const allAgents = await discoverAgents(transport, signal);
  const candidates = subagentChoices(allAgents);
  if (candidates.length === 0) return null;

  const names = candidates.map(agent => t.value(agent.name));
  const subagentSchema = names.length === 1 ? names[0] : unionAll(names);
  const InvocationSchema = t.subtype({
    description: t.str.comment("A short 3-5 word description of the delegated task"),
    prompt: t.str.comment("The full task instructions for the delegated subagent"),
    subagent_type: subagentSchema.comment("The name of the subagent to delegate this task to"),
    task_id: t.optional(t.str),
  });

  const ArgumentsSchema = t.subtype({
    description: t.str.comment("A short 3-5 word description of the delegated task"),
    prompt: t.str.comment("The full task instructions for the delegated subagent"),
    subagent_type: subagentSchema.comment("The name of the subagent to delegate this task to"),
    task_id: t.optional(t.str),
    parallel_tasks: t.optional(
      t
        .array(InvocationSchema)
        .comment("Optional: execute multiple independent delegated tasks in parallel"),
    ),
  });

  const available = JSON.stringify(
    candidates.map(a => ({ name: a.name, description: a.description })),
  );
  const Schema = t
    .subtype({
      name: t.value("task"),
      arguments: ArgumentsSchema,
    })
    .comment(
      `Delegate work to a specialized subagent and wait for its result. Available subagents: ${available}`,
    );

  return {
    Schema,
    ArgumentsSchema,
    async validate(_abortSignal, _transport, toolCall) {
      const selected = candidates.find(agent => agent.name === toolCall.arguments.subagent_type);
      if (!selected) throw new ToolError(`Unknown subagent: ${toolCall.arguments.subagent_type}`);

      const singleInvocation: TaskInvocation = {
        description: toolCall.arguments.description,
        prompt: toolCall.arguments.prompt,
        subagent_type: toolCall.arguments.subagent_type,
        task_id: toolCall.arguments.task_id,
      };
      const invocationInputs: TaskInvocation[] =
        toolCall.arguments.parallel_tasks && toolCall.arguments.parallel_tasks.length > 0
          ? toolCall.arguments.parallel_tasks
          : [singleInvocation];
      validateTaskIdUniqueness(invocationInputs);

      for (const task of toolCall.arguments.parallel_tasks ?? []) {
        const subagent = candidates.find(agent => agent.name === task.subagent_type);
        if (!subagent) throw new ToolError(`Unknown subagent: ${task.subagent_type}`);
      }
      return null;
    },
    async run(abortSignal, transport, call, _cfg, _modelOverride, meta) {
      const liveRunId = meta?.toolCallId ?? `task-live-${Date.now()}`;
      const singleInvocation: TaskInvocation = {
        description: call.arguments.description,
        prompt: call.arguments.prompt,
        subagent_type: call.arguments.subagent_type,
        task_id: call.arguments.task_id,
      };
      const invocationInputs: TaskInvocation[] =
        call.arguments.parallel_tasks && call.arguments.parallel_tasks.length > 0
          ? call.arguments.parallel_tasks
          : [singleInvocation];
      const planned = invocationInputs.map((invocation, index) => ({
        invocation,
        taskId: invocation.task_id ?? makeLiveTaskID(liveRunId, index),
      }));

      startLiveTaskRun(
        liveRunId,
        planned.map(entry => ({
          taskId: entry.taskId,
          subagentName: entry.invocation.subagent_type,
          description: entry.invocation.description,
          prompt: entry.invocation.prompt,
        })),
      );

      try {
        if (abortSignal.aborted) throw new ToolError(USER_ABORTED_ERROR_MESSAGE);
        const parallelTasks = call.arguments.parallel_tasks ?? [];

        if (parallelTasks.length > 0) {
          const peerSummaries = planned.map(entry => ({
            subagentName: entry.invocation.subagent_type,
            description: entry.invocation.description,
          }));
          const settled = await Promise.allSettled(
            planned.map((entry, index) =>
              executeTaskInvocation({
                invocation: entry.invocation,
                plannedTaskId: entry.taskId,
                toolCallId: liveRunId,
                candidates,
                abortSignal,
                transport,
                config,
                allAgents,
                peer: {
                  index,
                  total: planned.length,
                  peers: peerSummaries,
                },
              }),
            ),
          );
          const observations = settled.map((entry, idx) => {
            if (entry.status === "fulfilled") return entry.value;
            const failed = taskObservationFromFailure({
              invocation: planned[idx].invocation,
              taskId: planned[idx].taskId,
              error: entry.reason,
            });
            markLiveTaskFailed(
              liveRunId,
              failed.taskId,
              failed.result.replace(/^Subagent task failed:\s*/, ""),
            );
            return failed;
          });
          return {
            content: buildParallelObservedTaskOutput(observations),
          };
        }

        const invocation = planned[0].invocation;
        const observation = await executeTaskInvocation({
          invocation,
          plannedTaskId: planned[0].taskId,
          toolCallId: liveRunId,
          candidates,
          abortSignal,
          transport,
          config,
          allAgents,
        }).catch(error => {
          if (abortSignal.aborted || isAbortLikeError(error)) throw error;
          const failed = taskObservationFromFailure({
            invocation,
            taskId: planned[0].taskId,
            error,
          });
          markLiveTaskFailed(
            liveRunId,
            failed.taskId,
            failed.result.replace(/^Subagent task failed:\s*/, ""),
          );
          return failed;
        });

        return {
          content: buildObservedTaskOutput(observation),
        };
      } catch (error) {
        if (abortSignal.aborted || isAbortLikeError(error)) {
          throw new ToolError(USER_ABORTED_ERROR_MESSAGE);
        }
        throw error;
      } finally {
        clearLiveTaskRun(liveRunId);
      }
    },
  } satisfies ToolDef<t.GetType<typeof Schema>>;
});

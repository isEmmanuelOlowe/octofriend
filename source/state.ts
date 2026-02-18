import { Config, useConfig, getModelFromConfig, assertKeyForModel } from "./config.ts";
import {
  HistoryItem,
  UserItem,
  AssistantItem,
  CompactionCheckpointItem,
  sequenceId,
} from "./history.ts";
import { runTool, ToolError } from "./tools/index.ts";
import { create } from "zustand";
import { FileOutdatedError, fileTracker } from "./tools/file-tracker.ts";
import * as path from "path";
import { useShallow } from "zustand/shallow";
import { toLlmIR, outputToHistory } from "./ir/convert-history-ir.ts";
import { PaymentError, RateLimitError, CompactionRequestError } from "./errors.ts";
import { Transport, AbortError } from "./transports/transport-common.ts";
import { trajectoryArc } from "./agent/trajectory-arc.ts";
import { ToolCallRequest } from "./ir/llm-ir.ts";
import { throttledBuffer } from "./throttled-buffer.ts";
import { loadTools } from "./tools/index.ts";
import { clearLiveTaskRun, getLiveTaskRun, makeLiveTaskID } from "./tools/task-progress.ts";
import {
  Agent,
  discoverAgents,
  primaryAgents,
  resolveActiveAgent,
  resolveAgentModelOverride,
} from "./agents/agents.ts";

export type RunArgs = {
  config: Config;
  transport: Transport;
};

export type TaskObservation = {
  taskId: string;
  subagentName: string;
  description: string;
  trace: string;
  result: string;
};

export type AgentFocus =
  | { type: "main" }
  | {
      type: "task";
      taskId: string;
    };

export type TaskDashboardItem = {
  taskId: string;
  subagentName: string;
  description: string;
  status: "working" | "completed" | "failed";
  toolCalls: number;
  bytesReceived: number;
};

export type InflightResponseType = Omit<AssistantItem, "id" | "tokenUsage" | "outputTokens">;
export type UiState = {
  preMenuVimMode: "NORMAL" | "INSERT" | null;
  modeData:
    | {
        mode: "input";
        vimMode: "NORMAL" | "INSERT";
      }
    | {
        mode: "responding";
        inflightResponse: InflightResponseType;
        abortController: AbortController;
      }
    | {
        mode: "tool-request";
        toolReq: ToolCallRequest;
      }
    | {
        mode: "error-recovery";
      }
    | {
        mode: "payment-error";
        error: string;
      }
    | {
        mode: "rate-limit-error";
        error: string;
      }
    | {
        mode: "request-error";
        error: string;
        curlCommand: string | null;
      }
    | {
        mode: "compaction-error";
        error: string;
        curlCommand: string | null;
      }
    | {
        mode: "diff-apply";
        abortController: AbortController;
      }
    | {
        mode: "fix-json";
        abortController: AbortController;
      }
    | {
        mode: "compacting";
        inflightResponse: InflightResponseType;
        abortController: AbortController;
      }
    | {
        mode: "menu";
      }
    | {
        mode: "tool-waiting";
        abortController: AbortController;
      };
  modelOverride: string | null;
  agents: Agent[];
  activeAgentName: string | null;
  taskObservations: Record<string, TaskObservation>;
  taskObservationOrder: string[];
  liveTaskObservations: Record<string, TaskObservation>;
  liveTaskObservationOrder: string[];
  focus: AgentFocus;
  byteCount: number;
  query: string;
  history: Array<HistoryItem>;
  clearNonce: number;
  lastUserPromptId: bigint | null;
  whitelist: Set<string>;
  input: (args: RunArgs & { query: string }) => Promise<void>;
  runTool: (args: RunArgs & { toolReq: ToolCallRequest }) => Promise<void>;
  rejectTool: (toolCallId: string) => void;
  abortResponse: () => void;
  toggleMenu: () => void;
  openMenu: () => void;
  closeMenu: () => void;
  setVimMode: (vimMode: "INSERT" | "NORMAL") => void;
  resetPreMenuVimMode: () => void;
  setModelOverride: (m: string) => void;
  ensureAgents: (args: Pick<RunArgs, "transport">) => Promise<Agent[]>;
  cycleAgent: () => void;
  focusNextTask: () => void;
  focusPrevTask: () => void;
  setQuery: (query: string) => void;
  retryFrom: (
    mode: "payment-error" | "rate-limit-error" | "request-error" | "compaction-error",
    args: RunArgs,
  ) => Promise<void>;
  editAndRetryFrom: (mode: "request-error" | "compaction-error", args: RunArgs) => void;
  notify: (notif: string) => void;
  addToWhitelist: (whitelistKey: string) => Promise<void>;
  isWhitelisted: (whitelistKey: string) => Promise<boolean>;
  clearHistory: () => void;
  _maybeHandleAbort: (signal: AbortSignal) => boolean;
  _runAgent: (args: RunArgs) => Promise<void>;
};

export const useAppStore = create<UiState>((set, get) => ({
  preMenuVimMode: null,
  modeData: {
    mode: "input" as const,
    vimMode: "INSERT" as const,
  },
  history: [],
  modelOverride: null,
  agents: [],
  activeAgentName: null,
  taskObservations: {},
  taskObservationOrder: [],
  liveTaskObservations: {},
  liveTaskObservationOrder: [],
  focus: { type: "main" },
  byteCount: 0,
  query: "",
  clearNonce: 0,
  lastUserPromptId: null,
  whitelist: new Set<string>(),

  input: async ({ config, query, transport }) => {
    const userMessage: UserItem = {
      type: "user",
      id: sequenceId(),
      content: query,
    };

    let history = [...get().history, userMessage];
    set({ history, lastUserPromptId: userMessage.id });
    await get()._runAgent({ config, transport });
  },

  retryFrom: async (mode, args) => {
    if (get().modeData.mode === mode) {
      await get()._runAgent(args);
    }
  },

  editAndRetryFrom: (mode, _args) => {
    if (get().modeData.mode !== mode) {
      return;
    }

    const { history, lastUserPromptId, byteCount } = get();

    if (lastUserPromptId === null) {
      set({
        query: "",
        byteCount: 0,
        modeData: { mode: "input", vimMode: "INSERT" },
      });
      return;
    }

    const lastUserItem = history.find(item => item.id === lastUserPromptId);
    if (!lastUserItem || lastUserItem.type !== "user") {
      set({
        query: "",
        byteCount: 0,
        modeData: { mode: "input", vimMode: "INSERT" },
      });
      return;
    }

    const filteredHistory = history.filter(item => item.id < lastUserPromptId);
    set(state => ({
      history: filteredHistory,
      query: lastUserItem.content,
      byteCount: 0,
      clearNonce: state.clearNonce + 1,
      modeData: { mode: "input", vimMode: "INSERT" },
    }));
  },

  rejectTool: toolCallId => {
    set({
      history: [
        ...get().history,
        {
          type: "tool-reject",
          id: sequenceId(),
          toolCallId,
        },
      ],
      modeData: {
        mode: "input",
        vimMode: "INSERT",
      },
    });
  },

  abortResponse: () => {
    const { modeData } = get();
    if ("abortController" in modeData) modeData.abortController.abort();
  },

  _maybeHandleAbort: (signal: AbortSignal): boolean => {
    if (signal.aborted) {
      set({
        modeData: {
          mode: "input",
          vimMode: "INSERT",
        },
      });
      return true;
    }
    return false;
  },

  toggleMenu: () => {
    const { modeData } = get();
    if (modeData.mode === "input") {
      set({
        modeData: { mode: "menu" },
        preMenuVimMode: modeData.vimMode,
      });
    } else if (modeData.mode === "menu") {
      const { preMenuVimMode } = get();
      set({
        modeData: { mode: "input", vimMode: preMenuVimMode ?? "INSERT" },
        preMenuVimMode: null,
      });
    }
  },
  closeMenu: () => {
    const { preMenuVimMode } = get();
    set({
      modeData: { mode: "input", vimMode: preMenuVimMode ?? "INSERT" },
      preMenuVimMode: null,
    });
  },
  openMenu: () => {
    const { modeData } = get();
    const currentVimMode = modeData.mode === "input" ? modeData.vimMode : "INSERT";
    set({
      modeData: { mode: "menu" },
      preMenuVimMode: currentVimMode,
    });
  },

  setVimMode: (vimMode: "INSERT" | "NORMAL") => {
    const { modeData } = get();
    if (modeData.mode === "input") {
      set({
        modeData: { mode: "input", vimMode },
      });
    }
  },

  resetPreMenuVimMode: () => {
    set({ preMenuVimMode: "INSERT" });
  },

  setQuery: query => {
    set({ query });
  },

  setModelOverride: model => {
    set({
      modelOverride: model,
      history: [
        ...get().history,
        {
          type: "notification",
          id: sequenceId(),
          content: `Model: ${model}`,
        },
      ],
    });
  },

  ensureAgents: async ({ transport }) => {
    const abortController = new AbortController();
    const agents = await discoverAgents(transport, abortController.signal);
    const active = resolveActiveAgent(agents, get().activeAgentName);
    set({
      agents,
      activeAgentName: active.name,
    });
    return agents;
  },

  cycleAgent: () => {
    const allPrimary = primaryAgents(get().agents);
    if (allPrimary.length <= 1) return;

    const current = resolveActiveAgent(get().agents, get().activeAgentName);
    const idx = allPrimary.findIndex(agent => agent.name === current.name);
    const next = allPrimary[(idx + 1) % allPrimary.length];

    set({
      activeAgentName: next.name,
      history: [
        ...get().history,
        {
          type: "notification",
          id: sequenceId(),
          content: `Agent: ${next.name}`,
        },
      ],
    });
  },

  focusNextTask: () => {
    const { focus } = get();
    const taskObservationOrder = activeTaskOrder(get());
    if (taskObservationOrder.length === 0) return;

    if (focus.type === "main") {
      set({ focus: { type: "task", taskId: taskObservationOrder[0] } });
      return;
    }

    const currentIndex = taskObservationOrder.indexOf(focus.taskId);
    if (currentIndex < 0) {
      const latest = taskObservationOrder[taskObservationOrder.length - 1];
      set({ focus: { type: "task", taskId: latest } });
      return;
    }

    if (currentIndex === taskObservationOrder.length - 1) {
      set({ focus: { type: "main" } });
      return;
    }

    set({ focus: { type: "task", taskId: taskObservationOrder[currentIndex + 1] } });
  },

  focusPrevTask: () => {
    const { focus } = get();
    const taskObservationOrder = activeTaskOrder(get());
    if (taskObservationOrder.length === 0) return;

    if (focus.type === "main") {
      set({
        focus: { type: "task", taskId: taskObservationOrder[taskObservationOrder.length - 1] },
      });
      return;
    }

    const currentIndex = taskObservationOrder.indexOf(focus.taskId);
    if (currentIndex < 0) {
      const latest = taskObservationOrder[taskObservationOrder.length - 1];
      set({ focus: { type: "task", taskId: latest } });
      return;
    }

    if (currentIndex === 0) {
      set({ focus: { type: "main" } });
      return;
    }

    set({ focus: { type: "task", taskId: taskObservationOrder[currentIndex - 1] } });
  },

  notify: notif => {
    set({
      history: [
        ...get().history,
        {
          type: "notification",
          id: sequenceId(),
          content: notif,
        },
      ],
    });
  },

  clearHistory: () => {
    // Abort any ongoing responses to avoid polluting the new cleared state.
    const { abortResponse } = get();
    abortResponse();

    set(state => ({
      history: [],
      taskObservations: {},
      taskObservationOrder: [],
      liveTaskObservations: {},
      liveTaskObservationOrder: [],
      focus: { type: "main" },
      byteCount: 0,
      clearNonce: state.clearNonce + 1,
    }));
  },

  addToWhitelist: async (whitelistKey: string) => {
    const currentWhitelist = get().whitelist;
    const newWhitelist = new Set(currentWhitelist);
    newWhitelist.add(whitelistKey);
    set({ whitelist: newWhitelist });
  },

  isWhitelisted: async (whitelistKey: string) => {
    return get().whitelist.has(whitelistKey);
  },

  runTool: async ({ config, toolReq, transport }) => {
    const modelOverride = get().modelOverride;
    const activeAgent = resolveActiveAgent(get().agents, get().activeAgentName);
    const abortController = new AbortController();
    const liveTaskObservations = provisionalTaskObservationsFromRequest(toolReq);
    const liveTaskObservationOrder = liveTaskObservations.map(item => item.taskId);
    const liveMapped = Object.fromEntries(liveTaskObservations.map(item => [item.taskId, item]));
    set({
      modeData: {
        mode: "tool-waiting",
        abortController,
      },
      liveTaskObservations: liveMapped,
      liveTaskObservationOrder,
    });
    let livePoll: ReturnType<typeof setInterval> | null = null;
    let lastLiveUpdate = -1;
    const syncLiveProgress = () => {
      if (toolReq.function.name !== "task") return;
      const snapshot = getLiveTaskRun(toolReq.toolCallId);
      if (!snapshot) return;
      if (snapshot.updatedAt === lastLiveUpdate) return;
      lastLiveUpdate = snapshot.updatedAt;
      const mapped: Record<string, TaskObservation> = {};
      for (const taskId of snapshot.order) {
        const observation = snapshot.observations[taskId];
        if (!observation) continue;
        mapped[taskId] = observation;
      }
      set({
        liveTaskObservations: mapped,
        liveTaskObservationOrder: snapshot.order,
      });
    };
    if (toolReq.function.name === "task") {
      syncLiveProgress();
      livePoll = setInterval(syncLiveProgress, 300);
    }

    const tools = await loadTools(transport, abortController.signal, config, {
      agent: activeAgent,
      agents: get().agents,
    });
    try {
      const result = await runTool(
        abortController.signal,
        transport,
        tools,
        toolReq.function,
        config,
        modelOverride,
        { toolCallId: toolReq.toolCallId },
      );

      const toolHistoryItem: HistoryItem = {
        type: "tool-output",
        id: sequenceId(),
        result,
        toolCallId: toolReq.toolCallId,
      };

      const history: HistoryItem[] = [...get().history, toolHistoryItem];
      const taskObservations =
        toolReq.function.name === "task" ? parseTaskObservationsFromToolOutput(result.content) : [];

      if (taskObservations.length > 0) {
        const prevOrder = get().taskObservationOrder;
        const existing = new Set(prevOrder);
        const appended = taskObservations
          .map(observation => observation.taskId)
          .filter(taskId => !existing.has(taskId));
        const taskObservationOrder = [...prevOrder, ...appended];
        const mapped = Object.fromEntries(
          taskObservations.map(observation => [observation.taskId, observation]),
        );
        const currentFocus = get().focus;
        const nextFocus =
          currentFocus.type === "task" && mapped[currentFocus.taskId] != null
            ? currentFocus
            : ({ type: "main" } as const);
        set({
          history,
          taskObservations: {
            ...get().taskObservations,
            ...mapped,
          },
          taskObservationOrder,
          liveTaskObservations: {},
          liveTaskObservationOrder: [],
          focus: nextFocus,
        });
      } else {
        const focus = get().focus;
        set({
          history,
          liveTaskObservations: {},
          liveTaskObservationOrder: [],
          ...(focus.type === "task" && get().liveTaskObservations[focus.taskId] != null
            ? { focus: { type: "main" as const } }
            : {}),
        });
      }
    } catch (e) {
      const history = [
        ...get().history,
        await tryTransformToolError(abortController.signal, transport, toolReq, e),
      ];
      const focus = get().focus;
      set({
        history,
        liveTaskObservations: {},
        liveTaskObservationOrder: [],
        ...(focus.type === "task" && get().liveTaskObservations[focus.taskId] != null
          ? { focus: { type: "main" as const } }
          : {}),
      });
    } finally {
      if (livePoll) clearInterval(livePoll);
      clearLiveTaskRun(toolReq.toolCallId);
    }

    if (get()._maybeHandleAbort(abortController.signal)) {
      return;
    }
    await get()._runAgent({ config, transport });
  },

  _runAgent: async ({ config, transport }) => {
    const loadedAgents = await get().ensureAgents({ transport });
    const activeAgent = resolveActiveAgent(loadedAgents, get().activeAgentName);
    const historyCopy = [...get().history];
    const abortController = new AbortController();
    let compactionByteCount = 0;
    let responseByteCount = 0;
    const model = getModelFromConfig(
      config,
      resolveAgentModelOverride(activeAgent, get().modelOverride),
    );
    const apiKey = await assertKeyForModel(model, config);

    const throttle = throttledBuffer<Partial<Parameters<typeof set>[0]>>(200, set);

    try {
      const finish = await trajectoryArc({
        apiKey,
        model,
        messages: toLlmIR(historyCopy),
        config,
        transport,
        abortSignal: abortController.signal,
        agent: activeAgent,
        agents: loadedAgents,
        handler: {
          startResponse: () => {
            throttle.flush();
            set({
              modeData: {
                mode: "responding",
                inflightResponse: {
                  type: "assistant",
                  content: "",
                },
                abortController,
              },
              byteCount: responseByteCount,
            });
          },

          responseProgress: event => {
            responseByteCount += event.delta.value.length;
            throttle.emit({
              modeData: {
                mode: "responding",
                inflightResponse: {
                  type: "assistant",
                  reasoningContent: event.buffer.reasoning,
                  content: event.buffer.content || "",
                },
                abortController,
              },
              byteCount: responseByteCount,
            });
          },

          startCompaction: () => {
            throttle.flush();
            set({
              modeData: {
                mode: "compacting",
                inflightResponse: {
                  type: "assistant",
                  content: "",
                },
                abortController,
              },
              byteCount: compactionByteCount,
            });
          },

          compactionProgress: event => {
            compactionByteCount += event.delta.value.length;
            throttle.emit({
              modeData: {
                mode: "compacting",
                inflightResponse: {
                  type: "assistant",
                  reasoningContent: event.buffer.reasoning,
                  content: event.buffer.content || "",
                },
                abortController,
              },
              byteCount: compactionByteCount,
            });
          },

          compactionParsed: event => {
            throttle.flush();
            const checkpointItem: CompactionCheckpointItem = {
              type: "compaction-checkpoint",
              id: sequenceId(),
              summary: event.checkpoint.summary,
            };
            set({ history: [...historyCopy, checkpointItem] });
          },

          autofixingJson: () => {
            throttle.flush();
            set({
              modeData: {
                mode: "fix-json",
                abortController,
              },
            });
          },

          autofixingDiff: () => {
            throttle.flush();
            set({
              modeData: {
                mode: "diff-apply",
                abortController,
              },
            });
          },

          retryTool: event => {
            throttle.flush();
            set({ history: [...historyCopy, ...outputToHistory(event.irs)] });
          },
        },
      });
      throttle.flush();
      historyCopy.push(...outputToHistory(finish.irs));
      set({ history: [...historyCopy] });
      const finishReason = finish.reason;
      if (finishReason.type === "abort" || finishReason.type === "needs-response") {
        set({ modeData: { mode: "input", vimMode: "INSERT" } });
        return;
      }

      if (finishReason.type === "request-error") {
        set({
          modeData: {
            mode: "request-error",
            error: finishReason.requestError,
            curlCommand: finishReason.curl,
          },
        });
        return;
      }

      set({
        modeData: {
          mode: "tool-request",
          toolReq: finishReason.toolCall,
        },
      });
    } catch (e) {
      if (e instanceof CompactionRequestError) {
        set({
          modeData: {
            mode: "compaction-error",
            error: e.requestError,
            curlCommand: e.curl,
          },
          history: [
            ...get().history,
            {
              type: "compaction-failed",
              id: sequenceId(),
            },
          ],
        });
        return;
      }
      if (get()._maybeHandleAbort(abortController.signal)) {
        return;
      }

      if (e instanceof PaymentError) {
        set({ modeData: { mode: "payment-error", error: e.message } });
        return;
      } else if (e instanceof RateLimitError) {
        set({ modeData: { mode: "rate-limit-error", error: e.message } });
        return;
      }

      throw e;
    } finally {
      set({ byteCount: 0 });
    }
  },
}));

async function tryTransformToolError(
  signal: AbortSignal,
  transport: Transport,
  toolReq: ToolCallRequest,
  e: unknown,
): Promise<HistoryItem> {
  if (e instanceof AbortError || (e instanceof Error && e.name === "AbortError")) {
    return {
      type: "tool-failed",
      id: sequenceId(),
      error: "Aborted by user",
      toolCallId: toolReq.toolCallId,
      toolName: toolReq.function.name,
    };
  }
  if (e instanceof ToolError) {
    return {
      type: "tool-failed",
      id: sequenceId(),
      error: e.message,
      toolCallId: toolReq.toolCallId,
      toolName: toolReq.function.name,
    };
  }
  if (e instanceof FileOutdatedError) {
    const absolutePath = path.resolve(e.filePath);
    // Actually perform the read to ensure it's readable
    try {
      await fileTracker.readUntracked(transport, signal, absolutePath);
      return {
        type: "file-outdated",
        id: sequenceId(),
        toolCallId: toolReq.toolCallId,
        error:
          "File could not be updated because it was modified after being last read. Please read the file again before modifying it.",
      };
    } catch {
      return {
        type: "file-unreadable",
        path: e.filePath,
        id: sequenceId(),
        toolCallId: toolReq.toolCallId,
        error: `File ${e.filePath} could not be read. Has it been deleted?`,
      };
    }
  }
  throw e;
}

function parseTaskObservationBlock(content: string): TaskObservation | null {
  const id = content.match(/^task_id:\s*(.+)$/m)?.[1]?.trim();
  const subagentName = content.match(/^task_subagent:\s*(.+)$/m)?.[1]?.trim();
  const description = content.match(/^task_description:\s*(.+)$/m)?.[1]?.trim();
  const traceMatch = content.match(/<task_trace>\n?([\s\S]*?)\n?<\/task_trace>/m);
  const resultMatch = content.match(/<task_result>\n?([\s\S]*?)\n?<\/task_result>/m);

  // Required fields: id, subagentName, description must be present and non-empty
  if (!id || !subagentName || !description) return null;

  // trace and result are optional - use empty string if tags are missing or content is empty
  const trace = traceMatch ? traceMatch[1].trim() : "";
  const result = resultMatch ? resultMatch[1].trim() : "";

  return {
    taskId: id,
    subagentName,
    description,
    trace,
    result,
  };
}

function provisionalTaskObservationsFromRequest(toolReq: ToolCallRequest): TaskObservation[] {
  if (toolReq.function.name !== "task") return [];

  const args = toolReq.function.arguments;
  const tasks = (args.parallel_tasks ?? [
    {
      description: args.description,
      subagent_type: args.subagent_type,
      prompt: args.prompt,
      task_id: args.task_id,
    },
  ]) as Array<{ description: string; subagent_type: string; prompt?: string; task_id?: string }>;

  return tasks.map((task, index) => ({
    taskId: task.task_id ?? makeLiveTaskID(toolReq.toolCallId, index),
    subagentName: task.subagent_type,
    description: task.description,
    trace: `status: running\nsubagent: @${task.subagent_type}\n\nprompt:\n${(task.prompt ?? "").slice(0, 400)}`,
    result: "Subagent is running. Waiting for first tool outputs...",
  }));
}

function activeTaskOrder(
  state: Pick<UiState, "liveTaskObservationOrder" | "taskObservationOrder">,
) {
  if (state.liveTaskObservationOrder.length > 0) return state.liveTaskObservationOrder;
  return state.taskObservationOrder;
}

function getTaskStatus(observation: TaskObservation): TaskDashboardItem["status"] {
  const trace = observation.trace.toLowerCase();
  const result = observation.result.toLowerCase();
  if (trace.includes("[task-error]") || result.includes("subagent task failed")) return "failed";
  if (trace.includes("status: running") || result.includes("subagent is running")) return "working";
  return "completed";
}

function countTaskToolCalls(trace: string): number {
  const matches = trace.match(/\[tool-request\]|tool-request:/g);
  return matches?.length ?? 0;
}

function countTaskBytes(observation: TaskObservation): number {
  return Buffer.byteLength(`${observation.trace}\n${observation.result}`, "utf8");
}

export function taskDashboardFromState(
  state: Pick<
    UiState,
    | "taskObservations"
    | "taskObservationOrder"
    | "liveTaskObservations"
    | "liveTaskObservationOrder"
  >,
): TaskDashboardItem[] {
  return activeTaskOrder(state)
    .map(taskId => {
      const observation = state.liveTaskObservations[taskId] ?? state.taskObservations[taskId];
      if (observation == null) return null;
      return {
        taskId: observation.taskId,
        subagentName: observation.subagentName,
        description: observation.description,
        status: getTaskStatus(observation),
        toolCalls: countTaskToolCalls(observation.trace),
        bytesReceived: countTaskBytes(observation),
      } satisfies TaskDashboardItem;
    })
    .filter((item): item is TaskDashboardItem => item != null);
}

export function parseTaskObservationsFromToolOutput(content: string): TaskObservation[] {
  const wrappedMatches = [
    ...content.matchAll(/<task_observation>\n?([\s\S]*?)\n?<\/task_observation>/gm),
  ];
  if (wrappedMatches.length > 0) {
    return wrappedMatches
      .map(match => parseTaskObservationBlock(match[1] ?? ""))
      .filter((value): value is TaskObservation => value != null);
  }

  const single = parseTaskObservationBlock(content);
  return single ? [single] : [];
}

export function parseTaskObservationFromToolOutput(content: string): TaskObservation | null {
  return parseTaskObservationsFromToolOutput(content)[0] ?? null;
}

export function useModel() {
  const { modelOverride, agents, activeAgentName } = useAppStore(
    useShallow(state => ({
      modelOverride: state.modelOverride,
      agents: state.agents,
      activeAgentName: state.activeAgentName,
    })),
  );
  const config = useConfig();

  return getModelFromConfig(
    config,
    resolveAgentModelOverride(resolveActiveAgent(agents, activeAgentName), modelOverride),
  );
}

export function useActiveAgent() {
  const { agents, activeAgentName } = useAppStore(
    useShallow(state => ({
      agents: state.agents,
      activeAgentName: state.activeAgentName,
    })),
  );
  return resolveActiveAgent(agents, activeAgentName);
}

export function useAgentFocus() {
  const {
    focus,
    taskObservations,
    liveTaskObservations,
    taskObservationOrder,
    liveTaskObservationOrder,
  } = useAppStore(
    useShallow(state => ({
      focus: state.focus,
      taskObservations: state.taskObservations,
      liveTaskObservations: state.liveTaskObservations,
      taskObservationOrder: state.taskObservationOrder,
      liveTaskObservationOrder: state.liveTaskObservationOrder,
    })),
  );
  const focusedTask =
    focus.type === "task"
      ? (liveTaskObservations[focus.taskId] ?? taskObservations[focus.taskId] ?? null)
      : null;
  const order = activeTaskOrder({ liveTaskObservationOrder, taskObservationOrder });
  const taskCount = order.length;
  const focusIndex = focus.type === "task" ? order.indexOf(focus.taskId) : -1;
  const hasLiveTasks = liveTaskObservationOrder.length > 0;
  return { focus, focusedTask, taskCount, focusIndex, hasLiveTasks };
}

export function useTaskDashboard() {
  const { taskObservations, taskObservationOrder, liveTaskObservations, liveTaskObservationOrder } =
    useAppStore(
      useShallow(state => ({
        taskObservations: state.taskObservations,
        taskObservationOrder: state.taskObservationOrder,
        liveTaskObservations: state.liveTaskObservations,
        liveTaskObservationOrder: state.liveTaskObservationOrder,
      })),
    );

  const items = taskDashboardFromState({
    taskObservations,
    taskObservationOrder,
    liveTaskObservations,
    liveTaskObservationOrder,
  });
  const workingCount = items.filter(item => item.status === "working").length;
  const failedCount = items.filter(item => item.status === "failed").length;
  const completedCount = items.length - workingCount - failedCount;
  const totalToolCalls = items.reduce((sum, item) => sum + item.toolCalls, 0);
  const bytesReceived = items.reduce((sum, item) => sum + item.bytesReceived, 0);
  return { items, workingCount, failedCount, completedCount, totalToolCalls, bytesReceived };
}

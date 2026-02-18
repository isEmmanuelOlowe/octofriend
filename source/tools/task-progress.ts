export type LiveTaskObservation = {
  taskId: string;
  subagentName: string;
  description: string;
  trace: string;
  result: string;
};

export type LiveTaskRunSnapshot = {
  order: string[];
  observations: Record<string, LiveTaskObservation>;
  updatedAt: number;
};

type LiveTaskRunState = {
  order: string[];
  observations: Record<string, LiveTaskObservation>;
  updatedAt: number;
};

const runs = new Map<string, LiveTaskRunState>();
const MAX_TRACE_CHARS = 32000;
const MAX_RESULT_CHARS = 8000;

function clampTail(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return `... (truncated)\n${input.slice(input.length - maxChars)}`;
}

export function makeLiveTaskID(toolCallId: string, index: number): string {
  return `task_${toolCallId}_${index}`;
}

function now() {
  return Date.now();
}

function ensureRun(toolCallId: string): LiveTaskRunState {
  const existing = runs.get(toolCallId);
  if (existing) return existing;
  const created: LiveTaskRunState = {
    order: [],
    observations: {},
    updatedAt: now(),
  };
  runs.set(toolCallId, created);
  return created;
}

export function startLiveTaskRun(
  toolCallId: string,
  tasks: Array<{
    taskId: string;
    subagentName: string;
    description: string;
    prompt?: string;
  }>,
) {
  const state = ensureRun(toolCallId);
  state.order = tasks.map(task => task.taskId);
  state.observations = Object.fromEntries(
    tasks.map(task => [
      task.taskId,
      {
        taskId: task.taskId,
        subagentName: task.subagentName,
        description: task.description,
        trace: `status: running\nsubagent: @${task.subagentName}\n\nprompt:\n${(task.prompt ?? "").slice(0, 600)}`,
        result: "Subagent is running. Waiting for first tool outputs...",
      } satisfies LiveTaskObservation,
    ]),
  );
  state.updatedAt = now();
}

function touch(state: LiveTaskRunState) {
  state.updatedAt = now();
}

export function appendLiveTaskTrace(toolCallId: string, taskId: string, line: string) {
  const state = ensureRun(toolCallId);
  const observation = state.observations[taskId];
  if (!observation) return;
  const next = observation.trace.trim().length ? `${observation.trace}\n\n${line}` : line;
  observation.trace = clampTail(next, MAX_TRACE_CHARS);
  touch(state);
}

export function setLiveTaskResult(toolCallId: string, taskId: string, result: string) {
  const state = ensureRun(toolCallId);
  const observation = state.observations[taskId];
  if (!observation) return;
  observation.result = clampTail(result, MAX_RESULT_CHARS);
  touch(state);
}

export function markLiveTaskFailed(toolCallId: string, taskId: string, message: string) {
  appendLiveTaskTrace(toolCallId, taskId, `[task-error]\n${message}`);
  setLiveTaskResult(toolCallId, taskId, `Subagent task failed: ${message}`);
}

export function getLiveTaskRun(toolCallId: string): LiveTaskRunSnapshot | null {
  const state = runs.get(toolCallId);
  if (!state) return null;
  return {
    order: state.order,
    observations: state.observations,
    updatedAt: state.updatedAt,
  };
}

export function clearLiveTaskRun(toolCallId: string) {
  runs.delete(toolCallId);
}

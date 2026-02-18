import { describe, it, expect } from "vitest";
import {
  parseTaskObservationFromToolOutput,
  parseTaskObservationsFromToolOutput,
  taskDashboardFromState,
  useAppStore,
} from "./state.ts";

describe("state task observation parsing", () => {
  it("parses structured task output", () => {
    const parsed = parseTaskObservationFromToolOutput(
      `task_id: task_123\ntask_subagent: explore\ntask_description: scan repo\n\n<task_trace>\nassistant: planning\ntool-request: list\ntool-output: 20 lines\n</task_trace>\n\n<task_result>\nFound key files\n</task_result>`,
    );

    expect(parsed).not.toBeNull();
    expect(parsed!.taskId).toBe("task_123");
    expect(parsed!.subagentName).toBe("explore");
    expect(parsed!.description).toBe("scan repo");
    expect(parsed!.trace).toContain("tool-request: list");
    expect(parsed!.result).toBe("Found key files");
  });

  it("returns null for unstructured task output", () => {
    expect(parseTaskObservationFromToolOutput("plain text")).toBeNull();
  });

  it("parses task with empty trace and result", () => {
    const parsed = parseTaskObservationFromToolOutput(
      `task_id: task_empty\ntask_subagent: explore\ntask_description: scan repo\n\n<task_trace>\n\n</task_trace>\n\n<task_result>\n\n</task_result>`,
    );

    expect(parsed).not.toBeNull();
    expect(parsed!.taskId).toBe("task_empty");
    expect(parsed!.subagentName).toBe("explore");
    expect(parsed!.description).toBe("scan repo");
    expect(parsed!.trace).toBe("");
    expect(parsed!.result).toBe("");
  });

  it("parses task with missing trace and result tags (defaults to empty)", () => {
    const parsed = parseTaskObservationFromToolOutput(
      `task_id: task_no_tags\ntask_subagent: general\ntask_description: simple task`,
    );

    expect(parsed).not.toBeNull();
    expect(parsed!.taskId).toBe("task_no_tags");
    expect(parsed!.subagentName).toBe("general");
    expect(parsed!.description).toBe("simple task");
    expect(parsed!.trace).toBe("");
    expect(parsed!.result).toBe("");
  });

  it("parses multiple wrapped task observations", () => {
    const parsed = parseTaskObservationsFromToolOutput(`task_parallel_count: 2

<task_observation>
task_id: task_a
task_subagent: explore
task_description: scan a

<task_trace>
assistant: one
</task_trace>

<task_result>
done a
</task_result>
</task_observation>

<task_observation>
task_id: task_b
task_subagent: general
task_description: scan b

<task_trace>
assistant: two
</task_trace>

<task_result>
done b
</task_result>
</task_observation>`);

    expect(parsed).toHaveLength(2);
    expect(parsed[0].taskId).toBe("task_a");
    expect(parsed[1].taskId).toBe("task_b");
  });

  it("navigates trace focus across tasks and main view", () => {
    useAppStore.setState({
      taskObservationOrder: ["task_1", "task_2"],
      focus: { type: "main" },
    });

    useAppStore.getState().focusNextTask();
    expect(useAppStore.getState().focus).toEqual({ type: "task", taskId: "task_1" });

    useAppStore.getState().focusNextTask();
    expect(useAppStore.getState().focus).toEqual({ type: "task", taskId: "task_2" });

    useAppStore.getState().focusNextTask();
    expect(useAppStore.getState().focus).toEqual({ type: "main" });

    useAppStore.getState().focusPrevTask();
    expect(useAppStore.getState().focus).toEqual({ type: "task", taskId: "task_2" });
  });

  it("prefers live task order when navigating focus", () => {
    useAppStore.setState({
      taskObservationOrder: ["task_final_1", "task_final_2"],
      liveTaskObservationOrder: ["task_live_1", "task_live_2"],
      focus: { type: "main" },
    });

    useAppStore.getState().focusNextTask();
    expect(useAppStore.getState().focus).toEqual({ type: "task", taskId: "task_live_1" });
  });

  it("builds dashboard items with tool call counts and status", () => {
    const items = taskDashboardFromState({
      taskObservationOrder: ["task_done", "task_fail"],
      taskObservations: {
        task_done: {
          taskId: "task_done",
          subagentName: "explore",
          description: "scan modules",
          trace: [
            "[assistant]",
            "[tool-request] list",
            "[tool-output] 12 lines",
            "[tool-request] read",
          ].join("\n"),
          result: "Done",
        },
        task_fail: {
          taskId: "task_fail",
          subagentName: "general",
          description: "summarize failures",
          trace: "[task-error]\nTool timeout",
          result: "Subagent task failed: Tool timeout",
        },
      },
      liveTaskObservationOrder: [],
      liveTaskObservations: {},
    });

    expect(items).toEqual([
      {
        taskId: "task_done",
        subagentName: "explore",
        description: "scan modules",
        status: "completed",
        toolCalls: 2,
        bytesReceived: expect.any(Number),
      },
      {
        taskId: "task_fail",
        subagentName: "general",
        description: "summarize failures",
        status: "failed",
        toolCalls: 0,
        bytesReceived: expect.any(Number),
      },
    ]);
  });

  it("uses live observations for dashboard when tasks are still running", () => {
    const items = taskDashboardFromState({
      taskObservationOrder: ["task_done"],
      taskObservations: {
        task_done: {
          taskId: "task_done",
          subagentName: "explore",
          description: "scan modules",
          trace: "[tool-request] list",
          result: "Done",
        },
      },
      liveTaskObservationOrder: ["task_live"],
      liveTaskObservations: {
        task_live: {
          taskId: "task_live",
          subagentName: "explore",
          description: "scan codepaths",
          trace: "status: running\nsubagent: @explore",
          result: "Subagent is running. Waiting for first tool outputs...",
        },
      },
    });

    expect(items).toEqual([
      {
        taskId: "task_live",
        subagentName: "explore",
        description: "scan codepaths",
        status: "working",
        toolCalls: 0,
        bytesReceived: expect.any(Number),
      },
    ]);
  });
});

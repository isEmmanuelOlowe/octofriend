import { describe, expect, it, beforeEach } from "vitest";
import {
  appendLiveTaskTrace,
  clearLiveTaskRun,
  getLiveTaskRun,
  setLiveTaskResult,
  startLiveTaskRun,
  markLiveTaskFailed,
  makeLiveTaskID,
} from "./task-progress.ts";

describe("task-progress", () => {
  beforeEach(() => {
    // Clear any existing runs before each test
    const snapshot = getLiveTaskRun("test-run");
    if (snapshot) {
      clearLiveTaskRun("test-run");
    }
  });

  it("caps live task trace and result sizes", () => {
    const runId = "run_cap_test";
    const taskId = "task_cap_test";
    startLiveTaskRun(runId, [
      {
        taskId,
        subagentName: "explore",
        description: "cap check",
        prompt: "start",
      },
    ]);

    const hugeLine = "x".repeat(5000);
    for (let i = 0; i < 20; i++) {
      appendLiveTaskTrace(runId, taskId, hugeLine);
    }
    setLiveTaskResult(runId, taskId, "y".repeat(20000));

    const snapshot = getLiveTaskRun(runId);
    expect(snapshot).not.toBeNull();
    const trace = snapshot!.observations[taskId].trace;
    const result = snapshot!.observations[taskId].result;
    expect(trace.length).toBeLessThanOrEqual(32000 + 32);
    expect(result.length).toBeLessThanOrEqual(8000 + 32);

    clearLiveTaskRun(runId);
    expect(getLiveTaskRun(runId)).toBeNull();
  });

  describe("markLiveTaskFailed", () => {
    it("appends [task-error] to trace with error message", () => {
      const runId = "run_fail_test";
      const taskId = "task_fail_test";
      const errorMessage = "Connection timeout";

      startLiveTaskRun(runId, [
        {
          taskId,
          subagentName: "worker",
          description: "test task",
          prompt: "do work",
        },
      ]);

      markLiveTaskFailed(runId, taskId, errorMessage);

      const snapshot = getLiveTaskRun(runId);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.observations[taskId].trace).toContain("[task-error]");
      expect(snapshot!.observations[taskId].trace).toContain(errorMessage);

      clearLiveTaskRun(runId);
    });

    it("sets result with Subagent task failed: prefix", () => {
      const runId = "run_fail_prefix_test";
      const taskId = "task_fail_prefix_test";
      const errorMessage = "Network error";

      startLiveTaskRun(runId, [
        {
          taskId,
          subagentName: "worker",
          description: "test task",
          prompt: "do work",
        },
      ]);

      markLiveTaskFailed(runId, taskId, errorMessage);

      const snapshot = getLiveTaskRun(runId);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.observations[taskId].result).toBe(`Subagent task failed: ${errorMessage}`);

      clearLiveTaskRun(runId);
    });

    it("caps result size when error message is very long", () => {
      const runId = "run_fail_long_test";
      const taskId = "task_fail_long_test";
      const longErrorMessage = "e".repeat(20000);

      startLiveTaskRun(runId, [
        {
          taskId,
          subagentName: "worker",
          description: "test task",
          prompt: "do work",
        },
      ]);

      markLiveTaskFailed(runId, taskId, longErrorMessage);

      const snapshot = getLiveTaskRun(runId);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.observations[taskId].result.length).toBeLessThanOrEqual(8000 + 32);
      expect(snapshot!.observations[taskId].result).toContain("... (truncated)");

      clearLiveTaskRun(runId);
    });
  });

  describe("startLiveTaskRun", () => {
    it("creates new run with tasks in order", () => {
      const runId = "run_order_test";
      const tasks = [
        { taskId: "task_1", subagentName: "worker1", description: "first" },
        { taskId: "task_2", subagentName: "worker2", description: "second" },
        { taskId: "task_3", subagentName: "worker3", description: "third" },
      ];

      startLiveTaskRun(runId, tasks);

      const snapshot = getLiveTaskRun(runId);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.order).toEqual(["task_1", "task_2", "task_3"]);
      expect(Object.keys(snapshot!.observations)).toHaveLength(3);

      clearLiveTaskRun(runId);
    });

    it("resets cleanly when called twice for same run", () => {
      const runId = "run_reset_test";
      const taskId1 = "task_reset_1";
      const taskId2 = "task_reset_2";

      // First call
      startLiveTaskRun(runId, [
        {
          taskId: taskId1,
          subagentName: "oldWorker",
          description: "old task",
          prompt: "old prompt",
        },
      ]);

      // Add some trace
      appendLiveTaskTrace(runId, taskId1, "old trace");
      setLiveTaskResult(runId, taskId1, "old result");

      // Second call - should reset the run
      startLiveTaskRun(runId, [
        {
          taskId: taskId2,
          subagentName: "newWorker",
          description: "new task",
          prompt: "new prompt",
        },
      ]);

      const snapshot = getLiveTaskRun(runId);
      expect(snapshot).not.toBeNull();
      // Should only have the new task
      expect(snapshot!.order).toEqual([taskId2]);
      expect(Object.keys(snapshot!.observations)).toEqual([taskId2]);
      // New task should have initial trace, not old trace
      expect(snapshot!.observations[taskId2].trace).toContain("newWorker");
      expect(snapshot!.observations[taskId2].trace).toContain("new prompt");
      expect(snapshot!.observations[taskId2].result).toContain("running");

      clearLiveTaskRun(runId);
    });

    it("initializes observations with correct structure", () => {
      const runId = "run_init_test";
      const taskId = "task_init_test";
      const subagentName = "testAgent";
      const description = "test description";
      const prompt = "test prompt";

      startLiveTaskRun(runId, [
        {
          taskId,
          subagentName,
          description,
          prompt,
        },
      ]);

      const snapshot = getLiveTaskRun(runId);
      expect(snapshot).not.toBeNull();
      const observation = snapshot!.observations[taskId];
      expect(observation.taskId).toBe(taskId);
      expect(observation.subagentName).toBe(subagentName);
      expect(observation.description).toBe(description);
      expect(observation.trace).toContain("status: running");
      expect(observation.trace).toContain(subagentName);
      expect(observation.trace).toContain(prompt);
      expect(observation.result).toContain("Subagent is running");

      clearLiveTaskRun(runId);
    });

    it("truncates prompt in initial trace", () => {
      const runId = "run_truncate_test";
      const taskId = "task_truncate_test";
      const longPrompt = "x".repeat(1000);

      startLiveTaskRun(runId, [
        {
          taskId,
          subagentName: "worker",
          description: "test",
          prompt: longPrompt,
        },
      ]);

      const snapshot = getLiveTaskRun(runId);
      expect(snapshot).not.toBeNull();
      // Prompt should be truncated to 600 chars
      expect(snapshot!.observations[taskId].trace.length).toBeLessThan(700);

      clearLiveTaskRun(runId);
    });

    it("updates timestamp on run creation", () => {
      const runId = "run_time_test";
      const beforeTime = Date.now();

      startLiveTaskRun(runId, [
        {
          taskId: "task_time",
          subagentName: "worker",
          description: "test",
        },
      ]);

      const afterTime = Date.now();
      const snapshot = getLiveTaskRun(runId);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.updatedAt).toBeGreaterThanOrEqual(beforeTime);
      expect(snapshot!.updatedAt).toBeLessThanOrEqual(afterTime);

      clearLiveTaskRun(runId);
    });
  });

  describe("makeLiveTaskID", () => {
    it("generates unique task IDs from toolCallId and index", () => {
      const toolCallId = "live-run-123";
      const taskId0 = makeLiveTaskID(toolCallId, 0);
      const taskId1 = makeLiveTaskID(toolCallId, 1);
      const taskId2 = makeLiveTaskID(toolCallId, 2);

      expect(taskId0).toBe("task_live-run-123_0");
      expect(taskId1).toBe("task_live-run-123_1");
      expect(taskId2).toBe("task_live-run-123_2");
      expect(taskId0).not.toBe(taskId1);
      expect(taskId1).not.toBe(taskId2);
    });

    it("generates different IDs for different toolCallIds", () => {
      const taskIdA = makeLiveTaskID("run-A", 0);
      const taskIdB = makeLiveTaskID("run-B", 0);

      expect(taskIdA).not.toBe(taskIdB);
      expect(taskIdA).toContain("run-A");
      expect(taskIdB).toContain("run-B");
    });
  });

  describe("appendLiveTaskTrace", () => {
    it("appends lines to existing trace with separator", () => {
      const runId = "run_append_test";
      const taskId = "task_append_test";

      startLiveTaskRun(runId, [
        {
          taskId,
          subagentName: "worker",
          description: "test",
          prompt: "start",
        },
      ]);

      appendLiveTaskTrace(runId, taskId, "[user]\nHello");
      appendLiveTaskTrace(runId, taskId, "[assistant]\nHi there");

      const snapshot = getLiveTaskRun(runId);
      expect(snapshot).not.toBeNull();
      const trace = snapshot!.observations[taskId].trace;
      expect(trace).toContain("[user]");
      expect(trace).toContain("[assistant]");
      // Should have separator between entries
      expect(trace).toContain("\n\n");

      clearLiveTaskRun(runId);
    });

    it("handles first trace entry correctly when starting from empty", () => {
      const runId = "run_first_trace_test";
      const taskId = "task_first_trace_test";

      // Ensure run is created first with ensureRun pattern
      // (this mimics how appendLiveTaskTrace creates a run if it doesn't exist)
      const { clearLiveTaskRun: _, ...progress } = require("./task-progress.ts");

      // When a run doesn't exist and we append, the observation won't be there
      // because appendLiveTaskTrace only works on existing observations
      // So test that the behavior is graceful
      appendLiveTaskTrace("nonexistent-run", "unknown-task", "trace");
      expect(getLiveTaskRun("nonexistent-run")).not.toBeNull();
      // But unknown task won't have an observation added
      expect(getLiveTaskRun("nonexistent-run")!.observations["unknown-task"]).toBeUndefined();
      clearLiveTaskRun("nonexistent-run");

      // Now test with proper setup - the initial trace from startLiveTaskRun
      // contains the prompt, so appending creates separator
      startLiveTaskRun(runId, [
        {
          taskId,
          subagentName: "worker",
          description: "test",
          prompt: "start",
        },
      ]);

      // The initial trace contains status/prompt
      const beforeAppend = getLiveTaskRun(runId)!.observations[taskId].trace;
      expect(beforeAppend).toContain("status: running");

      // Appending adds with separator
      appendLiveTaskTrace(runId, taskId, "[assistant]\nResponse");

      const snapshot = getLiveTaskRun(runId);
      expect(snapshot).not.toBeNull();
      const trace = snapshot!.observations[taskId].trace;
      // Should contain both initial content and appended content
      expect(trace).toContain("status: running");
      expect(trace).toContain("[assistant]");
      expect(trace).toContain("Response");

      clearLiveTaskRun(runId);
    });

    it("updates timestamp when appending trace", async () => {
      const runId = "run_time_update_test";
      const taskId = "task_time_update_test";

      startLiveTaskRun(runId, [
        {
          taskId,
          subagentName: "worker",
          description: "test",
          prompt: "start",
        },
      ]);

      const beforeUpdate = Date.now();
      await new Promise(resolve => setTimeout(resolve, 10));

      appendLiveTaskTrace(runId, taskId, "new line");

      const snapshot = getLiveTaskRun(runId);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.updatedAt).toBeGreaterThanOrEqual(beforeUpdate);

      clearLiveTaskRun(runId);
    });

    it("silently ignores trace for unknown task", () => {
      const runId = "run_unknown_task_test";
      const taskId = "known_task";

      startLiveTaskRun(runId, [
        {
          taskId,
          subagentName: "worker",
          description: "test",
          prompt: "start",
        },
      ]);

      // Should not throw
      appendLiveTaskTrace(runId, "unknown_task", "some trace");

      const snapshot = getLiveTaskRun(runId);
      expect(snapshot).not.toBeNull();
      // Known task should be unchanged
      expect(snapshot!.observations[taskId].trace).toContain("status: running");

      clearLiveTaskRun(runId);
    });

    it("creates new run if appending to non-existent run", () => {
      const runId = "run_create_on_append";
      const taskId = "task_create_on_append";

      // Start a run first so the observation exists
      startLiveTaskRun(runId, [
        {
          taskId,
          subagentName: "worker",
          description: "test",
          prompt: "start",
        },
      ]);

      // Clear to simulate non-existent
      clearLiveTaskRun(runId);
      expect(getLiveTaskRun(runId)).toBeNull();

      // Appending will create a new run via ensureRun
      // but the observation won't exist for unknown tasks
      // So we need to test that ensureRun is called (run is created)
      // but unknown task observations are silently handled

      // First let's verify the run gets recreated
      // Note: ensureRun in appendLiveTaskTrace creates a new run but doesn't add observations
      // since it can't know what tasks should be there. This is correct behavior.
      appendLiveTaskTrace(runId, taskId, "trace line");

      // Run should be created but empty (no observations for unknown tasks)
      const snapshot = getLiveTaskRun(runId);
      expect(snapshot).not.toBeNull();
      // No observations for unknown task since we didn't startLiveTaskRun
      expect(snapshot!.observations[taskId]).toBeUndefined();
      expect(Object.keys(snapshot!.observations)).toHaveLength(0);

      clearLiveTaskRun(runId);
    });
  });

  describe("setLiveTaskResult", () => {
    it("sets result for a task", () => {
      const runId = "run_result_test";
      const taskId = "task_result_test";
      const resultText = "Task completed successfully";

      startLiveTaskRun(runId, [
        {
          taskId,
          subagentName: "worker",
          description: "test",
          prompt: "start",
        },
      ]);

      setLiveTaskResult(runId, taskId, resultText);

      const snapshot = getLiveTaskRun(runId);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.observations[taskId].result).toBe(resultText);

      clearLiveTaskRun(runId);
    });

    it("silently ignores result for unknown task", () => {
      const runId = "run_result_unknown_test";
      const taskId = "known_task";

      startLiveTaskRun(runId, [
        {
          taskId,
          subagentName: "worker",
          description: "test",
          prompt: "start",
        },
      ]);

      // Should not throw
      setLiveTaskResult(runId, "unknown_task", "some result");

      const snapshot = getLiveTaskRun(runId);
      expect(snapshot).not.toBeNull();
      // Known task should still have initial result
      expect(snapshot!.observations[taskId].result).toContain("running");

      clearLiveTaskRun(runId);
    });

    it("updates timestamp when setting result", async () => {
      const runId = "run_result_time_test";
      const taskId = "task_result_time_test";

      startLiveTaskRun(runId, [
        {
          taskId,
          subagentName: "worker",
          description: "test",
          prompt: "start",
        },
      ]);

      const beforeUpdate = Date.now();
      await new Promise(resolve => setTimeout(resolve, 10));

      setLiveTaskResult(runId, taskId, "result");

      const snapshot = getLiveTaskRun(runId);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.updatedAt).toBeGreaterThanOrEqual(beforeUpdate);

      clearLiveTaskRun(runId);
    });
  });

  describe("clearLiveTaskRun", () => {
    it("removes run from map", () => {
      const runId = "run_clear_test";
      const taskId = "task_clear_test";

      startLiveTaskRun(runId, [
        {
          taskId,
          subagentName: "worker",
          description: "test",
          prompt: "start",
        },
      ]);

      expect(getLiveTaskRun(runId)).not.toBeNull();

      clearLiveTaskRun(runId);

      expect(getLiveTaskRun(runId)).toBeNull();
    });

    it("does not throw for non-existent run", () => {
      // Should not throw
      clearLiveTaskRun("non_existent_run");
    });
  });

  describe("getLiveTaskRun", () => {
    it("returns null for non-existent run", () => {
      const snapshot = getLiveTaskRun("run_does_not_exist");
      expect(snapshot).toBeNull();
    });

    it("returns snapshot with correct structure", () => {
      const runId = "run_snapshot_test";
      const taskId = "task_snapshot_test";

      startLiveTaskRun(runId, [
        {
          taskId,
          subagentName: "worker",
          description: "test description",
          prompt: "test prompt",
        },
      ]);

      const snapshot = getLiveTaskRun(runId);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.order).toBeInstanceOf(Array);
      expect(snapshot!.observations).toBeInstanceOf(Object);
      expect(snapshot!.updatedAt).toBeTypeOf("number");

      const observation = snapshot!.observations[taskId];
      expect(observation).toMatchObject({
        taskId,
        subagentName: "worker",
        description: "test description",
        trace: expect.stringContaining("status: running"),
        result: expect.any(String),
      });

      clearLiveTaskRun(runId);
    });
  });
});

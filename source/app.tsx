import React, {
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
  createContext,
  useContext,
} from "react";
import { Text, Box, Static, measureElement, DOMElement, useInput, useApp, useStdin } from "ink";
import clipboardy from "clipboardy";
import { InputWithHistory } from "./components/input-with-history.tsx";
import { t } from "structural";
import {
  Config,
  Metadata,
  ConfigContext,
  ConfigPathContext,
  SetConfigContext,
  useConfig,
} from "./config.ts";
import { HistoryItem, ToolCallItem } from "./history.ts";
import Loading from "./components/loading.tsx";
import { Header } from "./header.tsx";
import { UnchainedContext, useColor, useUnchained } from "./theme.ts";
import { DiffRenderer } from "./components/diff-renderer.tsx";
import { FileRenderer } from "./components/file-renderer.tsx";
import shell from "./tools/tool-defs/bash.ts";
import read from "./tools/tool-defs/read.ts";
import list from "./tools/tool-defs/list.ts";
import edit from "./tools/tool-defs/edit.ts";
import append from "./tools/tool-defs/append.ts";
import prepend from "./tools/tool-defs/prepend.ts";
import rewrite from "./tools/tool-defs/rewrite.ts";
import createTool from "./tools/tool-defs/create.ts";
import mcp from "./tools/tool-defs/mcp.ts";
import fetchTool from "./tools/tool-defs/fetch.ts";
import skill from "./tools/tool-defs/skill.ts";
import webSearch from "./tools/tool-defs/web-search.ts";
import task from "./tools/tool-defs/task.ts";
import { ALWAYS_REQUEST_PERMISSION_TOOLS, SKIP_CONFIRMATION_TOOLS } from "./tools/index.ts";
import { ArgumentsSchema as EditArgumentSchema } from "./tools/tool-defs/edit.ts";
import { ToolSchemaFrom } from "./tools/common.ts";
import { useShallow } from "zustand/react/shallow";
import { KbShortcutPanel } from "./components/kb-select/kb-shortcut-panel.tsx";
import { Item, ShortcutArray } from "./components/kb-select/kb-shortcut-select.tsx";
import {
  useAppStore,
  RunArgs,
  useModel,
  InflightResponseType,
  useActiveAgent,
  useAgentFocus,
  useTaskDashboard,
} from "./state.ts";
import { Octo } from "./components/octo.tsx";
import { Menu } from "./menu.tsx";
import SelectInput from "./components/ink/select-input.tsx";
import { IndicatorComponent } from "./components/select.tsx";
import { displayLog } from "./logger.ts";
import { CenteredBox } from "./components/centered-box.tsx";
import { Transport } from "./transports/transport-common.ts";
import { LocalTransport } from "./transports/local.ts";
import { markUpdatesSeen } from "./update-notifs/update-notifs.ts";
import {
  useCtrlC,
  ExitOnDoubleCtrlC,
  useCtrlCPressed,
} from "./components/exit-on-double-ctrl-c.tsx";
import { InputHistory } from "./input-history/index.ts";
import { Markdown } from "./markdown/index.tsx";
import { countLines } from "./str.ts";
import { VimModeIndicator } from "./components/vim-mode.tsx";
import { ScrollView, IsScrollableContext } from "./components/scroll-view.tsx";
import { TerminalSizeTracker, useTerminalSize } from "./components/terminal-size.tsx";
import { ToolCallRequest } from "./ir/llm-ir.ts";
import { useShiftTab } from "./hooks/use-shift-tab.tsx";
import { useTab } from "./hooks/use-tab.tsx";
import { readFileSync } from "fs";
import { CwdContext, useCwd } from "./hooks/use-cwd.tsx";
import {
  resolveRawSubagentNavSequence,
  resolveSubagentNavShortcut,
} from "./subagent-nav-shortcuts.ts";

type Props = {
  config: Config;
  configPath: string;
  cwd: string;
  metadata: Metadata;
  updates: string | null;
  unchained: boolean;
  transport: Transport;
  inputHistory: InputHistory;
  bootSkills: string[];
  bootAgents: string[];
};

type StaticItem =
  | {
      type: "header";
    }
  | {
      type: "version";
      metadata: Metadata;
      config: Config;
    }
  | {
      type: "updates";
      updates: string;
    }
  | {
      type: "slogan";
    }
  | {
      type: "history-item";
      item: HistoryItem;
    }
  | {
      type: "boot-notification";
      content: string;
    };

function toStaticItems(messages: HistoryItem[]): Array<StaticItem> {
  return messages.map(message => ({
    type: "history-item",
    item: message,
  }));
}

const TransportContext = createContext<Transport>(new LocalTransport());

const UNCHAINED_NOTIF = "Octo runs edits and shell commands automatically";
const CHAINED_NOTIF = "Octo asks permission before running edits or shell commands";
export default function App({
  config,
  configPath,
  cwd,
  metadata,
  unchained,
  transport,
  updates,
  inputHistory,
  bootSkills,
  bootAgents,
}: Props) {
  const [currConfig, setCurrConfig] = useState(config);
  const [isUnchained, setIsUnchained] = useState(unchained);
  const [tempNotification, setTempNotification] = useState<string | null>(
    isUnchained ? UNCHAINED_NOTIF : CHAINED_NOTIF,
  );
  const { history, setVimMode, clearNonce, cycleAgent } = useAppStore(
    useShallow(state => ({
      history: state.history,
      setVimMode: state.setVimMode,
      clearNonce: state.clearNonce,
      cycleAgent: state.cycleAgent,
    })),
  );
  const { focus, focusedTask, hasLiveTasks } = useAgentFocus();
  const showFocusedLiveTask = hasLiveTasks && focus.type === "task" && focusedTask != null;

  useEffect(() => {
    if (updates != null) markUpdatesSeen();
    if (currConfig.vimEmulation?.enabled) setVimMode("INSERT");
  }, []);

  const skillNotifs: string[] = [];
  if (bootSkills.length > 0) {
    skillNotifs.push(" ");
    skillNotifs.push("Configured skills:");
    skillNotifs.push(...bootSkills.map(s => `- ${s}`));
  }
  if (bootAgents.length > 0) {
    skillNotifs.push(" ");
    skillNotifs.push("Configured agents:");
    skillNotifs.push(...bootAgents.map(a => `- ${a}`));
  }
  useShiftTab(() => {
    setIsUnchained(prev => {
      const unchained = !prev;
      if (unchained) {
        setTempNotification(UNCHAINED_NOTIF);
      } else {
        setTempNotification(CHAINED_NOTIF);
      }
      return unchained;
    });
  });
  useTab(() => {
    cycleAgent();
  });

  const staticItems: StaticItem[] = useMemo(() => {
    return [
      { type: "header" },
      { type: "version", metadata, config: currConfig },
      ...skillNotifs.map(s => ({ type: "boot-notification" as const, content: s })),
      ...(updates ? [{ type: "updates" as const, updates }] : []),
      { type: "slogan" },
      ...toStaticItems(history),
    ];
  }, [history]);

  return (
    <SetConfigContext.Provider value={setCurrConfig}>
      <ConfigPathContext.Provider value={configPath}>
        <ConfigContext.Provider value={currConfig}>
          <UnchainedContext.Provider value={isUnchained}>
            <TransportContext.Provider value={transport}>
              <CwdContext.Provider value={cwd}>
                <ExitOnDoubleCtrlC>
                  <TerminalSizeTracker>
                    <Box flexDirection="column" width="100%">
                      <Static items={staticItems} key={clearNonce}>
                        {(item, index) => (
                          <StaticItemRenderer item={item} key={`static-${index}`} />
                        )}
                      </Static>
                      {showFocusedLiveTask ? (
                        <FocusedTaskPanel />
                      ) : (
                        <>
                          <InflightResponsePanel />
                          {hasLiveTasks && focus.type === "main" && <MainTaskDashboard />}
                        </>
                      )}
                      <BottomBar
                        inputHistory={inputHistory}
                        metadata={metadata}
                        tempNotification={tempNotification}
                      />
                    </Box>
                  </TerminalSizeTracker>
                </ExitOnDoubleCtrlC>
              </CwdContext.Provider>
            </TransportContext.Provider>
          </UnchainedContext.Provider>
        </ConfigContext.Provider>
      </ConfigPathContext.Provider>
    </SetConfigContext.Provider>
  );
}

function BottomBar({
  inputHistory,
  metadata,
  tempNotification,
}: {
  inputHistory: InputHistory;
  metadata: Metadata;
  tempNotification: string | null;
}) {
  const TEMP_NOTIFICATION_DURATION = 5000;

  const [versionCheck, setVersionCheck] = useState("Checking for updates...");
  const [displayedTempNotification, setDisplayedTempNotification] =
    useState<React.ReactNode | null>(null);
  const themeColor = useColor();
  const ctrlCPressed = useCtrlCPressed();
  const { modeData } = useAppStore(
    useShallow(state => ({
      modeData: state.modeData,
    })),
  );
  const activeAgent = useActiveAgent();
  const { focus, focusedTask, taskCount, focusIndex, hasLiveTasks } = useAgentFocus();

  useEffect(() => {
    getLatestVersion().then(latestVersion => {
      if (latestVersion && metadata.version < latestVersion) {
        setVersionCheck(
          "New version released! Run `npm install -g --omit=dev octofriend` to update.",
        );
        return;
      }
      setVersionCheck("Octo is up-to-date.");
      setTimeout(() => {
        setVersionCheck("");
      }, 5000);
    });
  }, [metadata]);

  useEffect(() => {
    if (tempNotification) {
      setDisplayedTempNotification(tempNotification);
      const timer = setTimeout(() => {
        setDisplayedTempNotification(null);
      }, TEMP_NOTIFICATION_DURATION);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [tempNotification]);

  if (modeData.mode === "menu") return <Menu />;

  const unchained = useUnchained();

  return (
    <Box flexDirection="column" width="100%" flexShrink={0}>
      <BottomBarContent inputHistory={inputHistory} />
      <Box width="100%" justifyContent="space-between" height={1} flexShrink={0}>
        <Box height={1}>
          <Text color={themeColor}>{ctrlCPressed && "Press Ctrl+C again to exit."}</Text>
          {!ctrlCPressed && (
            <Text color={"gray"}>
              Agent: <Text>{activeAgent.name}</Text> <Text dimColor>(Tab to switch)</Text>
              <Text> | </Text>
              {hasLiveTasks && taskCount > 0 && focus.type === "task" && focusedTask ? (
                <>
                  View: <Text>@{focusedTask.subagentName}</Text>{" "}
                  <Text dimColor>
                    ({focusIndex + 1}/{taskCount})
                  </Text>
                  <Text> </Text>
                  <Text dimColor>(Shift+Left / Shift+Right)</Text>
                  <Text> | </Text>
                </>
              ) : hasLiveTasks && taskCount > 0 ? (
                <>
                  View: <Text>main</Text> <Text dimColor>(Shift+Left / Shift+Right)</Text>
                  <Text> | </Text>
                </>
              ) : null}
              {unchained ? "⚡ Unchained mode" : "Collaboration mode"}{" "}
              <Text dimColor>(Shift+Tab to toggle)</Text>
            </Text>
          )}
        </Box>
        <Text color={themeColor}>{versionCheck}</Text>
      </Box>
      <Box minHeight={1}>
        {displayedTempNotification && (
          <Box width="100%" flexShrink={0}>
            <Text color={themeColor} wrap="wrap">
              {displayedTempNotification}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

type TraceSegment =
  | { type: "assistant"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "tool-request"; toolName: string; args: string }
  | { type: "tool-output"; lines: number }
  | { type: "tool-error"; toolName: string; message: string }
  | { type: "task-error"; message: string }
  | { type: "user"; content: string };

function parseTraceSegments(trace: string): TraceSegment[] {
  const segments: TraceSegment[] = [];
  const blocks = trace.split(/\n\n(?=\[)/);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("[assistant]")) {
      segments.push({ type: "assistant", content: trimmed.slice("[assistant]".length).trim() });
    } else if (trimmed.startsWith("[reasoning]")) {
      segments.push({ type: "reasoning", content: trimmed.slice("[reasoning]".length).trim() });
    } else if (trimmed.startsWith("[tool-request]")) {
      const rest = trimmed.slice("[tool-request]".length).trim();
      const firstNewline = rest.indexOf("\n");
      const toolName = firstNewline === -1 ? rest : rest.slice(0, firstNewline).trim();
      const args = firstNewline === -1 ? "" : rest.slice(firstNewline + 1).trim();
      segments.push({ type: "tool-request", toolName, args });
    } else if (trimmed.startsWith("[tool-output]")) {
      const rest = trimmed.slice("[tool-output]".length).trim();
      const lineCount = parseInt(rest, 10);
      segments.push({ type: "tool-output", lines: isNaN(lineCount) ? 0 : lineCount });
    } else if (trimmed.startsWith("[tool-error]")) {
      const rest = trimmed.slice("[tool-error]".length).trim();
      const firstNewline = rest.indexOf("\n");
      const toolName = firstNewline === -1 ? rest : rest.slice(0, firstNewline).trim();
      const message = firstNewline === -1 ? "" : rest.slice(firstNewline + 1).trim();
      segments.push({ type: "tool-error", toolName, message });
    } else if (trimmed.startsWith("[task-error]")) {
      segments.push({ type: "task-error", message: trimmed.slice("[task-error]".length).trim() });
    } else if (trimmed.startsWith("[user]")) {
      segments.push({ type: "user", content: trimmed.slice("[user]".length).trim() });
    }
  }

  return segments;
}

const TraceSegmentRenderer = React.memo(
  ({ segment, taskId, index }: { segment: TraceSegment; taskId: string; index: number }) => {
    const themeColor = useColor();

    if (segment.type === "assistant") {
      return (
        <Box marginBottom={1}>
          <OctoMessageRenderer>
            <Box flexDirection="column" flexGrow={1}>
              <Markdown markdown={segment.content} />
            </Box>
          </OctoMessageRenderer>
        </Box>
      );
    }
    if (segment.type === "reasoning") {
      return (
        <Box marginBottom={1} marginLeft={3}>
          <Box flexDirection="column" borderStyle="single" paddingX={1} borderColor="gray">
            <Text color="gray" dimColor>
              Reasoning:
            </Text>
            <Text color="gray" dimColor wrap="wrap">
              {segment.content}
            </Text>
          </Box>
        </Box>
      );
    }
    if (segment.type === "tool-request") {
      return (
        <Box marginTop={1}>
          <Text color="gray">
            {segment.toolName}
            {segment.args ? `: ${segment.args.slice(0, 120)}` : ""}
          </Text>
        </Box>
      );
    }
    if (segment.type === "tool-output") {
      return (
        <Box marginBottom={1}>
          <Text color="gray">
            Got <Text>{segment.lines}</Text> lines of output
          </Text>
        </Box>
      );
    }
    if (segment.type === "tool-error") {
      return (
        <Box>
          <Text color="red">
            {segment.toolName ? `${segment.toolName}: ` : ""}Tool returned an error...
          </Text>
        </Box>
      );
    }
    if (segment.type === "task-error") {
      return (
        <Box>
          <Text color="red">{segment.message || "Task error"}</Text>
        </Box>
      );
    }
    if (segment.type === "user") {
      return (
        <Box marginY={1}>
          <Box marginRight={1}>
            <Text color="white">▶</Text>
          </Box>
          <Text>{segment.content}</Text>
        </Box>
      );
    }
    return null;
  },
);

const MAX_RENDERED_SEGMENTS = 40;

const TraceSegmentList = React.memo(
  ({ segments, taskId }: { segments: TraceSegment[]; taskId: string }) => (
    <Box flexDirection="column" paddingRight={4}>
      {segments.map((segment, index) => (
        <TraceSegmentRenderer
          key={`${taskId}-seg-${index}`}
          segment={segment}
          taskId={taskId}
          index={index}
        />
      ))}
    </Box>
  ),
);

function FocusedTaskPanel() {
  const themeColor = useColor();
  const terminalSize = useTerminalSize();
  const { focus, focusedTask, focusIndex, taskCount } = useAgentFocus();
  const lastTraceRef = useRef("");
  const segmentsRef = useRef<TraceSegment[]>([]);

  if (!focusedTask) return null;

  // Only re-parse when trace actually changes
  if (focusedTask.trace !== lastTraceRef.current) {
    lastTraceRef.current = focusedTask.trace;
    const allSegments = parseTraceSegments(focusedTask.trace);
    segmentsRef.current =
      allSegments.length > MAX_RENDERED_SEGMENTS
        ? allSegments.slice(-MAX_RENDERED_SEGMENTS)
        : allSegments;
  }

  const segments = segmentsRef.current;
  const scrollHeight = Math.max(6, terminalSize.height - 8);

  return (
    <Box flexDirection="column" flexGrow={1} minHeight={0}>
      <Box marginLeft={1}>
        <Text color={themeColor} dimColor>
          @{focusedTask.subagentName} ({focusIndex + 1}/{taskCount})
        </Text>
      </Box>
      <ScrollView height={scrollHeight}>
        <TraceSegmentList segments={segments} taskId={focusedTask.taskId} />
      </ScrollView>
    </Box>
  );
}

function MainTaskDashboard() {
  const themeColor = useColor();
  const { hasLiveTasks } = useAgentFocus();
  const { items, workingCount, failedCount } = useTaskDashboard();
  if (!hasLiveTasks || items.length === 0) return null;

  return (
    <Box marginTop={1} marginLeft={1} flexDirection="column">
      <Text color={themeColor}>
        {workingCount > 0
          ? `Parallel subagents running (${workingCount}/${items.length})`
          : `Subagent activity (${items.length})`}
      </Text>
      {items.map(item => {
        const color =
          item.status === "failed" ? "red" : item.status === "working" ? themeColor : "gray";
        const statusLabel =
          item.status === "working" ? "working" : item.status === "failed" ? "failed" : "completed";
        const callLabel = item.toolCalls === 1 ? "tool call" : "tool calls";
        return (
          <Text color={color} key={item.taskId}>
            @{item.subagentName} {item.description} | {statusLabel} | {item.toolCalls} {callLabel}
          </Text>
        );
      })}
      {failedCount > 0 && <Text color="red">Some delegated subagents failed.</Text>}
    </Box>
  );
}

const PackageSchema = t.subtype({
  "dist-tags": t.subtype({
    latest: t.str,
  }),
});
async function getLatestVersion() {
  try {
    const response = await fetch("https://registry.npmjs.com/octofriend");
    const contents = await response.json();
    const packageInfo = PackageSchema.slice(contents);
    return packageInfo["dist-tags"].latest;
  } catch {
    return null;
  }
}

function BottomBarContent({ inputHistory }: { inputHistory: InputHistory }) {
  const config = useConfig();
  const transport = useContext(TransportContext);
  const vimEnabled = !!config.vimEmulation?.enabled;
  const {
    modeData,
    input,
    abortResponse,
    openMenu,
    closeMenu,
    byteCount,
    setVimMode,
    query,
    setQuery,
    focusNextTask,
    focusPrevTask,
  } = useAppStore(
    useShallow(state => ({
      modeData: state.modeData,
      input: state.input,
      abortResponse: state.abortResponse,
      closeMenu: state.closeMenu,
      openMenu: state.openMenu,
      byteCount: state.byteCount,
      setVimMode: state.setVimMode,
      query: state.query,
      setQuery: state.setQuery,
      focusNextTask: state.focusNextTask,
      focusPrevTask: state.focusPrevTask,
    })),
  );
  const { taskCount } = useAgentFocus();
  const { totalToolCalls, bytesReceived } = useTaskDashboard();
  const { stdin } = useStdin();
  const lastNavRef = useRef<{ at: number; direction: "next" | "prev" | null }>({
    at: 0,
    direction: null,
  });

  const vimMode =
    vimEnabled && vimEnabled && modeData.mode === "input" ? modeData.vimMode : "NORMAL";

  const navigateSubagent = useCallback(
    (direction: "next" | "prev") => {
      const now = Date.now();
      if (lastNavRef.current.direction === direction && now - lastNavRef.current.at < 40) {
        return;
      }
      lastNavRef.current = { at: now, direction };
      if (direction === "next") focusNextTask();
      else focusPrevTask();
    },
    [focusNextTask, focusPrevTask],
  );
  const handleSubagentSwitchKey = useCallback(
    (
      input: string,
      key: {
        ctrl?: boolean;
        shift?: boolean;
        meta?: boolean;
        rightArrow?: boolean;
        leftArrow?: boolean;
      },
    ) => {
      const navDirection = resolveSubagentNavShortcut({
        input,
        key: {
          ctrl: key.ctrl === true,
          shift: key.shift === true,
          meta: key.meta === true,
          rightArrow: key.rightArrow === true,
          leftArrow: key.leftArrow === true,
        },
        mode: modeData.mode,
        taskCount,
      });
      if (!navDirection) return false;
      navigateSubagent(navDirection);
      return true;
    },
    [modeData.mode, taskCount, navigateSubagent],
  );

  useCtrlC(() => {
    if (vimEnabled) return;
    setQuery("");
  });

  useInput((input, key) => {
    if (handleSubagentSwitchKey(input, key)) {
      return;
    }

    if (key.escape) {
      // Vim INSERT mode: Esc ONLY returns to NORMAL (no menu, no abort)
      if (vimEnabled && vimMode === "INSERT" && modeData.mode === "input") {
        setVimMode("NORMAL");
        return;
      }

      abortResponse();
      if (modeData.mode === "menu") closeMenu();
    }

    if (key.ctrl && input === "p") {
      openMenu();
    }
  });

  useEffect(() => {
    if (!stdin || taskCount <= 0) return;

    const onData = (chunk: string | Buffer) => {
      const direction = resolveRawSubagentNavSequence(chunk.toString());
      if (!direction) return;

      if (modeData.mode === "input" || modeData.mode === "menu") return;
      navigateSubagent(direction);
    };

    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
    };
  }, [stdin, modeData.mode, taskCount, navigateSubagent]);
  const color = useColor();

  const onSubmit = useCallback(async () => {
    setQuery("");
    await input({ query, config, transport });
  }, [query, config, transport, setQuery]);

  if (modeData.mode === "responding" || modeData.mode === "compacting") {
    const preparingToolCalls =
      modeData.mode === "responding" &&
      byteCount > 0 &&
      !modeData.inflightResponse.content &&
      !modeData.inflightResponse.reasoningContent;

    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Loading
            overrideStrings={
              modeData.mode === "compacting"
                ? ["Compacting history to save context tokens"]
                : preparingToolCalls
                  ? [
                      "Preparing tool calls",
                      "Planning delegated subtasks",
                      "Building subagent requests",
                    ]
                  : undefined
            }
          />
          <Box>
            {byteCount === 0 ? null : <Text color={color}>⇩ {byteCount} bytes</Text>}
            <Text> </Text>
            <Text color="gray">(Press ESC to interrupt)</Text>
          </Box>
        </Box>
        <BusyInputRow
          inputHistory={inputHistory}
          query={query}
          setQuery={setQuery}
          onInputKey={handleSubagentSwitchKey}
          message="Octo is working... (draft your next prompt)"
        />
      </Box>
    );
  }
  if (modeData.mode === "error-recovery") return <Loading />;
  if (modeData.mode === "diff-apply") {
    return <Loading overrideStrings={["Auto-fixing diff"]} />;
  }
  if (modeData.mode === "fix-json") {
    return <Loading overrideStrings={["Auto-fixing JSON"]} />;
  }
  if (modeData.mode === "tool-waiting") {
    if (taskCount > 0) {
      return (
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Loading overrideStrings={[`Running ${taskCount} delegated subagents in parallel`]} />
            <Box>
              <Text color={color}>⇩ {bytesReceived} bytes</Text>
              <Text> </Text>
              <Text color="gray">
                {totalToolCalls} {totalToolCalls === 1 ? "tool call" : "tool calls"}
              </Text>
            </Box>
          </Box>
          <BusyInputRow
            inputHistory={inputHistory}
            query={query}
            setQuery={setQuery}
            onInputKey={handleSubagentSwitchKey}
            message="Subagents are running... (draft your next prompt)"
          />
        </Box>
      );
    }
    return (
      <Box flexDirection="column">
        <Loading
          overrideStrings={["Waiting", "Watching", "Smiling", "Hungering", "Splashing", "Writhing"]}
        />
        <BusyInputRow
          inputHistory={inputHistory}
          query={query}
          setQuery={setQuery}
          onInputKey={handleSubagentSwitchKey}
          message="Waiting for tool output... (draft your next prompt)"
        />
      </Box>
    );
  }
  if (modeData.mode === "payment-error") {
    return <PaymentErrorScreen error={modeData.error} />;
  }
  if (modeData.mode === "rate-limit-error") {
    return <RateLimitErrorScreen error={modeData.error} />;
  }
  if (modeData.mode === "request-error") {
    return (
      <RequestErrorScreen
        mode="request-error"
        contextualMessage="It looks like you've hit a request error!"
        error={modeData.error}
        curlCommand={modeData.curlCommand}
      />
    );
  }
  if (modeData.mode === "compaction-error") {
    return (
      <RequestErrorScreen
        mode="compaction-error"
        contextualMessage="History compaction failed due to a request error!"
        error={modeData.error}
        curlCommand={modeData.curlCommand}
      />
    );
  }

  if (modeData.mode === "tool-request") {
    return (
      <Box flexDirection="column">
        <ToolRequestRenderer toolReq={modeData.toolReq} config={config} transport={transport} />
        <ReadonlyInputRow
          inputHistory={inputHistory}
          message="Choose above. Composer stays visible."
        />
      </Box>
    );
  }

  const _: "menu" | "input" = modeData.mode;

  return (
    <Box flexDirection="column">
      <Box marginLeft={1} justifyContent="flex-end">
        <Text color="gray">(Ctrl+p to enter the menu)</Text>
      </Box>
      <InputWithHistory
        inputHistory={inputHistory}
        value={query}
        onChange={setQuery}
        onSubmit={onSubmit}
        vimEnabled={vimEnabled}
        vimMode={vimMode}
        setVimMode={setVimMode}
      />
      <VimModeIndicator vimEnabled={vimEnabled} vimMode={vimMode} />
    </Box>
  );
}

function ReadonlyInputRow({
  inputHistory,
  message,
}: {
  inputHistory: InputHistory;
  message: string;
}) {
  return (
    <InputWithHistory
      inputHistory={inputHistory}
      value=""
      onChange={() => {}}
      onSubmit={() => {}}
      focus={false}
      placeholder={message}
      showBorder={false}
      vimEnabled={false}
      vimMode={"NORMAL"}
      setVimMode={() => {}}
    />
  );
}

function BusyInputRow({
  inputHistory,
  query,
  setQuery,
  onInputKey,
  message,
}: {
  inputHistory: InputHistory;
  query: string;
  setQuery: (query: string) => void;
  onInputKey?: (
    input: string,
    key: {
      ctrl?: boolean;
      shift?: boolean;
      meta?: boolean;
      rightArrow?: boolean;
      leftArrow?: boolean;
    },
  ) => boolean;
  message: string;
}) {
  return (
    <InputWithHistory
      inputHistory={inputHistory}
      value={query}
      onChange={setQuery}
      onSubmit={() => {}}
      onInputKey={onInputKey}
      placeholder={message}
      showBorder={true}
      vimEnabled={false}
      vimMode={"NORMAL"}
      setVimMode={() => {}}
    />
  );
}

function RequestErrorScreen({
  mode,
  contextualMessage,
  error,
  curlCommand,
}: {
  mode: "request-error" | "compaction-error";
  contextualMessage: string;
  error: string;
  curlCommand: string | null;
}) {
  const config = useConfig();
  const transport = useContext(TransportContext);
  const { retryFrom, editAndRetryFrom } = useAppStore(
    useShallow(state => ({
      retryFrom: state.retryFrom,
      editAndRetryFrom: state.editAndRetryFrom,
    })),
  );
  const { exit } = useApp();

  const [viewError, setViewError] = useState(false);
  const [copiedCurl, setCopiedCurl] = useState(false);
  const [clipboardError, setClipboardError] = useState<string | null>(null);

  const mapping: Record<string, Item<"view" | "copy-curl" | "retry" | "edit-retry" | "quit">> = {};

  if (!viewError) {
    mapping["v"] = {
      label: "View error",
      value: "view",
    };
  }

  if (curlCommand) {
    mapping["c"] = {
      label: copiedCurl ? "Copied cURL!" : "Copy failed request as cURL",
      value: "copy-curl",
    };
  }

  mapping["r"] = {
    label: "Retry",
    value: "retry",
  };

  mapping["e"] = {
    label: "Edit & retry",
    value: "edit-retry",
  };

  mapping["q"] = {
    label: "Quit Octo",
    value: "quit",
  };

  const shortcutItems: ShortcutArray<"view" | "copy-curl" | "retry" | "edit-retry" | "quit"> = [
    {
      type: "key" as const,
      mapping,
    },
  ];

  const onSelect = useCallback(
    (item: Item<"view" | "copy-curl" | "retry" | "edit-retry" | "quit">) => {
      if (item.value === "view") {
        setViewError(true);
      } else if (item.value === "copy-curl") {
        try {
          clipboardy.writeSync(curlCommand || "Failed to generate cURL command");
          setCopiedCurl(true);
        } catch (error) {
          setClipboardError(error instanceof Error ? error.message : "Failed to copy to clipboard");
        }
      } else if (item.value === "retry") {
        retryFrom(mode, { config, transport });
      } else if (item.value === "edit-retry") {
        editAndRetryFrom(mode, { config, transport });
      } else {
        const _: "quit" = item.value;
        exit();
      }
    },
    [curlCommand, mode, config, transport],
  );

  return (
    <KbShortcutPanel title="" shortcutItems={shortcutItems} onSelect={onSelect}>
      <Text color="red">{contextualMessage}</Text>
      {viewError && (
        <Box marginY={1}>
          <Text>{error}</Text>
        </Box>
      )}
      {copiedCurl && (
        <Box marginY={1}>
          <Text>{curlCommand}</Text>
        </Box>
      )}
      {clipboardError && (
        <Box marginY={1}>
          <Text color="red">{clipboardError}</Text>
        </Box>
      )}
    </KbShortcutPanel>
  );
}

function RateLimitErrorScreen({ error }: { error: string }) {
  const config = useConfig();
  const transport = useContext(TransportContext);
  const { retryFrom } = useAppStore(
    useShallow(state => ({
      retryFrom: state.retryFrom,
    })),
  );

  useInput(() => {
    retryFrom("rate-limit-error", { config, transport });
  });

  return (
    <CenteredBox>
      <Text color="red">
        It looks like you've hit a rate limit! Here's the error from the backend:
      </Text>
      <Text>{error}</Text>
      <Text color="gray">Press any key when you're ready to retry.</Text>
    </CenteredBox>
  );
}

function PaymentErrorScreen({ error }: { error: string }) {
  const config = useConfig();
  const transport = useContext(TransportContext);
  const { retryFrom } = useAppStore(
    useShallow(state => ({
      retryFrom: state.retryFrom,
    })),
  );

  useInput(() => {
    retryFrom("payment-error", { config, transport });
  });

  return (
    <CenteredBox>
      <Text color="red">Payment error:</Text>
      <Text>{error}</Text>
      <Text color="gray">Once you've paid, press any key to continue.</Text>
    </CenteredBox>
  );
}

const ToolRequestItem = React.memo(
  ({
    isSelected = false,
    label,
    whitelistAllowDescription,
  }: {
    isSelected?: boolean;
    label: string;
    whitelistAllowDescription?: React.ReactNode;
  }) => {
    const themeColor = useColor();

    return (
      <Text color={isSelected ? themeColor : undefined}>
        {label}
        {whitelistAllowDescription}
      </Text>
    );
  },
);

function ToolRequestRenderer({
  toolReq,
  config,
  transport,
}: {
  toolReq: ToolCallRequest;
} & RunArgs) {
  const cwd = useCwd();
  const themeColor = useColor();
  const { runTool, rejectTool, isWhitelisted, addToWhitelist } = useAppStore(
    useShallow(state => ({
      runTool: state.runTool,
      rejectTool: state.rejectTool,
      isWhitelisted: state.isWhitelisted,
      addToWhitelist: state.addToWhitelist,
    })),
  );
  const unchained = useUnchained();

  const whitelistKey = (() => {
    const fn = toolReq.function;
    switch (fn.name) {
      case "read":
      case "list":
        return "read:*";
      case "create":
      case "rewrite":
      case "append":
      case "prepend":
      case "edit":
        return "edits:*";
      case "skill":
        return `${fn.name}:*`;
      case "shell":
        return `${fn.name}:*`;
      case "fetch":
        return `${fn.name}:*`;
      case "task":
        return `${fn.name}:*`;
      case "mcp":
        return `${fn.name}:${fn.arguments.server}:${fn.arguments.tool}`;
      case "web-search":
        return `${fn.name}:*`;
    }
  })();
  const prompt = (() => {
    const fn = toolReq.function;
    switch (fn.name) {
      case "create":
        return (
          <Box>
            <Text>Create file </Text>
            <Text color={themeColor}>{fn.arguments.filePath}</Text>
            <Text>?</Text>
          </Box>
        );
      case "rewrite":
      case "append":
      case "prepend":
      case "edit":
        return (
          <Box>
            <Text>Make these changes to </Text>
            <Text color={themeColor}>{fn.arguments.filePath}</Text>
            <Text>?</Text>
          </Box>
        );
      case "skill":
      case "read":
      case "shell":
      case "fetch":
      case "list":
      case "task":
      case "mcp":
      case "web-search":
        return null;
    }
  })();

  const toolName = toolReq.function.name;

  const [isToolWhitelisted, setIsToolWhitelisted] = useState<boolean | null>(null);

  useEffect(() => {
    (async () => {
      const whitelisted = await isWhitelisted(whitelistKey);
      setIsToolWhitelisted(whitelisted);
    })();
  }, [whitelistKey, isWhitelisted]);

  type SelectItem = {
    label: string;
    value: string;
    whitelistAllowDescription?: React.ReactNode;
  };
  const items: SelectItem[] = [
    {
      label: "Yes",
      value: "yes",
    },
    ...(!SKIP_CONFIRMATION_TOOLS.includes(toolName) &&
    !ALWAYS_REQUEST_PERMISSION_TOOLS.includes(toolName) &&
    !isToolWhitelisted
      ? [
          {
            label: "Yes, and always allow",
            value: "yes-whitelist",
            whitelistAllowDescription: <WhitelistAllowDescription toolCallRequest={toolReq} />,
          },
        ]
      : []),
    {
      label: "No, and tell Octo what to do differently",
      value: "no",
    },
  ];

  const onSelect = useCallback(
    async (item: (typeof items)[number]) => {
      if (item.value === "no") {
        rejectTool(toolReq.toolCallId);
      } else if (item.value === "yes-whitelist") {
        await addToWhitelist(whitelistKey);
        await runTool({ toolReq, config, transport });
      } else {
        await runTool({ toolReq, config, transport });
      }
    },
    [toolReq, config, transport, addToWhitelist, runTool, rejectTool, whitelistKey],
  );

  const noConfirmationNeeded =
    unchained ||
    SKIP_CONFIRMATION_TOOLS.includes(toolReq.function.name) ||
    isToolWhitelisted === true;

  useEffect(() => {
    if (noConfirmationNeeded) {
      runTool({ toolReq, config, transport });
    }
  }, [toolReq, noConfirmationNeeded, config, transport]);

  if (noConfirmationNeeded) return <Loading />;

  return (
    <Box flexDirection="column" gap={1}>
      {prompt}
      <SelectInput
        items={items}
        onSelect={onSelect}
        indicatorComponent={IndicatorComponent}
        itemComponent={ToolRequestItem}
      />
    </Box>
  );
}

const StaticItemRenderer = React.memo(({ item }: { item: StaticItem }) => {
  const themeColor = useColor();
  const model = useModel();
  const activeAgent = useActiveAgent();
  const unchained = useUnchained();

  if (item.type === "header") return <Header unchained={unchained} />;
  if (item.type === "version") {
    return (
      <Box marginTop={1} marginLeft={1} flexDirection="column">
        <Text color="gray">Agent: {activeAgent.name}</Text>
        <Text color="gray">Model: {model.nickname}</Text>
        <Text color="gray">Version: {item.metadata.version}</Text>
      </Box>
    );
  }
  if (item.type === "slogan") {
    return (
      <Box marginLeft={1} marginTop={1}>
        <Text>
          Octo is your friend. Tell Octo <Text color={themeColor}>what you want to do.</Text>
        </Text>
      </Box>
    );
  }
  if (item.type === "updates") {
    return (
      <Box marginTop={1} marginLeft={1} flexDirection="column">
        <Text bold>Updates:</Text>
        <Box marginTop={1} marginLeft={1}>
          <Markdown markdown={item.updates} />
        </Box>
        <Text color="gray">Thanks for updating!</Text>
        <Text color="gray">See the full changelog by running: `octo changelog`</Text>
      </Box>
    );
  }

  if (item.type === "boot-notification") {
    return (
      <Box marginLeft={1}>
        <Text color="gray">{item.content}</Text>
      </Box>
    );
  }

  return <MessageDisplay item={item.item} />;
});

const InflightResponsePanel = React.memo(() => {
  const { modeData } = useAppStore(
    useShallow(state => ({
      modeData: state.modeData,
    })),
  );

  if (modeData.mode !== "responding" && modeData.mode !== "compacting") return null;
  const inflight = modeData.inflightResponse;
  if (!inflight.reasoningContent && !inflight.content) return null;
  return <MessageDisplay item={inflight} />;
});

const MessageDisplay = React.memo(({ item }: { item: HistoryItem | InflightResponseType }) => {
  return (
    <Box flexDirection="column" paddingRight={4}>
      <MessageDisplayInner item={item} />
    </Box>
  );
});

const MessageDisplayInner = React.memo(({ item }: { item: HistoryItem | InflightResponseType }) => {
  const { modeData } = useAppStore(
    useShallow(state => ({
      modeData: state.modeData,
    })),
  );

  if (item.type === "notification") {
    return (
      <Box marginLeft={1}>
        <Text color="gray">{item.content}</Text>
      </Box>
    );
  }
  if (item.type === "assistant") {
    if (modeData.mode === "compacting") {
      return (
        <Box marginBottom={1}>
          <CompactionRenderer item={item} />
        </Box>
      );
    }
    return (
      <Box marginBottom={1}>
        <AssistantMessageRenderer item={item} />
      </Box>
    );
  }
  if (item.type === "tool") {
    return (
      <Box marginTop={1}>
        <ToolMessageRenderer item={item} />
      </Box>
    );
  }
  if (item.type === "tool-output") {
    const lines = (() => {
      if (item.result.lines == null) return item.result.content.split("\n").length;
      return item.result.lines;
    })();
    return (
      <Box marginBottom={1}>
        <Text color="gray">
          Got <Text>{lines}</Text> lines of output
        </Text>
      </Box>
    );
  }
  if (item.type === "tool-malformed") {
    return (
      <Text color="red">
        {displayLog({
          verbose: `Error: ${item.error}`,
          info: "Malformed tool call. Retrying...",
        })}
      </Text>
    );
  }
  if (item.type === "tool-failed") {
    return (
      <Text color="red">
        {displayLog({
          verbose: `Error: ${item.error}`,
          info: "Tool returned an error...",
        })}
      </Text>
    );
  }
  if (item.type === "tool-reject") {
    return <Text>Tool rejected; tell Octo what to do instead:</Text>;
  }
  if (item.type === "file-outdated") {
    return (
      <Box flexDirection="column">
        <Text>File was modified since it was last read; re-reading...</Text>
      </Box>
    );
  }
  if (item.type === "file-unreadable") {
    return (
      <Box flexDirection="column">
        <Text>File could not be read — has it been deleted?</Text>
      </Box>
    );
  }

  if (item.type === "request-failed") {
    return <Text color="red">Request failed.</Text>;
  }

  if (item.type === "compaction-failed") {
    return <Text color="red">Compaction failed.</Text>;
  }

  if (item.type === "compaction-checkpoint") {
    return <CompactionSummaryRenderer summary={item.summary} />;
  }

  const _: "user" = item.type;

  return (
    <Box marginY={1}>
      <Box marginRight={1}>
        <Text color="white">▶</Text>
      </Box>
      <Text>{item.content}</Text>
    </Box>
  );
});

function CompactionSummaryRenderer({ summary }: { summary: string }) {
  const color = useColor();
  const innerSummary = summary.replace(/^<summary>/, "").replace(/<\/summary>$/, "");
  return (
    <Box flexDirection="column" marginY={1}>
      <Text color="gray">History compacted! Summary: </Text>
      <Text color="gray">{innerSummary}</Text>
      <Text color={color}>Summary complete!</Text>
    </Box>
  );
}

function ToolMessageRenderer({ item }: { item: ToolCallItem }) {
  switch (item.tool.function.name) {
    case "read":
      return <ReadToolRenderer item={item.tool.function} />;
    case "list":
      return <ListToolRenderer item={item.tool.function} />;
    case "shell":
      return <ShellToolRenderer item={item.tool.function} />;
    case "edit":
      return <EditToolRenderer item={item.tool.function} />;
    case "create":
      return <CreateToolRenderer item={item.tool.function} />;
    case "mcp":
      return <McpToolRenderer item={item.tool.function} />;
    case "fetch":
      return <FetchToolRenderer item={item.tool.function} />;
    case "append":
      return <AppendToolRenderer item={item.tool.function} />;
    case "prepend":
      return <PrependToolRenderer item={item.tool.function} />;
    case "rewrite":
      return <RewriteToolRenderer item={item.tool.function} />;
    case "skill":
      return <SkillToolRenderer item={item.tool.function} />;
    case "task":
      return <TaskToolRenderer item={item.tool.function} />;
    case "web-search":
      return <WebSearchToolRenderer item={item.tool.function} />;
  }
}

function TaskToolRenderer({ item }: { item: ToolSchemaFrom<typeof task> }) {
  const parallel = item.arguments.parallel_tasks ?? [];
  if (parallel.length > 0) {
    return (
      <Box flexDirection="column">
        <Text color="gray">task (parallel): {parallel.length} subtasks</Text>
        <Text color="gray">
          {parallel.map(entry => `@${entry.subagent_type} ${entry.description}`).join(" | ")}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color="gray">task: {item.arguments.description}</Text>
      <Text color="gray">subagent: {item.arguments.subagent_type}</Text>
    </Box>
  );
}

function WebSearchToolRenderer(_: { item: ToolSchemaFrom<typeof webSearch> }) {
  return (
    <Box>
      <Text color="gray">Octo searched the web</Text>
    </Box>
  );
}

function SkillToolRenderer({ item }: { item: ToolSchemaFrom<typeof skill> }) {
  return (
    <Box>
      <Text color="gray">Octo read the {item.arguments.skillName} skill</Text>
    </Box>
  );
}

function AppendToolRenderer({ item }: { item: ToolSchemaFrom<typeof append> }) {
  const { filePath, text } = item.arguments;

  let startLineNr = 1;
  try {
    const file = readFileSync(filePath, "utf8");
    const lines = countLines(file);
    startLineNr = lines + 1;
  } catch {
    return null;
  }

  const renderedFile = (
    <FileRenderer contents={text} filePath={filePath} startLineNr={startLineNr} />
  );
  if (!renderedFile) return null;

  return (
    <Box flexDirection="column" gap={1}>
      <Text>Octo wants to add the following to the end of the file:</Text>
      {renderedFile}
    </Box>
  );
}

function FetchToolRenderer({ item }: { item: ToolSchemaFrom<typeof fetchTool> }) {
  const themeColor = useColor();
  return (
    <Box>
      <Text color="gray">{item.name}: </Text>
      <Text color={themeColor}>{item.arguments.url}</Text>
    </Box>
  );
}

function ShellToolRenderer({ item }: { item: ToolSchemaFrom<typeof shell> }) {
  const themeColor = useColor();
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="gray">{item.name}: </Text>
        <Text color={themeColor}>{item.arguments.cmd}</Text>
      </Box>
      <Text color="gray">timeout: {item.arguments.timeout}</Text>
    </Box>
  );
}

function ReadToolRenderer({ item }: { item: ToolSchemaFrom<typeof read> }) {
  const themeColor = useColor();
  return (
    <Box>
      <Text color="gray">{item.name}: </Text>
      <Text color={themeColor}>{item.arguments.filePath}</Text>
    </Box>
  );
}

function ListToolRenderer({ item }: { item: ToolSchemaFrom<typeof list> }) {
  const themeColor = useColor();
  return (
    <Box>
      <Text color="gray">{item.name}: </Text>
      <Text color={themeColor}>{item?.arguments?.dirPath || process.cwd()}</Text>
    </Box>
  );
}

function EditToolRenderer({ item }: { item: ToolSchemaFrom<typeof edit> }) {
  const themeColor = useColor();
  return (
    <Box flexDirection="column">
      <Box>
        <Text>Edit: </Text>
        <Text color={themeColor}>{item.arguments.filePath}</Text>
      </Box>
      <DiffEditRenderer filePath={item.arguments.filePath} item={item.arguments} />
    </Box>
  );
}

function PrependToolRenderer({ item }: { item: ToolSchemaFrom<typeof prepend> }) {
  const { text, filePath } = item.arguments;
  return (
    <Box flexDirection="column" gap={1}>
      <Text>Octo wants to add the following to the beginning of the file:</Text>
      <FileRenderer contents={text} filePath={filePath} />
    </Box>
  );
}

function RewriteToolRenderer({ item }: { item: ToolSchemaFrom<typeof rewrite> }) {
  const { text, filePath } = item.arguments;

  return (
    <Box flexDirection="column" gap={1}>
      <Text>Octo wants to rewrite the file:</Text>
      <DiffRenderer newText={text} filepath={filePath} />
    </Box>
  );
}

function DiffEditRenderer({
  item,
  filePath,
}: {
  item: t.GetType<typeof EditArgumentSchema>;
  filePath: string;
}) {
  return (
    <Box flexDirection="column">
      <Text>Octo wants to make the following changes:</Text>
      <DiffRenderer oldText={item.search} newText={item.replace} filepath={filePath} />
    </Box>
  );
}

function CreateToolRenderer({ item }: { item: ToolSchemaFrom<typeof createTool> }) {
  const themeColor = useColor();
  return (
    <Box flexDirection="column" gap={1}>
      <Box>
        <Text>Octo wants to create </Text>
        <Text color={themeColor}>{item.arguments.filePath}</Text>
        <Text>:</Text>
      </Box>
      <Box>
        <FileRenderer contents={item.arguments.content} filePath={item.arguments.filePath} />
      </Box>
    </Box>
  );
}

function McpToolRenderer({ item }: { item: ToolSchemaFrom<typeof mcp> }) {
  const themeColor = useColor();
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="gray">{item.name}: </Text>
        <Text color={themeColor}>
          Server: {item.arguments.server}, Tool: {item.arguments.tool}
        </Text>
      </Box>
      <Text color="gray">Arguments: {JSON.stringify(item.arguments.arguments)}</Text>
    </Box>
  );
}

function WhitelistAllowDescription({ toolCallRequest }: { toolCallRequest: ToolCallRequest }) {
  const fn = toolCallRequest.function;
  const cwd = useCwd();
  switch (fn.name) {
    case "shell": {
      return (
        <Text>
          <Text> commands starting with </Text>
          <Text bold>{fn.arguments.cmd}</Text>
        </Text>
      );
    }
    case "fetch": {
      return (
        <Text>
          <Text> fetches from the web.</Text>
        </Text>
      );
    }
    case "web-search": {
      return <Text>Web Searches</Text>;
    }
    case "list":
    case "read": {
      return (
        <Text>
          <Text> file reads in </Text>
          <Text bold>{cwd}</Text>
        </Text>
      );
    }
    case "edit":
    case "create":
    case "append":
    case "prepend":
    case "rewrite": {
      return (
        <Text>
          <Text> file changes in </Text>
          <Text bold>{cwd}</Text>
        </Text>
      );
    }
    case "mcp": {
      return (
        <Text>
          <Text>
            {" "}
            MCP tools with Server: <Text bold>{fn.arguments.server}</Text> using Tool:{" "}
            <Text bold>{fn.arguments.tool}</Text>
          </Text>
        </Text>
      );
    }
    case "skill": {
      return <Text>{fn.arguments.skillName} skill executions</Text>;
    }
    case "task": {
      return <Text> subagent delegations</Text>;
    }
  }
}

const OCTO_MARGIN = 1;
const OCTO_PADDING = 2;
function OctoMessageRenderer({ children }: { children?: React.ReactNode }) {
  return (
    <Box>
      <Box marginRight={OCTO_MARGIN} width={OCTO_PADDING} flexShrink={0} flexGrow={0}>
        <Octo />
      </Box>
      {children}
    </Box>
  );
}

function CompactionRenderer({ item }: { item: InflightResponseType }) {
  const terminalSize = useTerminalSize();
  const scrollHeight = Math.max(1, Math.min(10, terminalSize.height - 10));
  return (
    <OctoMessageRenderer>
      <MaybeScrollView height={scrollHeight}>
        <Text color="gray">{item.content}</Text>
      </MaybeScrollView>
    </OctoMessageRenderer>
  );
}

function AssistantMessageRenderer({ item }: { item: InflightResponseType }) {
  const terminalSize = useTerminalSize();
  let thoughts = item.reasoningContent ? item.reasoningContent.trim() : item.reasoningContent;
  let content = item.content.trim();

  // loading + busy input row + status bar + temp notification + padding
  let reservedSpace = 7;
  const showThoughts = thoughts && thoughts !== "";
  // Reserve space for the borders of the thoughtbox
  if (showThoughts) reservedSpace += 2;
  const scrollViewHeight = Math.max(1, terminalSize.height - reservedSpace - 1);
  return (
    <OctoMessageRenderer>
      <MaybeScrollView height={scrollViewHeight}>
        {showThoughts && <ThoughtBox thoughts={thoughts} />}
        <Markdown markdown={content} />
      </MaybeScrollView>
    </OctoMessageRenderer>
  );
}

function MaybeScrollView({ children, height }: { height: number; children?: React.ReactNode }) {
  const { modeData } = useAppStore(
    useShallow(state => ({
      modeData: state.modeData,
    })),
  );
  const isStreamingContent = modeData.mode == "responding" || modeData.mode == "compacting";
  return (
    <Box flexDirection="column" flexGrow={1}>
      {isStreamingContent ? (
        <ScrollView height={height}>{children}</ScrollView>
      ) : (
        <Box flexDirection="column">{children}</Box>
      )}
    </Box>
  );
}

const MAX_THOUGHTBOX_HEIGHT = 8;
const MAX_THOUGHTBOX_WIDTH = 80;
const THOUGHTBOX_MARGIN = 4;
function ThoughtBox({ thoughts }: { thoughts: string }) {
  const thoughtsRef = useRef<DOMElement | null>(null);
  const [thoughtsHeight, setThoughtsHeight] = useState(0);
  const terminalSize = useTerminalSize();
  const thoughtsOverflow = thoughtsHeight - (MAX_THOUGHTBOX_HEIGHT - 2);
  const isScrollable = useContext(IsScrollableContext);

  useEffect(() => {
    if (thoughtsRef.current) {
      const { height } = measureElement(thoughtsRef.current);
      setThoughtsHeight(height);
    }
  }, [thoughts]);

  const enforceMaxHeight = thoughtsOverflow > 0 && !isScrollable;
  const octoSpace = OCTO_MARGIN + OCTO_PADDING + 1;
  const scrollBorderWidth = 2;
  const contentMaxWidth = terminalSize.width - THOUGHTBOX_MARGIN - octoSpace - scrollBorderWidth;
  const maxWidth = Math.min(contentMaxWidth, MAX_THOUGHTBOX_WIDTH);

  return (
    <Box flexDirection="column">
      <Box
        flexGrow={0}
        flexShrink={1}
        height={enforceMaxHeight ? MAX_THOUGHTBOX_HEIGHT : undefined}
        width={maxWidth}
        overflowY={enforceMaxHeight ? "hidden" : undefined}
        flexDirection="column"
        borderColor="gray"
        borderStyle="round"
      >
        <Box
          ref={thoughtsRef}
          flexGrow={0}
          flexShrink={0}
          flexDirection="column"
          marginTop={enforceMaxHeight ? -1 * Math.max(0, thoughtsOverflow) : 0}
        >
          <Text color="gray">{thoughts}</Text>
        </Box>
      </Box>
    </Box>
  );
}

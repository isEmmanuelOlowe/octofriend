import path from "path";
import { parse as parseYaml } from "yaml";
import { Transport, getEnvVar } from "../transports/transport-common.ts";
import * as logger from "../logger.ts";

const AGENT_FILE_EXT = ".md";
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const NAME_PATTERN = /^[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*$/;

export type AgentMode = "primary" | "subagent" | "all";

export type Agent = {
  name: string;
  description?: string;
  mode: AgentMode;
  hidden?: boolean;
  color?: string;
  model?: string;
  steps?: number;
  temperature?: number;
  topP?: number;
  tools?: Record<string, boolean>;
  prompt: string;
  path: string;
  sourceFilePath?: string;
  native?: boolean;
};

type AgentFrontmatter = {
  name?: string;
  description?: string;
  mode?: AgentMode;
  hidden?: boolean;
  color?: string;
  model?: string;
  steps?: number;
  temperature?: number;
  top_p?: number;
  topP?: number;
  tools?: Record<string, boolean>;
};

export function builtinAgents(): Agent[] {
  return [
    {
      name: "octo",
      description: "Default coding agent. Orchestrates tasks and delegates to subagents.",
      mode: "primary",
      tools: {
        "*": true,
      },
      prompt: "",
      path: "builtin://octo",
      native: true,
    },
    {
      name: "plan",
      description:
        "Planner agent. Decomposes tasks into parallelisable work units before any implementation.",
      mode: "primary",
      tools: {
        "*": true,
        edit: false,
        append: false,
        prepend: false,
        rewrite: false,
        create: false,
      },
      prompt: `You are a planner. Your job is to analyse a task and produce a precise execution plan — NOT to implement it yourself.

Before planning, investigate the codebase thoroughly using read and list tools. Understand the current state, conventions, and constraints.

Your output must be a structured plan with:
- A list of discrete work units that can each be assigned to a single worker subagent
- Explicit scope boundaries for each unit (what it can and cannot touch)
- Dependency relationships between units (which can run in parallel, which must be sequential)
- Success criteria for each unit

Only produce implementation (code, edits) if the user explicitly asks for it.`,
      path: "builtin://plan",
      native: true,
    },
    {
      name: "general",
      description:
        "General-purpose worker subagent. Executes a specific, well-defined task within its assigned scope.",
      mode: "subagent",
      tools: {
        "*": true,
      },
      prompt: `You are a worker subagent. Execute the assigned task directly and completely within your assigned scope.

Prime directive: do your assigned work, within your assigned scope, to the specified standard, and nothing else. Do not "also fix" things outside your scope — that creates conflicts with other parallel workers.

When done, end your response with a structured completion report:

STATUS: COMPLETE
Artefacts modified: <list what you changed>
Known issues: <any problems or NONE>`,
      path: "builtin://general",
      native: true,
    },
    {
      name: "explore",
      description: "Read-only codebase exploration subagent. Gathers high-signal findings fast.",
      mode: "subagent",
      tools: {
        "*": false,
        read: true,
        list: true,
        fetch: true,
        "web-search": true,
        skill: true,
      },
      prompt: `You are a read-only exploration subagent. Investigate, never modify.

Gather high-signal findings quickly and return a concise, structured report. Cite precise file paths and line numbers. Do not speculate beyond what you observe.

When done, end your response with:

STATUS: COMPLETE
Findings: <count of key findings>
Risks: <count of identified risks or NONE>`,
      path: "builtin://explore",
      native: true,
    },
    {
      name: "researcher",
      description:
        "Read-only deep research subagent. Maps dependencies, patterns, and impact of proposed changes.",
      mode: "subagent",
      tools: {
        "*": false,
        read: true,
        list: true,
        fetch: true,
        "web-search": true,
        skill: true,
        shell: true,
      },
      prompt: `You are a researcher subagent. Your role is deep investigation — you NEVER modify files.

Research modes you operate in:
1. Overview: map the landscape (structure, patterns, conventions)
2. Impact analysis: what will a proposed change affect? (dependencies, consumers, risks)
3. Deep dive: how does a specific thing work? (trace flows, map connections)

Cite sources precisely: file paths, line numbers, function names. Do not speculate beyond evidence.

When done, end your response with:

STATUS: COMPLETE
Findings: <count of key findings>
Risks: <count of identified risks or NONE>`,
      path: "builtin://researcher",
      native: true,
    },
    {
      name: "reviewer",
      description:
        "Read-only code review subagent. Issues a verdict on correctness, quality, and safety.",
      mode: "subagent",
      tools: {
        "*": false,
        read: true,
        list: true,
        shell: true,
      },
      prompt: `You are a reviewer subagent. You NEVER modify files — you only read and evaluate.

Review the assigned work against requirements, correctness, security, and quality standards. Be adversarial: your job is to find problems, not rubber-stamp work.

Classify every issue by severity:
- P0 Critical: safety, security, data integrity, crashes — blocks all progress
- P1 Major: incorrect behaviour, bad patterns — should block integration
- P2 Minor: style, small improvements — fix if time permits
- P3 Suggestion: optional future improvements

End your response with a structured verdict:

VERDICT: APPROVED | CHANGES_REQUESTED | BLOCKED
Critical: <count>
Major: <count>
Minor: <count>`,
      path: "builtin://reviewer",
      native: true,
    },
    {
      name: "tester",
      description: "Testing subagent. Writes and runs tests, reports pass/fail and coverage.",
      mode: "subagent",
      tools: {
        "*": false,
        read: true,
        list: true,
        shell: true,
        edit: true,
        create: true,
        append: true,
      },
      prompt: `You are a tester subagent. Write and run verification procedures for the assigned work.

Cover: unit behaviour, integration points, edge cases, and regressions. Run existing tests to detect regressions. Create new tests only where coverage is missing.

Scope constraint: write test files only — do not modify source files under test.

End your response with:

STATUS: COMPLETE
Tests: <passed>/<total>
Coverage: <brief summary>
Regressions: <count or NONE>`,
      path: "builtin://tester",
      native: true,
    },
    {
      name: "janitor",
      description:
        "Post-verification cleanup subagent. Removes dead code, fixes style, never changes behaviour.",
      mode: "subagent",
      tools: {
        "*": false,
        read: true,
        list: true,
        shell: true,
        edit: true,
        create: false,
      },
      prompt: `You are a janitor subagent. Polish already-verified work without changing its behaviour.

Allowed actions: remove dead code, fix formatting, consolidate duplicates, improve naming consistency.
Forbidden: changing logic, altering function signatures, modifying test expectations.

Only run after verification has passed. If you are unsure whether a change is safe, skip it.

End your response with:

STATUS: COMPLETE
Removed: <count of artefacts/lines removed>
Refactored: <count of operations applied>`,
      path: "builtin://janitor",
      native: true,
    },
  ];
}

export function mergeAgents(custom: Agent[]): Agent[] {
  const merged = new Map<string, Agent>();

  for (const agent of builtinAgents()) {
    merged.set(agent.name, agent);
  }

  for (const agent of custom) {
    merged.set(agent.name, agent);
  }

  return [...merged.values()];
}

export function primaryAgents(agents: Agent[]): Agent[] {
  return agents.filter(
    agent => (agent.mode === "primary" || agent.mode === "all") && !agent.hidden,
  );
}

export function subagentChoices(agents: Agent[]): Agent[] {
  return agents.filter(
    agent => (agent.mode === "subagent" || agent.mode === "all") && !agent.hidden,
  );
}

export function resolveActiveAgent(agents: Agent[], activeAgentName: string | null): Agent {
  const availablePrimary = primaryAgents(agents);
  if (availablePrimary.length === 0) {
    return mergeAgents([])[0];
  }

  if (activeAgentName) {
    const matched = availablePrimary.find(agent => agent.name === activeAgentName);
    if (matched) return matched;
  }

  return availablePrimary[0];
}

export function resolveAgentModelOverride(
  agent: Agent,
  modelOverride: string | null,
): string | null {
  if (agent.model) return agent.model;
  return modelOverride;
}

export function isToolAllowed(agent: Agent, toolName: string): boolean {
  if (!agent.tools) return true;

  const direct = agent.tools[toolName];
  if (typeof direct === "boolean") return direct;

  const wildcard = agent.tools["*"];
  if (typeof wildcard === "boolean") return wildcard;

  return true;
}

export function filterToolsForAgent<T extends Record<string, unknown>>(agent: Agent, tools: T): T {
  const filtered: Record<string, unknown> = {};
  for (const [toolName, def] of Object.entries(tools)) {
    if (!isToolAllowed(agent, toolName)) continue;
    filtered[toolName] = def;
  }
  return filtered as T;
}

export function validateAgent(agent: Agent): string[] {
  const errors: string[] = [];

  if (!agent.name) {
    errors.push("name is required");
  } else {
    if (agent.name.length > MAX_NAME_LENGTH) {
      errors.push(`name exceeds ${MAX_NAME_LENGTH} characters`);
    }
    if (!NAME_PATTERN.test(agent.name)) {
      errors.push(
        "name must be alphanumeric with hyphens, no leading/trailing/consecutive hyphens",
      );
    }
  }

  if (agent.description && agent.description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters`);
  }

  if (!["primary", "subagent", "all"].includes(agent.mode)) {
    errors.push('mode must be one of: "primary", "subagent", "all"');
  }

  if (agent.steps != null && (!Number.isInteger(agent.steps) || agent.steps <= 0)) {
    errors.push("steps must be a positive integer");
  }

  if (agent.tools != null) {
    for (const [name, value] of Object.entries(agent.tools)) {
      if (typeof name !== "string" || name.trim() === "") {
        errors.push("tools keys must be non-empty strings");
      }
      if (typeof value !== "boolean") {
        errors.push(`tools.${name} must be boolean`);
      }
    }
  }

  if (agent.temperature != null) {
    if (typeof agent.temperature !== "number" || agent.temperature < 0 || agent.temperature > 2) {
      errors.push("temperature must be a number between 0 and 2");
    }
  }

  if (agent.topP != null) {
    if (typeof agent.topP !== "number" || agent.topP < 0 || agent.topP > 1) {
      errors.push("topP must be a number between 0 and 1");
    }
  }

  return errors;
}

function splitFrontmatter(content: string): { frontmatter: string; body: string } | null {
  const normalized = content.replace(/\r\n/g, "\n");

  if (!normalized.startsWith("---\n")) return null;

  const rest = normalized.slice(4);
  const endIndex = rest.indexOf("\n---");

  if (endIndex === -1) return null;

  return {
    frontmatter: rest.slice(0, endIndex),
    body: rest.slice(endIndex + 4).trim(),
  };
}

export function parseAgentContent(content: string, filePath: string): Agent | null {
  const baseName = path.basename(filePath, path.extname(filePath));
  const dirPath = path.dirname(filePath);

  const split = splitFrontmatter(content);
  if (!split) {
    const fallback: Agent = {
      name: baseName,
      mode: "primary",
      prompt: content.trim(),
      path: dirPath,
      sourceFilePath: filePath,
    };

    if (validateAgent(fallback).length > 0) return null;
    return fallback;
  }

  let frontmatter: AgentFrontmatter;
  try {
    frontmatter = parseYaml(split.frontmatter) as AgentFrontmatter;
  } catch {
    return null;
  }

  if (!frontmatter || typeof frontmatter !== "object") return null;

  const parsed: Agent = {
    name: frontmatter.name ?? baseName,
    description: frontmatter.description,
    mode: frontmatter.mode ?? "primary",
    hidden: frontmatter.hidden,
    color: frontmatter.color,
    model: frontmatter.model,
    steps: frontmatter.steps,
    temperature: frontmatter.temperature,
    topP: frontmatter.topP ?? frontmatter.top_p,
    tools: frontmatter.tools,
    prompt: split.body,
    path: dirPath,
    sourceFilePath: filePath,
  };

  const errors = validateAgent(parsed);
  if (errors.length > 0) return null;

  return parsed;
}

async function* walkMarkdownFiles(
  transport: Transport,
  signal: AbortSignal,
  dirPath: string,
): AsyncGenerator<string> {
  let entries: Array<{ entry: string; isDirectory: boolean }>;

  try {
    entries = await transport.readdir(signal, dirPath);
  } catch {
    return;
  }

  // Sort entries for deterministic traversal order across platforms
  entries.sort((a, b) => a.entry.localeCompare(b.entry));

  for (const entry of entries) {
    if (signal.aborted) return;

    const fullPath = path.join(dirPath, entry.entry);
    if (entry.isDirectory) {
      yield* walkMarkdownFiles(transport, signal, fullPath);
      continue;
    }

    if (entry.entry.endsWith(AGENT_FILE_EXT)) {
      yield fullPath;
    }
  }
}

async function getDefaultAgentPaths(transport: Transport, signal: AbortSignal): Promise<string[]> {
  const paths: string[] = [];
  const cwd = await transport.cwd(signal);
  paths.push(path.join(cwd, "agents"));
  paths.push(path.join(cwd, ".agents", "agents"));

  const home = await getEnvVar(signal, transport, "HOME", 5000);
  // Guard against missing or empty HOME - skip system-wide config to avoid unintended relative paths
  if (home) {
    paths.push(path.join(home, ".config", "octofriend", "agents"));
  }

  return paths;
}

export async function discoverAgents(transport: Transport, signal: AbortSignal): Promise<Agent[]> {
  // Use Map for deterministic last-wins precedence: later agents override earlier ones
  const agentsByName = new Map<string, Agent>();
  const seenFiles = new Set<string>();

  for (const basePath of await getDefaultAgentPaths(transport, signal)) {
    if (signal.aborted) break;
    if (!(await transport.pathExists(signal, basePath))) continue;

    for await (const filePath of walkMarkdownFiles(transport, signal, basePath)) {
      if (signal.aborted) break;
      if (seenFiles.has(filePath)) continue;
      seenFiles.add(filePath);

      try {
        const content = await transport.readFile(signal, filePath);
        const parsed = parseAgentContent(content, filePath);

        if (!parsed) {
          logger.error("info", `Failed to parse agent file: ${filePath}`);
          continue;
        }

        const errors = validateAgent(parsed);
        if (errors.length > 0) {
          logger.error("info", `Agent validation failed for ${filePath}: ${errors.join(", ")}`);
          continue;
        }

        // Last-wins: later agents with the same name override earlier ones
        // Files are processed in sorted order for deterministic precedence
        if (agentsByName.has(parsed.name)) {
          logger.error(
            "info",
            `Duplicate agent name "${parsed.name}" at ${filePath}, overriding previous definition`,
          );
        }

        agentsByName.set(parsed.name, parsed);
      } catch (e) {
        logger.error("info", `Error reading agent file ${filePath}: ${e}`);
      }
    }
  }

  return mergeAgents([...agentsByName.values()]);
}

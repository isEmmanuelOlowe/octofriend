import { describe, it, expect } from "vitest";
import {
  parseAgentContent,
  validateAgent,
  filterToolsForAgent,
  isToolAllowed,
  Agent,
  discoverAgents,
} from "./agents.ts";
import { Transport } from "../transports/transport-common.ts";

function createTestTransport(files: Record<string, string>): Transport {
  const normalized = new Map<string, string>();
  for (const [path, content] of Object.entries(files)) {
    normalized.set(path, content);
  }

  const isDirectory = (target: string) => {
    if (target === "/repo" || target === "/repo/agents" || target === "/repo/.agents") return true;
    if (target === "/repo/.agents/agents") return true;
    if (target === "/home/dev" || target === "/home/dev/.config") return true;
    if (target === "/home/dev/.config/octofriend") return true;
    if (target === "/home/dev/.config/octofriend/agents") return true;
    const prefix = target.endsWith("/") ? target : target + "/";
    return [...normalized.keys()].some(path => path.startsWith(prefix));
  };

  return {
    async writeFile() {
      throw new Error("unused");
    },
    async readFile(_signal, file) {
      const content = normalized.get(file);
      if (content == null) throw new Error("missing");
      return content;
    },
    async pathExists(_signal, file) {
      return normalized.has(file) || isDirectory(file);
    },
    async isDirectory(_signal, file) {
      return isDirectory(file);
    },
    async mkdir() {},
    async readdir(_signal, dirpath) {
      const prefix = dirpath.endsWith("/") ? dirpath : dirpath + "/";
      const directChildren = new Map<string, { entry: string; isDirectory: boolean }>();

      for (const filePath of normalized.keys()) {
        if (!filePath.startsWith(prefix)) continue;
        const rest = filePath.slice(prefix.length);
        if (rest.length === 0) continue;
        const [head, ...tail] = rest.split("/");
        directChildren.set(head, { entry: head, isDirectory: tail.length > 0 });
      }

      return [...directChildren.values()];
    },
    async modTime() {
      return Date.now();
    },
    async resolvePath(_signal, p) {
      return p;
    },
    async shell(_signal, command) {
      if (command === "echo $HOME") return "/home/dev\n";
      return "";
    },
    async cwd() {
      return "/repo";
    },
    async close() {},
  };
}

describe("agents", () => {
  describe("parseAgentContent", () => {
    it("parses an agent with frontmatter", () => {
      const content = `---
description: Focused docs writer
mode: subagent
model: Gemini Fast
tools:
  "*": false
  read: true
  fetch: true
steps: 8
hidden: true
---

You are a docs specialist.
`;

      const agent = parseAgentContent(content, "/repo/agents/docs.md");

      expect(agent).not.toBeNull();
      expect(agent!.name).toBe("docs");
      expect(agent!.description).toBe("Focused docs writer");
      expect(agent!.mode).toBe("subagent");
      expect(agent!.model).toBe("Gemini Fast");
      expect(agent!.tools).toEqual({ "*": false, read: true, fetch: true });
      expect(agent!.steps).toBe(8);
      expect(agent!.hidden).toBe(true);
      expect(agent!.prompt).toBe("You are a docs specialist.");
    });

    it("falls back to filename-based primary agent without frontmatter", () => {
      const content = "You are a simple agent.";
      const agent = parseAgentContent(content, "/repo/agents/simple.md");

      expect(agent).not.toBeNull();
      expect(agent!.name).toBe("simple");
      expect(agent!.mode).toBe("primary");
      expect(agent!.prompt).toBe("You are a simple agent.");
    });

    it("returns null for invalid frontmatter", () => {
      const content = `---
name: bad
steps: nope
---

Prompt
`;
      const agent = parseAgentContent(content, "/repo/agents/bad.md");
      expect(agent).toBeNull();
    });
  });

  describe("validateAgent", () => {
    it("accepts valid agent", () => {
      const agent: Agent = {
        name: "my-agent",
        mode: "all",
        prompt: "Prompt",
        path: "/repo/agents",
      };

      expect(validateAgent(agent)).toHaveLength(0);
    });

    it("rejects invalid tool map values", () => {
      const invalid = {
        name: "my-agent",
        mode: "primary",
        prompt: "Prompt",
        path: "/repo/agents",
        tools: {
          read: "yes",
        },
      } as unknown as Agent;

      expect(validateAgent(invalid).some(e => e.includes("must be boolean"))).toBe(true);
    });
  });

  describe("tool filtering", () => {
    it("respects wildcard deny + explicit allow", () => {
      const agent: Agent = {
        name: "strict",
        mode: "primary",
        prompt: "",
        path: "",
        tools: {
          "*": false,
          read: true,
          list: true,
        },
      };

      expect(isToolAllowed(agent, "read")).toBe(true);
      expect(isToolAllowed(agent, "edit")).toBe(false);

      const filtered = filterToolsForAgent(agent, {
        read: { id: 1 },
        edit: { id: 2 },
        list: { id: 3 },
      });

      expect(Object.keys(filtered).sort()).toEqual(["list", "read"]);
    });
  });

  describe("discoverAgents", () => {
    it("loads agent markdown files from agent directories", async () => {
      const transport = createTestTransport({
        "/repo/agents/writer.md": `---\nmode: primary\ndescription: Writes docs\n---\n\nYou write docs.`,
        "/repo/.agents/agents/reviewer.md": `---\nmode: subagent\ntools:\n  \"*\": false\n  read: true\n---\n\nReview only.`,
      });

      const agents = await discoverAgents(transport, new AbortController().signal);
      const writer = agents.find(a => a.name === "writer");
      const reviewer = agents.find(a => a.name === "reviewer");

      expect(writer).toBeDefined();
      expect(writer!.mode).toBe("primary");
      expect(writer!.description).toBe("Writes docs");

      expect(reviewer).toBeDefined();
      expect(reviewer!.mode).toBe("subagent");
      expect(reviewer!.tools).toEqual({ "*": false, read: true });
    });

    it("allows custom markdown agents to override built-in agents by name", async () => {
      const transport = createTestTransport({
        "/repo/agents/plan.md": `---\nmode: primary\ndescription: Custom planner\n---\n\nCustom prompt`,
      });

      const agents = await discoverAgents(transport, new AbortController().signal);
      const plan = agents.find(a => a.name === "plan");

      expect(plan).toBeDefined();
      expect(plan!.description).toBe("Custom planner");
      expect(plan!.native).toBeUndefined();
      expect(plan!.prompt).toBe("Custom prompt");
    });
  });
});

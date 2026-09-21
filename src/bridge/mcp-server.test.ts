import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { fleetFrom } from "../cli/fleet.js";
import { openSession, type ToolDescriptor, type ToolResult } from "../cli/server-session.js";
import type { Operation } from "../supervise/operation.js";
import { hostExecTool } from "./mcp-server.js";

/**
 * The MCP adapter is driven end to end: a real `node dist/cli/index.js bridge
 * mcp` process, reached through this repo's own client. That needs a build, so
 * the suite stands down when `dist` is absent and says so.
 */
const entry = resolve("dist/cli/index.js");
const built = existsSync(entry);
const onWindows = process.platform === "win32";

let hostRoot: string;
let configPath: string;

beforeAll(() => {
  hostRoot = mkdtempSync(join(tmpdir(), "bridge-mcp-"));
  writeFileSync(join(hostRoot, "hello.txt"), "hello over mcp", "utf8");
  configPath = join(hostRoot, "mcp-cli.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {},
      bridge: { containerRoot: "/workspace", hostRoot },
    }),
    "utf8",
  );
});

afterAll(() => {
  rmSync(hostRoot, { recursive: true, force: true });
});

/** One operation against the bridge, launched from the built CLI and closed after. */
async function perform<T>(op: Operation): Promise<T> {
  const fleet = fleetFrom(
    {
      mcpServers: {
        bridge: {
          command: process.execPath,
          args: [entry, "bridge", "mcp", "--config", configPath],
        },
      },
      profiles: {},
    },
    "default",
  );
  const session = await openSession(fleet, "bridge", { timeoutMs: 30000 });
  try {
    return (await session.perform(op, 30000)) as T;
  } finally {
    await session.close();
  }
}

describe("the host_exec tool definition", () => {
  const tool = hostExecTool("/workspace", "C:\\Users\\test\\agent-workspace");

  it("requires cmd and offers cwd, stdin and timeout", () => {
    expect(tool.inputSchema.oneOf).toEqual(expect.arrayContaining([{ required: ["cmd"] }]));
    expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining([
        "cmd",
        "cwd",
        "stdin",
        "timeout",
        "mode",
        "executable",
        "argv",
        "steps",
      ]),
    );
  });

  it("states the path contract in the description", () => {
    expect(tool.description).toContain("/workspace");
    expect(tool.description).toContain("C:\\Users\\test\\agent-workspace");
  });
});

describe.runIf(built && onWindows)("the MCP adapter over stdio", () => {
  it("exposes exactly one tool", async () => {
    const tools = await perform<ToolDescriptor[]>({ kind: "listTools" });
    expect(tools.map((t) => t.name)).toEqual(["host_exec"]);
  }, 30000);

  it("runs a command and returns the JSON result", async () => {
    const result = await perform<ToolResult>({
      kind: "callTool",
      name: "host_exec",
      args: { cmd: "type /workspace/hello.txt" },
    });
    const text = result.content?.[0]?.text ?? "";
    const payload = JSON.parse(text) as { exit: number; stdout: string };
    expect(payload.exit).toBe(0);
    expect(payload.stdout.trim()).toBe("hello over mcp");
  }, 30000);

  it("reports a non-zero exit as a normal result, not a tool error", async () => {
    const result = await perform<ToolResult>({
      kind: "callTool",
      name: "host_exec",
      args: { cmd: "exit /b 3" },
    });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content?.[0]?.text ?? "") as { exit: number };
    expect(payload.exit).toBe(3);
  }, 30000);
});

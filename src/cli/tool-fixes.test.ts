import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { spawnSync } from "child_process";
import { fileSpillStore } from "./spill.js";
import { retainSource } from "./result-source.js";
import { openSession } from "./server-session.js";
import { fleetFrom } from "./fleet.js";
import { createBridgeHttpServer } from "../bridge/http.js";
import { PathMap } from "../bridge/path-map.js";
import type { AddressInfo } from "net";

let dir: string, config: string;
const cli = resolve("dist/cli/index.js");
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tool-fixes-"));
  config = join(dir, "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      mcpServers: {
        scripted: {
          command: process.execPath,
          args: [resolve("src/__fixtures__/scripted-server.mjs")],
        },
      },
      profiles: { default: { block: [] }, restricted: { block: ["scripted.echo"] } },
      bridge: { hostRoot: dir, containerRoot: "/workspace", captureDir: join(dir, "capture") },
      pruning: { spillDir: join(dir, "spill") },
      supervision: { stateDir: join(dir, "state") },
    }),
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
function run(...args: string[]) {
  const r = spawnSync(process.execPath, [cli, ...args, "--config", config], {
    encoding: "utf8",
    env: { ...process.env, MCP_CLI_DAEMON: "0" },
    windowsHide: true,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe.runIf(existsSync(cli))("built tool-fix interfaces", () => {
  it("returns just the exact schema, preserves the full cache and respects profiles", () => {
    const exact = run("tools", "scripted.echo", "--schema", "--json");
    expect(exact.code).toBe(0);
    expect(JSON.parse(exact.out).tools.map((t: { name: string }) => t.name)).toEqual(["echo"]);
    const all = run("tools", "scripted", "--json");
    expect(JSON.parse(all.out).tools.length).toBeGreaterThan(1);
    const cache = readFileSync(join(dir, "state", "tools.json"), "utf8");
    expect(cache).toContain('"echo"');
    expect(cache).toContain('"counter"');
    expect(run("tools", "scripted.echo", "--profile", "restricted").code).toBe(3);
    expect(
      JSON.parse(run("tools", "scripted.echo", "--profile", "restricted", "--all", "--json").out)
        .tools[0].blockedBy,
    ).toBe("scripted.echo");
    const miss = run("tools", "scripted.echp", "--schema", "--json");
    expect(miss.code).not.toBe(0);
    expect(JSON.parse(miss.out).tools).toEqual([]);
    expect(miss.out.length).toBeLessThan(500);
  }, 30000);
  it("keeps v1 payload types and provides bounded v2 body excerpts", () => {
    const text = JSON.stringify({
      record: { name: "test", body: "boring\n".repeat(3000) + "keep-alive requires zstd" },
    });
    const args = JSON.stringify({ text });
    const v1 = run("call", "scripted.echo", args, "--json");
    expect(JSON.parse(v1.out).result.record.name).toBe("test");
    expect(JSON.parse(v1.out).result.record.body).toContain("--within /record/body");
    expect(
      JSON.parse(run("call", "scripted.echo", args, "--intent", "name", "--json").out).result,
    ).toBeTypeOf("string");
    const v2 = run(
      "call",
      "scripted.echo",
      args,
      "--intent",
      "zstd",
      "--envelope-version",
      "2",
      "--json",
    );
    expect(v2.code).toBe(0);
    expect(Buffer.byteLength(v2.out)).toBeLessThanOrEqual(4096);
    expect(
      JSON.parse(v2.out).result.items.some((i: { text?: string }) =>
        i.text?.includes("requires zstd"),
      ),
    ).toBe(true);
    const failed = run("call", "unknown", "--envelope-version", "2", "--json");
    expect(JSON.parse(failed.out)).toMatchObject({
      schemaVersion: 2,
      ok: false,
      result: { kind: "error" },
    });
  }, 30000);
  it("queries locally with all servers disabled and preserves exact spill get", () => {
    const store = fileSpillStore(join(dir, "spill"));
    const ref = retainSource(store, {
      content: [{ type: "text", text: '{"value":null,"body":"needle"}' }],
    });
    const q = run(
      "spill",
      "query",
      ref,
      "--select",
      "/value",
      "--select",
      "/absent",
      "--query",
      "needle",
      "--json",
    );
    expect(JSON.parse(q.out).result.items.slice(0, 2)).toEqual([
      { path: "/value", status: "complete", value: null },
      { path: "/absent", status: "missing" },
    ]);
    // `spill get` on a source ref prints the result's own text; the stored
    // wrapper stays as written, which `spill path` still points at.
    const raw = run("spill", "get", ref);
    expect(raw.out.trimEnd()).toBe('{"value":null,"body":"needle"}');
    expect(store.get(ref)).toContain('"$source":"mcp-cli-source-v1"');
    expect(
      readdirSync(join(dir, "spill")).filter((f) => f.endsWith(".derived.json")).length,
    ).toBeGreaterThan(0);
  });
  it("propagates checked process status and raw bytes through CLI and HTTP", async () => {
    const request = {
      mode: "process",
      executable: process.execPath,
      argv: ["-e", "process.stdout.write('é');process.exit(7)"],
    };
    const file = join(dir, "request.json");
    writeFileSync(file, JSON.stringify(request));
    const cliResult = run("bridge", "exec", "--request-file", file, "--json");
    expect(cliResult.code).toBe(7);
    const parsed = JSON.parse(cliResult.out);
    expect(parsed.execution).toMatchObject({ status: "failed", exitCode: 7 });
    expect(readFileSync(parsed.capture.stdout.path)).toEqual(Buffer.from("é"));
    writeFileSync(file, JSON.stringify({ ...request, acceptedExitCodes: [7] }));
    expect(run("bridge", "exec", "--request-file", file, "--json").code).toBe(0);
    const server = createBridgeHttpServer({
      pathMap: new PathMap({ hostRoot: dir, containerRoot: "/workspace" }),
      captureDir: join(dir, "capture"),
      token: "fixture",
      log: () => {},
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/exec`;
    try {
      expect((await fetch(url, { method: "POST", body: JSON.stringify(request) })).status).toBe(
        401,
      );
      const result = await fetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer fixture" },
        body: JSON.stringify(request),
      });
      expect(await result.json()).toMatchObject({ exit: 7, execution: parsed.execution });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
  it("exposes process results over MCP without changing legacy isError semantics", async () => {
    const fleet = fleetFrom(
      {
        mcpServers: {
          bridge: { command: process.execPath, args: [cli, "bridge", "mcp", "--config", config] },
        },
        profiles: {},
      },
      "default",
    );
    const session = await openSession(fleet, "bridge", { timeoutMs: 10000 });
    try {
      const result = (await session.perform(
        {
          kind: "callTool",
          name: "host_exec",
          args: { mode: "process", executable: process.execPath, argv: ["-e", "process.exit(7)"] },
        },
        10000,
      )) as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        exit: 7,
        execution: { status: "failed" },
      });
    } finally {
      await session.close();
    }
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { PathMap } from "./path-map.js";
import { createBridgeHttpServer } from "./http.js";
import { TIMEOUT_EXIT } from "./exec.js";

const onWindows = process.platform === "win32";

let hostRoot: string;
let server: Server;
let base: string;
const logged: string[] = [];

beforeAll(async () => {
  hostRoot = mkdtempSync(join(tmpdir(), "bridge-http-"));
  writeFileSync(join(hostRoot, "hello.txt"), "hello over http", "utf8");
  server = createBridgeHttpServer({
    pathMap: new PathMap({ containerRoot: "/workspace", hostRoot }),
    defaultTimeoutS: 30,
    maxTimeoutS: 60,
    log: (line) => logged.push(line),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(hostRoot, { recursive: true, force: true });
});

async function post(path: string, body: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${path}`, { method: "POST", body });
  return { status: res.status, json: await res.json() };
}

describe("the HTTP adapter", () => {
  it("answers 404 outside POST /exec", async () => {
    const res = await fetch(`${base}/anything`);
    expect(res.status).toBe(404);
  });

  it("answers 400 on a body that is not JSON", async () => {
    const { status } = await post("/exec", "not json");
    expect(status).toBe(400);
  });

  it("answers 500 when the command cannot start", async () => {
    const { status, json } = await post("/exec", JSON.stringify({ cmd: "" }));
    expect(status).toBe(500);
    expect(json).toHaveProperty("error");
  });
});

describe.runIf(onWindows)("the HTTP adapter against cmd.exe", () => {
  it("returns exit, stdout and stderr", async () => {
    const { status, json } = await post("/exec", JSON.stringify({ cmd: "echo over-the-wire" }));
    expect(status).toBe(200);
    expect(json).toMatchObject({ exit: 0, stderr: "" });
    expect((json as { stdout: string }).stdout.trim()).toBe("over-the-wire");
  });

  it("applies the path contract", async () => {
    const { json } = await post("/exec", JSON.stringify({ cmd: "type /workspace/hello.txt" }));
    expect((json as { stdout: string }).stdout.trim()).toBe("hello over http");
  });

  it("hides the host root from the output", async () => {
    const { json } = await post("/exec", JSON.stringify({ cmd: "cd" }));
    expect((json as { stdout: string }).stdout.trim()).toBe("/workspace");
  });

  it("returns exit 124 when the timeout runs out", async () => {
    const { json } = await post(
      "/exec",
      JSON.stringify({ cmd: "ping -n 5 127.0.0.1", timeout: 1 }),
    );
    expect(json).toMatchObject({ exit: TIMEOUT_EXIT, stderr: "timeout after 1s" });
  }, 20000);

  it("logs one line per request", async () => {
    const before = logged.length;
    await post("/exec", JSON.stringify({ cmd: "echo logged" }));
    expect(logged.length).toBe(before + 1);
    expect(logged[logged.length - 1]).toContain("exit=0");
  });
});

import { describe, it, expect } from "vitest";
import { McpExecutor } from "./executor.js";
import { ScriptedLane } from "./scripted-lane.js";
import { DaemonUnavailable } from "./lane.js";
import { fleetFrom } from "../cli/fleet.js";
import { supervisionSettings } from "../cli/config.js";

describe("typed fallback outcomes", () => {
  for (const reason of ["config_mismatch", "not_running"] as const) {
    for (const outcome of ["success", "failure", "required", "absent"] as const) {
      it(`${reason}: ${outcome}`, async () => {
        const config = {
          mcpServers: { api: { command: "unused" } },
          supervision: {
            defaults: { maxAttempts: 1 },
            rules: { api: { daemonRequired: outcome === "required" } },
          },
        };
        const primary = new ScriptedLane("daemon"),
          fallback = new ScriptedLane("ephemeral");
        primary.script("api", { throws: new DaemonUnavailable("detail", reason) });
        fallback.script(
          "api",
          outcome === "failure" ? { throws: new Error("failed fallback") } : { value: [] },
        );
        const events: string[] = [];
        const executor = new McpExecutor({
          fleet: fleetFrom(config, "default"),
          settings: supervisionSettings(config),
          primary,
          fallback: outcome === "absent" ? undefined : fallback,
          onFallback: (r) => events.push(r),
        });
        if (outcome === "success") {
          expect(await executor.execute("api", { kind: "listTools" })).toMatchObject({
            lane: "ephemeral",
            fallbackReason: reason,
          });
          expect(events).toEqual([reason]);
        } else {
          await expect(executor.execute("api", { kind: "listTools" })).rejects.toThrow();
          expect(events).toEqual([]);
          if (outcome !== "failure") expect(fallback.performs).toHaveLength(0);
        }
      });
    }
  }
  it("does not reinterpret a remote tool failure as daemon unavailability", async () => {
    const config = { mcpServers: { api: { command: "unused" } } };
    const primary = new ScriptedLane("daemon"),
      fallback = new ScriptedLane("ephemeral");
    primary.script("api", {
      value: { isError: true, content: [{ type: "text", text: "bad argument" }] },
    });
    const events: string[] = [];
    const executor = new McpExecutor({
      fleet: fleetFrom(config, "default"),
      settings: supervisionSettings(config),
      primary,
      fallback,
      onFallback: (r) => events.push(r),
    });
    const result = await executor.execute("api", { kind: "callTool", name: "write", args: {} });
    expect(result.lane).toBe("daemon");
    expect(events).toEqual([]);
    expect(fallback.performs).toHaveLength(0);
  });
});

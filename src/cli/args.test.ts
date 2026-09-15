import { describe, it, expect } from "vitest";
import { parseArgs, UsageError } from "./args.js";

describe("parseArgs", () => {
  it("takes the first bare word as the command", () => {
    const a = parseArgs(["tools", "forum"]);
    expect(a.command).toBe("tools");
    expect(a.positionals).toEqual(["forum"]);
  });

  it("reads a value flag written with a space", () => {
    expect(parseArgs(["tools", "--profile", "safe"]).profile).toBe("safe");
  });

  it("reads a value flag written with an equals sign", () => {
    expect(parseArgs(["tools", "--profile=safe"]).profile).toBe("safe");
  });

  it("reads the boolean flags", () => {
    const a = parseArgs(["tools", "--all", "--json"]);
    expect(a.all).toBe(true);
    expect(a.json).toBe(true);
  });

  it("parses a timeout as a number of milliseconds", () => {
    expect(parseArgs(["call", "--timeout", "5000"]).timeoutMs).toBe(5000);
  });

  it("rejects a timeout that is not a positive number", () => {
    expect(() => parseArgs(["call", "--timeout", "soon"])).toThrow(UsageError);
    expect(() => parseArgs(["call", "--timeout", "-1"])).toThrow(UsageError);
  });

  it("rejects a value flag with nothing after it", () => {
    expect(() => parseArgs(["tools", "--profile"])).toThrow(/needs a value/);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseArgs(["tools", "--nope"])).toThrow(/Unknown flag/);
  });

  it("passes everything after -- through as a positional", () => {
    const a = parseArgs(["call", "forum.poll", "--", "--json"]);
    expect(a.positionals).toEqual(["forum.poll", "--json"]);
    expect(a.json).toBe(false);
  });

  it("keeps a JSON payload that starts with a brace as a positional", () => {
    const a = parseArgs(["call", "forum.poll", '{"a":1}']);
    expect(a.positionals).toEqual(["forum.poll", '{"a":1}']);
  });

  it("reports no command for an empty argument list", () => {
    expect(parseArgs([]).command).toBeUndefined();
  });
});

describe("the pruning flags", () => {
  it("takes --format with a space", () => {
    expect(parseArgs(["call", "--format", "table", "a.b", "{}"]).format).toBe("table");
  });

  it("takes --format with an equals sign", () => {
    expect(parseArgs(["call", "--format=compact", "a.b", "{}"]).format).toBe("compact");
  });

  it("accepts each of the three format names", () => {
    for (const f of ["raw", "compact", "table"] as const) {
      expect(parseArgs(["--format", f]).format).toBe(f);
    }
  });

  it("rejects a --format value that is not one of the three names", () => {
    expect(() => parseArgs(["call", "--format", "yaml"])).toThrow(UsageError);
    expect(() => parseArgs(["call", "--format=yaml"])).toThrow(/--format/);
  });

  it("rejects a --format with nothing after it", () => {
    expect(() => parseArgs(["call", "--format"])).toThrow(/needs a value/);
  });

  it("takes --intent with a space and with an equals sign", () => {
    expect(parseArgs(["call", "--intent", "housing", "a.b", "{}"]).intent).toBe("housing");
    expect(parseArgs(["call", "--intent=housing", "a.b", "{}"]).intent).toBe("housing");
  });

  it("keeps an --intent that is empty only when written with an equals sign", () => {
    expect(() => parseArgs(["call", "--intent"])).toThrow(/needs a value/);
  });
});

describe("the bridge flags", () => {
  it("takes --port as a number", () => {
    expect(parseArgs(["bridge", "serve", "--port", "8791"]).port).toBe(8791);
  });

  it("rejects a port that is not a TCP port", () => {
    expect(() => parseArgs(["bridge", "serve", "--port", "70000"])).toThrow(UsageError);
    expect(() => parseArgs(["bridge", "serve", "--port", "http"])).toThrow(UsageError);
  });

  it("takes --bind, --cwd and --stdin as text", () => {
    const a = parseArgs([
      "bridge",
      "exec",
      "cmd",
      "--bind",
      "127.0.0.1",
      "--cwd",
      "/workspace/sub",
      "--stdin",
      "-",
    ]);
    expect(a.bind).toBe("127.0.0.1");
    expect(a.cwd).toBe("/workspace/sub");
    expect(a.stdin).toBe("-");
  });

  it("offers one --timeout number in both units", () => {
    const a = parseArgs(["bridge", "exec", "cmd", "--timeout", "5"]);
    expect(a.timeoutMs).toBe(5);
    expect(a.timeoutSeconds).toBe(5);
  });

  it("rejects a --timeout that is not a positive number, in both units", () => {
    expect(() => parseArgs(["bridge", "exec", "cmd", "--timeout", "abc"])).toThrow(UsageError);
    expect(() => parseArgs(["bridge", "exec", "cmd", "--timeout", "0"])).toThrow(UsageError);
  });
});

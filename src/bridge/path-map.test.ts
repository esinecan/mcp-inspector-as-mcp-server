import { describe, it, expect } from "vitest";
import { win32 } from "path";
import { PathMap } from "./path-map.js";
import { runSelftest } from "./selftest.js";

const HOST = "C:\\Users\\test\\agent-workspace";
const map = new PathMap({ containerRoot: "/workspace", hostRoot: HOST });

describe("the six selftest cases", () => {
  const rows = runSelftest(map);

  for (const row of rows) {
    it(row.name, () => {
      expect(row.got).toBe(row.want);
      expect(row.ok).toBe(true);
    });
  }

  it("runs exactly six cases", () => {
    expect(rows).toHaveLength(6);
  });
});

describe("rewriteCommand", () => {
  it("rewrites every occurrence, not only the first", () => {
    expect(map.rewriteCommand("copy /workspace/a /workspace/b /workspace/c")).toBe(
      `copy ${HOST}\\a ${HOST}\\b ${HOST}\\c`,
    );
  });

  it("leaves a path that only contains the root as a substring", () => {
    expect(map.rewriteCommand("cat /srv/workspace/x")).toBe("cat /srv/workspace/x");
    expect(map.rewriteCommand("cat myworkspace/x")).toBe("cat myworkspace/x");
  });

  it("rewrites a root that ends the string", () => {
    expect(map.rewriteCommand("cd /workspace")).toBe(`cd ${HOST}`);
  });

  it("rewrites a root followed by a quote", () => {
    expect(map.rewriteCommand('type "/workspace/a b.txt"')).toBe(`type "${HOST}\\a b.txt"`);
  });
});

describe("toHost", () => {
  it("maps the bare root", () => {
    expect(map.toHost("/workspace")).toBe(win32.normalize(HOST));
  });

  it("maps a nested path with backslash separators", () => {
    expect(map.toHost("/workspace/sub/x.txt")).toBe(`${HOST}\\sub\\x.txt`);
  });

  it("leaves a path outside the root alone", () => {
    expect(map.toHost("/etc/hosts")).toBe("/etc/hosts");
  });
});

describe("toContainer", () => {
  it("maps the backslash spelling back", () => {
    // Only the root is replaced, so the separator it left behind stays a
    // backslash. cmd.exe and every Windows tool accept either one.
    expect(map.toContainer(`${HOST}\\hello.txt`)).toBe("/workspace\\hello.txt");
  });

  it("maps the forward-slash spelling back", () => {
    expect(map.toContainer("C:/Users/test/agent-workspace/hello.txt")).toBe("/workspace/hello.txt");
  });

  it("maps both spellings in one string", () => {
    const text = `${HOST}\\a and C:/Users/test/agent-workspace/b`;
    expect(map.toContainer(text)).toBe("/workspace\\a and /workspace/b");
  });

  it("leaves text with no host path alone", () => {
    expect(map.toContainer("nothing to see")).toBe("nothing to see");
  });
});

describe("a different root pair", () => {
  const other = new PathMap({ containerRoot: "/data", hostRoot: "D:\\work" });

  it("uses the configured roots", () => {
    expect(other.rewriteCommand("tool /data/in")).toBe("tool D:\\work\\in");
    expect(other.toContainer("D:\\work\\out")).toBe("/data\\out");
  });
});

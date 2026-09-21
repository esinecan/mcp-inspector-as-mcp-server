import { describe, it, expect } from "vitest";
import { ArgumentError, parseArguments, readArgumentText } from "./input.js";

const noStdin = () => {
  throw new Error("stdin should not be read");
};

describe("readArgumentText", () => {
  it("returns an empty object for a missing argument", () => {
    expect(readArgumentText(undefined, noStdin)).toBe("{}");
    expect(readArgumentText("", noStdin)).toBe("{}");
  });

  it("returns inline text unchanged", () => {
    expect(readArgumentText('{"a":1}', noStdin)).toBe('{"a":1}');
  });

  it("reads stdin for -", () => {
    expect(readArgumentText("-", () => '{"from":"stdin"}')).toBe('{"from":"stdin"}');
  });

  it("reads a file for @path", () => {
    expect(readArgumentText("@args.json", noStdin, () => '{"from":"file"}')).toBe(
      '{"from":"file"}',
    );
  });

  it("names the file it could not read", () => {
    expect(() =>
      readArgumentText("@missing.json", noStdin, () => {
        throw new Error("ENOENT");
      }),
    ).toThrow(/Cannot read arguments from missing.json/);
  });

  it("rejects a bare @", () => {
    expect(() => readArgumentText("@", noStdin)).toThrow(ArgumentError);
  });
});

describe("parseArguments", () => {
  it("parses an object", () => {
    expect(parseArguments('{"a":1}')).toEqual({ a: 1 });
  });

  it("treats empty text as an empty object", () => {
    expect(parseArguments("   ")).toEqual({});
  });

  it("rejects a JSON array", () => {
    expect(() => parseArguments("[1,2]")).toThrow(/must be a JSON object/);
  });

  it("rejects a JSON scalar", () => {
    expect(() => parseArguments('"hello"')).toThrow(/must be a JSON object/);
  });

  it("rejects broken JSON", () => {
    expect(() => parseArguments("{oops")).toThrow(/not valid JSON/);
  });
});

describe("--args-file", () => {
  const read = (path: string): string => {
    if (path === "/args.json") return '{"name":"pi-stack"}';
    throw new Error("ENOENT: no such file or directory");
  };

  it("reads the arguments from the named file, with no sigil", () => {
    expect(readArgumentText(undefined, () => "", read, "/args.json")).toBe('{"name":"pi-stack"}');
  });

  it("names the file when it cannot be read", () => {
    expect(() => readArgumentText(undefined, () => "", read, "/missing.json")).toThrow(
      /Cannot read arguments from \/missing\.json/,
    );
  });

  it("refuses the flag and a positional argument together", () => {
    // Two ways to say the same thing is a mistake, not a precedence question.
    expect(() => readArgumentText("{}", () => "", read, "/args.json")).toThrow(
      /both give the arguments\. Pass one\./,
    );
  });

  it("leaves the three older forms alone", () => {
    expect(readArgumentText('{"a":1}', () => "", read)).toBe('{"a":1}');
    expect(readArgumentText("-", () => "from stdin", read)).toBe("from stdin");
    expect(readArgumentText("@/args.json", () => "", read)).toBe('{"name":"pi-stack"}');
  });
});

describe("a dropped @ sigil", () => {
  const exists = (path: string): boolean => path === "C:\\tmp\\args.json";

  it("says the text is a file, because that is what a dropped sigil looks like", () => {
    // PowerShell's @("$p") evaluates to the bare path, so the path arrives
    // where JSON was expected and "Unexpected token 'C'" explains nothing.
    expect(() => parseArguments("C:\\tmp\\args.json", "C:\\tmp\\args.json", exists)).toThrow(
      /is a file that exists\. To read the arguments from it: --args-file C:\\tmp\\args\.json/,
    );
  });

  it("keeps the plain JSON error for text that names no file", () => {
    expect(() => parseArguments("{oops", "{oops", exists)).toThrow(/Arguments are not valid JSON:/);
  });

  it("keeps the plain JSON error when the caller passed no spec", () => {
    expect(() => parseArguments("C:\\tmp\\args.json")).toThrow(/Arguments are not valid JSON:/);
  });

  it("never asks the file system about a large payload", () => {
    let asked = 0;
    const counted = (p: string): boolean => {
      asked++;
      return exists(p);
    };
    const big = `{${"x".repeat(5000)}`;
    expect(() => parseArguments(big, big, counted)).toThrow(/not valid JSON:/);
    expect(asked).toBe(0);
  });
});

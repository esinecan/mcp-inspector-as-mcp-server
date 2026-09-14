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

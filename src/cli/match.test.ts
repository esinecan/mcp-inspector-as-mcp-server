import { describe, it, expect } from "vitest";
import { resolveAddress, splitAddress } from "./match.js";

const addresses = ["forum.post", "forum.poll", "forum.history", "gmail.send_message"];

describe("resolveAddress", () => {
  it("takes an exact address first", () => {
    expect(resolveAddress("forum.post", addresses)).toEqual({
      kind: "exact",
      address: "forum.post",
    });
  });

  it("prefers an exact address over a substring of a longer one", () => {
    // "forum.po" is a substring of both post and poll, but "forum.poll" is exact.
    expect(resolveAddress("forum.poll", addresses)).toEqual({
      kind: "exact",
      address: "forum.poll",
    });
  });

  it("matches case-insensitively when only one address fits", () => {
    expect(resolveAddress("FORUM.Post", addresses)).toEqual({
      kind: "fuzzy",
      address: "forum.post",
    });
  });

  it("matches a substring when only one address fits", () => {
    expect(resolveAddress("forum.hist", addresses)).toEqual({
      kind: "fuzzy",
      address: "forum.history",
    });
    expect(resolveAddress("send", addresses)).toEqual({
      kind: "fuzzy",
      address: "gmail.send_message",
    });
  });

  it("reports every candidate when a substring is ambiguous", () => {
    const result = resolveAddress("forum.po", addresses);
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates.sort()).toEqual(["forum.poll", "forum.post"]);
    }
  });

  it("reports no match when nothing fits", () => {
    expect(resolveAddress("forum.zzz", addresses)).toEqual({ kind: "none" });
  });

  it("reports no match against an empty list", () => {
    expect(resolveAddress("forum.post", [])).toEqual({ kind: "none" });
  });
});

describe("splitAddress", () => {
  it("splits on the first dot", () => {
    expect(splitAddress("forum.post")).toEqual({ server: "forum", tool: "post" });
  });

  it("keeps a dot inside the tool name", () => {
    expect(splitAddress("srv.a.b")).toEqual({ server: "srv", tool: "a.b" });
  });

  it("rejects an address with no server or no tool", () => {
    expect(splitAddress("forum")).toBeNull();
    expect(splitAddress(".post")).toBeNull();
    expect(splitAddress("forum.")).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { withTimeout, ServerError } from "./server-session.js";

describe("withTimeout", () => {
  it("passes the value through when there is no budget", async () => {
    await expect(withTimeout(Promise.resolve(1), undefined, "x")).resolves.toBe(1);
  });

  it("passes the value through when the promise is fast enough", async () => {
    await expect(withTimeout(Promise.resolve(1), 1000, "x")).resolves.toBe(1);
  });

  it("names the step it timed out on", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 200));
    await expect(withTimeout(slow, 10, "connecting")).rejects.toThrow(
      /Timed out after 10ms connecting/,
    );
  });
});

describe("ServerError", () => {
  it("names the server and carries exit code 1", () => {
    const err = new ServerError("boom", "forum");
    expect(err.serverName).toBe("forum");
    expect(err.exitCode).toBe(1);
  });
});

import { describe, it, expect } from "vitest";
import { createServer } from "http";
import type { AddressInfo } from "net";
import { CallbackError, listenForCallback } from "./callback.js";

/** A port nothing listens on, found by binding and releasing one. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("listenForCallback", () => {
  it("accepts the matching state once, answers a page, and closes", async () => {
    const port = await freePort();
    const listener = listenForCallback({
      port,
      stateMatches: (s) => s === "good",
      timeoutMs: 5000,
    });
    const res = await fetch(
      `http://127.0.0.1:${port}/callback?code=abc123&state=good&iss=https://as/`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("close this window");
    await expect(listener.result).resolves.toEqual({ code: "abc123", iss: "https://as/" });
    await new Promise((done) => setTimeout(done, 200));
    await expect(fetch(`http://127.0.0.1:${port}/callback?code=x&state=good`)).rejects.toThrow();
  });

  it("rejects a wrong state with 400 and keeps waiting for the right one", async () => {
    const port = await freePort();
    const listener = listenForCallback({
      port,
      stateMatches: (s) => s === "good",
      timeoutMs: 5000,
    });
    const bad = await fetch(`http://127.0.0.1:${port}/callback?code=evil&state=forged`);
    expect(bad.status).toBe(400);
    const good = await fetch(`http://127.0.0.1:${port}/callback?code=fine&state=good`);
    expect(good.status).toBe(200);
    await expect(listener.result).resolves.toEqual({ code: "fine" });
  });

  it("surfaces the authorization server's error", async () => {
    const port = await freePort();
    const listener = listenForCallback({ port, stateMatches: () => true, timeoutMs: 5000 });
    await fetch(
      `http://127.0.0.1:${port}/callback?error=access_denied&error_description=user+said+no`,
    );
    await expect(listener.result).rejects.toBeInstanceOf(CallbackError);
    await expect(listener.result).rejects.toThrow(/access_denied: user said no/);
  });

  it("answers 404 off the path and 400 with no code", async () => {
    const port = await freePort();
    const listener = listenForCallback({ port, stateMatches: () => true, timeoutMs: 5000 });
    expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/callback?state=x`)).status).toBe(400);
    listener.close();
    await expect(listener.result).rejects.toThrow();
  });

  it("times out", async () => {
    const port = await freePort();
    const listener = listenForCallback({ port, stateMatches: () => true, timeoutMs: 100 });
    await expect(listener.result).rejects.toThrow(/no authorization callback arrived/);
  });

  it("reports a port in use before anything else happens", async () => {
    const port = await freePort();
    const first = listenForCallback({ port, stateMatches: () => true, timeoutMs: 5000 });
    const second = listenForCallback({ port, stateMatches: () => true, timeoutMs: 5000 });
    await expect(second.result).rejects.toThrow(/is in use; pass --callback-port/);
    first.close();
    await expect(first.result).rejects.toThrow();
  });
});

describe("listenForCallback, review fixes", () => {
  it("rejects a forged error callback whose state is wrong and keeps waiting", async () => {
    const port = await freePort();
    const listener = listenForCallback({
      port,
      stateMatches: (s) => s === "good",
      timeoutMs: 5000,
    });
    await listener.ready;
    const forged = await fetch(
      `http://127.0.0.1:${port}/callback?error=access_denied&state=forged`,
    );
    expect(forged.status).toBe(400);
    const good = await fetch(`http://127.0.0.1:${port}/callback?code=fine&state=good`);
    expect(good.status).toBe(200);
    await expect(listener.result).resolves.toEqual({ code: "fine" });
  });

  it("still surfaces a genuine error callback that carries the right state", async () => {
    const port = await freePort();
    const listener = listenForCallback({
      port,
      stateMatches: (s) => s === "good",
      timeoutMs: 5000,
    });
    await listener.ready;
    await fetch(`http://127.0.0.1:${port}/callback?error=access_denied&state=good`);
    await expect(listener.result).rejects.toBeInstanceOf(CallbackError);
  });

  it("settles ready on listen and rejects ready on a port in use", async () => {
    const port = await freePort();
    const first = listenForCallback({ port, stateMatches: () => true, timeoutMs: 5000 });
    await expect(first.ready).resolves.toBeUndefined();
    const second = listenForCallback({ port, stateMatches: () => true, timeoutMs: 5000 });
    await expect(second.ready).rejects.toThrow(/is in use/);
    first.close();
  });
});

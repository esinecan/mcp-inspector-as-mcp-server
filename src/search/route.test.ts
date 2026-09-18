import { describe, it, expect } from "vitest";
import type { ToolResult } from "../cli/server-session.js";
import type { Operation } from "../supervise/operation.js";
import type { Executed } from "../supervise/executor.js";
import { SupervisedError } from "../supervise/errors.js";
import { BlockedError } from "../cli/errors.js";
import { googleProvider } from "./google.js";
import { braveProvider } from "./brave.js";
import { fallsBack, providerFor, routedSearch, SearchFailedError, type Execute } from "./route.js";
import { rowFrom } from "./provider.js";

/** Google's real answer shapes, as `google_search` prints them. */
const GOOGLE_OK: ToolResult = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        results: [
          {
            rank: 1,
            title: "One",
            url: "https://one.example",
            host: "one.example",
            snippet: "first",
            date: "2 days ago",
          },
          {
            rank: 2,
            title: "Two",
            url: "https://two.example",
            host: "two.example",
            snippet: "second",
            date: null,
          },
        ],
        count: 2,
        total_matches: 1000,
      }),
    },
  ],
};

const GOOGLE_RATE_LIMITED: ToolResult = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        kind: "rate_limited",
        error: "Google served /sorry/ (the CAPTCHA interstitial)",
        results: [],
        count: 0,
      }),
    },
  ],
};

const GOOGLE_AUTH: ToolResult = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        kind: "auth_expired",
        error: "no live Google session",
        results: [],
        count: 0,
        detail: { login_tool: "google_initiate_login" },
      }),
    },
  ],
};

const GOOGLE_BAD: ToolResult = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        kind: "bad_argument",
        error: "unknown vertical",
        results: [],
        count: 0,
      }),
    },
  ],
};

const GOOGLE_DRIFT: ToolResult = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        kind: "schema_drift",
        error: "extractor stale",
        results: [],
        count: 0,
      }),
    },
  ],
};

/** Brave's real shape: one text block per hit, plus other kinds mixed in. */
const BRAVE_OK: ToolResult = {
  content: [
    {
      type: "text",
      text: JSON.stringify({ url: "https://b1.example", title: "B1", description: "brave one" }),
    },
    {
      type: "text",
      text: JSON.stringify({
        question: "faq?",
        answer: "yes",
        title: "FAQ",
        url: "https://faq.example",
      }),
    },
    {
      type: "text",
      text: JSON.stringify({
        url: "https://news.example",
        title: "News",
        description: "n",
        age: "1 hour ago",
      }),
    },
    { type: "text", text: "Summarizer key: abc" },
  ],
  isError: false,
};

const BRAVE_EMPTY: ToolResult = {
  content: [{ type: "text", text: "No web results found" }],
  isError: true,
};

const google = googleProvider("google-search");
const brave = braveProvider("brave-search");

function executed(
  value: ToolResult,
  failure?: { class: string; message: string },
): Executed<ToolResult> {
  const out: Executed<ToolResult> = {
    value,
    trace: "t_x",
    attempts: 1,
    elapsedMs: 5,
    lane: "scripted",
  };
  if (failure !== undefined) out.failure = failure as Executed<ToolResult>["failure"];
  return out;
}

/** An execute that answers per server, and records what it was asked. */
function fake(
  answers: Record<string, ToolResult | Error>,
): Execute & { asked: Array<[string, Operation]> } {
  const asked: Array<[string, Operation]> = [];
  const execute = (async (server: string, op: Operation) => {
    asked.push([server, op]);
    const answer = answers[server];
    if (answer instanceof Error) throw answer;
    if (answer === undefined) throw new Error("no answer scripted");
    return executed(answer);
  }) as Execute & { asked: Array<[string, Operation]> };
  execute.asked = asked;
  return execute;
}

const supervised = (klass: string, reason?: string) =>
  new SupervisedError({
    class: klass as "transient",
    ...(reason !== undefined ? { reason: reason as "circuit_open" } : {}),
    message: `${klass} happened`,
    server: "google-search",
    operation: "callTool",
    attempts: 1,
    trace: "t_g",
    elapsedMs: 3,
  });

describe("the providers", () => {
  it("parses Google's rows and keeps the date only where Google gave one", () => {
    const rows = google.parse(GOOGLE_OK, { query: "q", limit: 10 });
    expect(rows).toEqual([
      { title: "One", url: "https://one.example", snippet: "first", date: "2 days ago" },
      { title: "Two", url: "https://two.example", snippet: "second" },
    ]);
    expect(google.parse(GOOGLE_OK, { query: "q", limit: 1 })).toHaveLength(1);
    expect(google.operation({ query: "q", limit: 5 })).toEqual({
      kind: "callTool",
      name: "google_search",
      args: { query: "q" },
    });
  });

  it("raises Google's failure envelopes with their class", () => {
    expect(() => google.parse(GOOGLE_RATE_LIMITED, { query: "q", limit: 10 })).toThrow(/sorry/);
    expect(() =>
      google.parse({ content: [{ type: "text", text: "not json" }] }, { query: "q", limit: 10 }),
    ).toThrow(/no JSON object/);
    expect(() =>
      google.parse({ content: [{ type: "text", text: "{}" }] }, { query: "q", limit: 10 }),
    ).toThrow(/"results" array/);
    expect(() =>
      google.parse(
        { content: [{ type: "text", text: JSON.stringify({ results: [{ rank: 1 }] }) }] },
        { query: "q", limit: 10 },
      ),
    ).toThrow(/no url and title/);
  });

  it("parses Brave's per-hit blocks, skips blocks without a url and title, and treats no results as empty", () => {
    const rows = brave.parse(BRAVE_OK, { query: "q", limit: 10 });
    expect(rows).toEqual([
      { title: "B1", url: "https://b1.example", snippet: "brave one" },
      { title: "FAQ", url: "https://faq.example", snippet: "" },
      { title: "News", url: "https://news.example", snippet: "n", date: "1 hour ago" },
    ]);
    expect(brave.parse(BRAVE_EMPTY, { query: "q", limit: 10 })).toEqual([]);
    expect(brave.operation({ query: "q", limit: 50 })).toEqual({
      kind: "callTool",
      name: "brave_web_search",
      args: { query: "q", count: 20 },
    });
    expect(() =>
      brave.parse({ content: [{ type: "text", text: "{}" }] }, { query: "q", limit: 10 }),
    ).toThrow(/no entry with a url/);
    expect(() =>
      brave.parse(
        { isError: true, content: [{ type: "text", text: "HTTP 401 invalid api key" }] },
        { query: "q", limit: 10 },
      ),
    ).toThrow(/api key/);
  });

  it("chooses the implementation by server name", () => {
    expect(providerFor("brave-search").server).toBe("brave-search");
    expect(providerFor("BRAVE").operation({ query: "q", limit: 1 })).toMatchObject({
      name: "brave_web_search",
    });
    expect(providerFor("google-search").operation({ query: "q", limit: 1 })).toMatchObject({
      name: "google_search",
    });
    expect(providerFor("anything-else").operation({ query: "q", limit: 1 })).toMatchObject({
      name: "google_search",
    });
  });

  it("reads a row from loosely named fields", () => {
    expect(rowFrom({ link: "u", name: "n", text: "t", published: "p" })).toEqual({
      title: "n",
      url: "u",
      snippet: "t",
      date: "p",
    });
    expect(rowFrom({ url: "u" })).toBeUndefined();
    expect(rowFrom("x")).toBeUndefined();
  });
});

describe("the route", () => {
  const q = { query: "berlin wohnung", limit: 10 };

  it("answers from Google when Google answers", async () => {
    const execute = fake({ "google-search": GOOGLE_OK });
    const out = await routedSearch(q, { primary: google, fallback: brave }, execute);
    expect(out).toMatchObject({ provider: "google-search", degraded: false, query: q.query });
    expect(out.rows).toHaveLength(2);
    expect(out.attempts).toEqual([
      expect.objectContaining({ provider: "google-search", ok: true, rows: 2, trace: "t_x" }),
    ]);
    expect(out.diagnostics).toEqual({ primary: "google-search", fallback: "brave-search" });
    expect(execute.asked.map(([s]) => s)).toEqual(["google-search"]);
  });

  it.each([
    ["rate_limited", GOOGLE_RATE_LIMITED],
    ["auth_required", GOOGLE_AUTH],
    ["structural", GOOGLE_DRIFT],
  ])("falls back to Brave on Google's %s envelope and says so", async (klass, envelope) => {
    const execute = fake({ "google-search": envelope, "brave-search": BRAVE_OK });
    const out = await routedSearch(q, { primary: google, fallback: brave }, execute);
    expect(out).toMatchObject({ provider: "brave-search", degraded: true });
    expect(out.rows[0].url).toBe("https://b1.example");
    expect(out.attempts[0]).toMatchObject({ provider: "google-search", ok: false, class: klass });
    expect(out.attempts[1]).toMatchObject({ provider: "brave-search", ok: true, rows: 3 });
    expect(out.diagnostics.fellBackBecause).toContain(klass);
    expect(execute.asked.map(([s]) => s)).toEqual(["google-search", "brave-search"]);
  });

  it("falls back when the supervisor refused Google or exhausted its attempts", async () => {
    for (const err of [
      supervised("blocked", "circuit_open"),
      supervised("transient"),
      supervised("timeout"),
    ]) {
      const execute = fake({ "google-search": err, "brave-search": BRAVE_OK });
      const out = await routedSearch(q, { primary: google, fallback: brave }, execute);
      expect(out.degraded).toBe(true);
      expect(out.attempts[0]).toMatchObject({ ok: false, class: err.report.class, trace: "t_g" });
      if (err.report.reason) expect(out.attempts[0].reason).toBe(err.report.reason);
    }
  });

  it("falls back when the profile blocks the primary", async () => {
    const execute = fake({
      "google-search": new BlockedError("blocked by profile"),
      "brave-search": BRAVE_OK,
    });
    const out = await routedSearch(q, { primary: google, fallback: brave }, execute);
    expect(out.attempts[0]).toMatchObject({ class: "blocked", reason: "profile" });
    expect(out.provider).toBe("brave-search");
  });

  it("never falls back on a bad argument, because the query is the fault", async () => {
    const execute = fake({ "google-search": GOOGLE_BAD, "brave-search": BRAVE_OK });
    const err = await routedSearch(q, { primary: google, fallback: brave }, execute).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(SearchFailedError);
    expect(err.message).toMatch(/not sent to the fallback/);
    expect(err.outcome.attempts).toHaveLength(1);
    expect(execute.asked.map(([s]) => s)).toEqual(["google-search"]);
    expect(fallsBack({ class: "bad_argument", message: "" })).toBe(false);
    expect(fallsBack({ class: "structural", message: "" })).toBe(true);
  });

  it("reports both failures when both providers fail, with every attempt in the envelope", async () => {
    const execute = fake({
      "google-search": GOOGLE_RATE_LIMITED,
      "brave-search": {
        isError: true,
        content: [{ type: "text", text: "HTTP 429 quota exceeded" }],
      },
    });
    const err = (await routedSearch(q, { primary: google, fallback: brave }, execute).catch(
      (e) => e,
    )) as SearchFailedError;
    expect(err).toBeInstanceOf(SearchFailedError);
    expect(err.exitCode).toBe(1);
    expect(err.message).toMatch(/both providers failed/);
    const envelope = err.envelope();
    expect(envelope.ok).toBe(false);
    expect(envelope.error.class).toBe("rate_limited");
    expect(envelope.error.attempts.map((a) => a.provider)).toEqual([
      "google-search",
      "brave-search",
    ]);
    expect(envelope.search.provider).toBeNull();
  });

  it("fails without a fallback when the primary fails", async () => {
    const execute = fake({ "google-search": GOOGLE_RATE_LIMITED });
    const err = (await routedSearch(q, { primary: google }, execute).catch(
      (e) => e,
    )) as SearchFailedError;
    expect(err).toBeInstanceOf(SearchFailedError);
    expect(err.message).not.toMatch(/fallback/);
    expect(err.outcome.diagnostics.fallback).toBeUndefined();
  });

  it("classifies an unexpected throw from the executor", async () => {
    const execute = fake({ "google-search": new Error("ECONNRESET"), "brave-search": BRAVE_EMPTY });
    const out = await routedSearch(q, { primary: google, fallback: brave }, execute);
    expect(out.attempts[0].class).toBe("transient");
    expect(out.rows).toEqual([]);
    expect(out.provider).toBe("brave-search");
  });
});

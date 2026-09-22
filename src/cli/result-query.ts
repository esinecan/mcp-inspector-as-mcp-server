import { createHash } from "crypto";
import { UsageError } from "./errors.js";
import type { SpillStore } from "./spill.js";
import { readSource, type ResultSource } from "./result-source.js";
import { pointerToken, spillHint } from "./spill-hints.js";

const VERSION = 1;
export const DEFAULT_QUERY_BYTES = 4096;
export interface QueryRequest {
  ref: string;
  select?: string[];
  within?: string;
  query?: string;
  cursor?: string;
  maxBytes?: number;
}
type Item = Record<string, unknown>;
export interface QueryEnvelope {
  schemaVersion: 2;
  ok: boolean;
  isError: boolean;
  source: { ref: string; representation: string; legacy: boolean };
  next: { command: string; argv: string[] };
  result: {
    kind: "selection" | "excerpts" | "outline";
    items: Item[];
    search?: "matched" | "no_match";
    /** How many items the whole answer holds, before paging. */
    total: number;
    more: boolean;
    cursor?: string;
  };
}
export const serializedBytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v, null, 2) + "\n");
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];

/**
 * The RFC 6901 form of a pointer a caller typed.
 *
 * Three spellings name one field: `/record/body`, the URI-fragment form
 * `#/record/body`, and `record/body` with no leading slash. The last exists
 * because Git Bash (MSYS) rewrites an argument that starts with `/`, or with
 * `#/`, as a Windows path before the CLI sees it, so `/record/body` arrives
 * as `C:/Program Files/Git/record/body`. The empty string stays the root.
 */
export function canonicalPointer(path: string): string {
  const bare = path.startsWith("#") ? path.slice(1) : path;
  if (/^[A-Za-z]:[\\/]/.test(bare)) {
    // What MSYS made of `/record/body`: a drive path the caller never typed.
    throw new UsageError(
      `Pointer "${path}" is a Windows path, so the shell rewrote it. ` +
        "Under Git Bash write the pointer without its leading slash, for example record/body",
    );
  }
  if (bare === "" || bare.startsWith("/")) return bare;
  return `/${bare}`;
}

function pointer(root: unknown, rawPath: string): { found: boolean; value?: unknown } {
  const path = canonicalPointer(rawPath);
  if (path === "") return { found: true, value: root };
  if (/~(?![01])/u.test(path)) throw new UsageError("Invalid JSON Pointer");
  let value = root;
  for (const encoded of path.slice(1).split("/")) {
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (
      value === null ||
      typeof value !== "object" ||
      !Object.hasOwn(value, key) ||
      (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key))
    )
      return { found: false };
    value = (value as Record<string, unknown>)[key];
  }
  return { found: true, value };
}

interface Passage {
  path: string;
  heading: string;
  start: number;
  end: number;
  text: string;
  block?: number;
}
const wordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/**
 * Move a window's edges off the inside of a word.
 *
 * `lo` and `hi` bound the text the window may cover (a line, or a passage).
 * An edge that already sits on that bound stays. Otherwise the start moves
 * forward to the next word boundary and the end moves back to the previous
 * one, each by at most `slack` code units, so an excerpt never opens or closes
 * with a fragment of a word. A window that is all one word keeps its edges.
 */
function snap(
  text: string,
  start: number,
  end: number,
  lo: number,
  hi: number,
  slack = 160,
): [number, number] {
  let s = start;
  let e = end;
  if (s > lo && wordChar(text[s - 1]) && wordChar(text[s])) {
    const limit = Math.min(e, s + slack);
    let i = s;
    while (i < limit && wordChar(text[i])) i++;
    if (i < limit) s = i;
  }
  if (e < hi && wordChar(text[e - 1]) && wordChar(text[e])) {
    const limit = Math.max(s, e - slack);
    let i = e;
    while (i > limit && wordChar(text[i - 1])) i--;
    if (i > limit) e = i;
  }
  return [s, e];
}

/** Positions are UTF-16 code units in a decoded string, never serialized JSON offsets. */
function* segment(text: string, path: string, block?: number): Generator<Passage> {
  let heading = "";
  const lines = /[^\n]*(?:\n|$)/g;
  for (const match of text.matchAll(lines)) {
    const line = match[0];
    if (!line.trim()) continue;
    if (/^\s*#{1,6}\s/.test(line)) heading = line.trim();
    const lineEnd = match.index + line.length;
    // Overlap protects words/phrases across a long-line split.
    for (let n = 0; n < line.length; n += 640) {
      let start = match.index + n;
      let end = Math.min(lineEnd, start + 800);
      if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start--;
      if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--;
      [start, end] = snap(text, start, end, match.index, lineEnd);
      yield {
        path,
        heading,
        start,
        end,
        text: text.slice(start, end),
        ...(block !== undefined ? { block } : {}),
      };
      if (end >= match.index + line.length) break;
    }
  }
}

function* passages(value: unknown, path: string, block?: number): Generator<Passage> {
  if (typeof value === "string") yield* segment(value, path, block);
  else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value))
      yield* passages(child, `${path}/${pointerToken(key)}`, block);
  }
}

function* sourcePassages(source: ResultSource, within: string): Generator<Passage> {
  const selected = pointer(source.value, within);
  if (!selected.found) throw new UsageError("Search scope does not exist");
  if (source.kind !== "blocks") {
    yield* passages(selected.value, within);
    return;
  }
  // Only text blocks are searchable. Their original block indexes survive selection.
  for (const [i, raw] of (source.value as unknown[]).entries()) {
    const b = raw as { type?: string; text?: string };
    const path = `/${i}/text`;
    if (
      b.type === "text" &&
      typeof b.text === "string" &&
      (within === "" || path === within || path.startsWith(`${within}/`))
    )
      yield* segment(b.text, path, i);
  }
}

function* outline(value: unknown, path: string, depth = 0): Generator<Item> {
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  yield {
    path,
    type,
    ...(typeof value === "string"
      ? { bytes: Buffer.byteLength(value) }
      : value !== null && typeof value === "object"
        ? { count: Object.keys(value).length }
        : {}),
  };
  if (typeof value === "string") {
    for (const m of value.matchAll(/^#{1,6}\s+.+$/gm))
      yield { path, heading: m[0].slice(0, 160), start: m.index };
  } else if (value !== null && typeof value === "object" && depth < 3) {
    // Arrays are summarized once; rows remain addressable with exact pointers.
    if (Array.isArray(value)) {
      if (value.length) yield* outline(value[0], `${path}/0`, depth + 1);
    } else
      for (const [key, child] of Object.entries(value))
        yield* outline(child, `${path}/${pointerToken(key)}`, depth + 1);
  }
}

function validate(raw: unknown): QueryRequest {
  if (!raw || typeof raw !== "object") throw new UsageError("query requires an object");
  const r = raw as QueryRequest;
  if (typeof r.ref !== "string") throw new UsageError("query requires ref");
  for (const k of ["within", "query", "cursor"] as const)
    if (r[k] !== undefined && typeof r[k] !== "string")
      throw new UsageError(`${k} must be a string`);
  if (
    r.select !== undefined &&
    (!Array.isArray(r.select) ||
      r.select.length > 128 ||
      r.select.some((p) => typeof p !== "string"))
  )
    throw new UsageError("select must contain at most 128 JSON Pointers");
  if (r.query !== undefined && !r.query.trim())
    throw new UsageError("query must not be empty; omit it for an outline");
  // Every later comparison and hint works on the one canonical spelling.
  if (r.within !== undefined) r.within = canonicalPointer(r.within);
  if (r.select !== undefined) r.select = r.select.map(canonicalPointer);
  if (
    r.maxBytes !== undefined &&
    (!Number.isSafeInteger(r.maxBytes) || r.maxBytes < 1024 || r.maxBytes > 1048576)
  )
    throw new UsageError("maxBytes must be 1024..1048576");
  return r;
}

/** Local-only query interface. Output owns its complete serialized byte budget. */
export function queryResult(
  store: SpillStore,
  raw: unknown,
  extra: Record<string, unknown> = {},
): QueryEnvelope {
  const req = validate(raw);
  const source = readSource(store, req.ref);
  const budget = req.maxBytes ?? DEFAULT_QUERY_BYTES;
  const signature = hash([
    VERSION,
    source.ref,
    req.select ?? [],
    req.within ?? "",
    req.query ?? "",
  ]);
  let offset = 0;
  if (req.cursor !== undefined) {
    try {
      const c = JSON.parse(Buffer.from(req.cursor, "base64url").toString());
      if (c.signature !== signature || !Number.isSafeInteger(c.offset) || c.offset < 0)
        throw Error();
      offset = c.offset;
    } catch {
      throw new UsageError("Invalid cursor for this source/query/version");
    }
  }
  const cursor = (n: number) =>
    Buffer.from(JSON.stringify({ signature, offset: n })).toString("base64url");
  const selections: Item[] = (req.select ?? []).map((path) => {
    const found = pointer(source.value, path);
    if (!found.found) return { path, status: "missing" };
    const item = { path, status: "complete", value: found.value };
    return serializedBytes(item) <= Math.max(128, budget / 3)
      ? item
      : {
          path,
          status: "deferred",
          ref: source.ref,
          bytes: serializedBytes(found.value),
          next: spillHint(source.ref, path).argv,
        };
  });
  let search: "matched" | "no_match" | undefined;
  let tail: Iterable<Item>;
  if (req.query !== undefined) {
    const terms = [...new Set(words(req.query))];
    if (!terms.length) throw new UsageError("query needs a word or number");
    const ranked = [...sourcePassages(source, req.within ?? "")].map((p) => {
      const tokens = words(p.text);
      const counts = new Map<string, number>();
      for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
      return { p, tokens, counts };
    });
    const frequencies = terms.map((t) => ranked.filter((p) => p.counts.has(t)).length);
    const average = ranked.reduce((n, p) => n + p.tokens.length, 0) / (ranked.length || 1) || 1;
    const hits = ranked
      .map(({ p, tokens, counts }) => {
        const score = terms.reduce((sum, t, i) => {
          const tf = counts.get(t) ?? 0;
          const idf = Math.log(1 + (ranked.length - frequencies[i] + 0.5) / (frequencies[i] + 0.5));
          return (
            sum +
            (tf ? (idf * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * tokens.length) / average)) : 0)
          );
        }, 0);
        const boost = terms.filter((t) => words(p.heading + " " + p.path).includes(t)).length * 0.1;
        return { p, score: score ? score + boost : 0 };
      })
      .filter((h) => h.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          (a.p.path < b.p.path ? -1 : a.p.path > b.p.path ? 1 : a.p.start - b.p.start),
      );
    search = hits.length ? "matched" : "no_match";
    tail = hits.map(({ p }) => ({ ...p, coordinates: "decoded_utf16", ref: source.ref }));
  } else if (selections.length) tail = [];
  else {
    const scope = pointer(source.value, req.within ?? "");
    if (!scope.found) throw new UsageError("Outline scope does not exist");
    tail = outline(scope.value, req.within ?? "");
  }
  // The whole answer is known before paging, so its size is reported with
  // every page: a caller reading `more: true` also learns how much is left.
  const all: Item[] = [...selections, ...tail];
  const out: QueryEnvelope = {
    schemaVersion: 2,
    ok: !source.isError,
    isError: source.isError,
    ...extra,
    next: { command: "mcp-cli", argv: spillHint(source.ref, req.within).argv },
    source: { ref: source.ref, representation: source.kind, legacy: source.legacy },
    result: {
      kind: req.query !== undefined ? "excerpts" : selections.length ? "selection" : "outline",
      items: [],
      ...(search ? { search } : {}),
      total: all.length,
      more: true,
      cursor: cursor(offset + 1),
    },
  };
  let index = 0;
  for (const original of all) {
    if (index++ < offset) continue;
    let item = original;
    out.result.items.push(item);
    out.result.cursor = cursor(index);
    if (
      serializedBytes(out) > budget &&
      out.result.items.length === 1 &&
      typeof item.text === "string"
    ) {
      // Fit around the first matching term, not around an unrelated paragraph head.
      const text = item.text;
      const first = Math.min(
        ...words(req.query ?? "")
          .map((t) => text.toLowerCase().indexOf(t))
          .filter((n) => n >= 0),
      );
      const center = Number.isFinite(first) ? first : 0;
      let width = text.length;
      while (serializedBytes(out) > budget && width > 8) {
        width = Math.floor(width * 0.7);
        let start = Math.max(0, center - Math.floor(width / 3));
        let end = Math.min(text.length, start + width);
        if (/[\uDC00-\uDFFF]/.test(text[start])) start--;
        if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--;
        [start, end] = snap(text, start, end, 0, text.length, Math.floor(width / 4));
        item = {
          ...original,
          start: Number(original.start) + start,
          end: Number(original.start) + end,
          text: text.slice(start, end),
          windowed: true,
        };
        out.result.items[0] = item;
      }
    }
    if (serializedBytes(out) > budget) {
      out.result.items.pop();
      if (!out.result.items.length)
        throw new UsageError("Budget cannot fit this item metadata; increase maxBytes");
      out.result.cursor = cursor(index - 1);
      return out;
    }
  }
  if (offset > index) throw new UsageError("Cursor offset is outside this result");
  out.result.more = false;
  delete out.result.cursor;
  if (serializedBytes(out) > budget) throw new UsageError("Budget cannot fit response metadata");
  return out;
}

export function sourceEnvelope(
  store: SpillStore,
  ref: string,
  extra: Record<string, unknown> = {},
  maxBytes = DEFAULT_QUERY_BYTES,
): unknown {
  validate({ ref, maxBytes });
  const source = readSource(store, ref);
  const out = {
    schemaVersion: 2,
    ok: !source.isError,
    isError: source.isError,
    ...extra,
    source: { ref, representation: source.kind, legacy: source.legacy },
    result: { kind: source.kind, value: source.value, completeness: "complete" },
  };
  if (serializedBytes(out) <= maxBytes) return out;
  return queryResult(store, { ref, maxBytes }, extra);
}

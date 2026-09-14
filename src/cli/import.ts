/**
 * Build an mcp-cli config from the Claude Code config at `~/.claude.json`.
 *
 * The two dialects share the `mcpServers` key and differ only in noise, so the
 * import copies each entry and drops the fields mcp-cli does not read. The
 * inspector's own entry is skipped: mcp-cli lives in that repo and pointing it
 * at itself has no use.
 */

import { readFileSync, existsSync } from "fs";
import type { CliConfig, ServerEntry } from "./config.js";

/** One entry as Claude Code writes it. */
interface ClaudeEntry {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

export interface ImportResult {
  servers: Record<string, ServerEntry>;
  skipped: string[];
}

/** True when an entry launches this repo's inspector server. */
export function isInspectorEntry(name: string, entry: ClaudeEntry): boolean {
  if (name === "mcp-inspector") return true;
  const text = [entry.command ?? "", ...(entry.args ?? [])].join(" ").replace(/\\/g, "/");
  return text.includes("mcp-inspector-as-mcp-server");
}

/** Convert a Claude Code `mcpServers` map into mcp-cli server entries. */
export function convertServers(claude: Record<string, ClaudeEntry>): ImportResult {
  const servers: Record<string, ServerEntry> = {};
  const skipped: string[] = [];

  for (const [name, entry] of Object.entries(claude)) {
    if (isInspectorEntry(name, entry)) {
      skipped.push(name);
      continue;
    }
    if (name.includes(".")) {
      skipped.push(name);
      continue;
    }
    if (!entry.command && !entry.url) {
      skipped.push(name);
      continue;
    }

    const out: ServerEntry = {};
    if (entry.url) {
      out.url = entry.url;
      if (entry.headers && Object.keys(entry.headers).length > 0) out.headers = entry.headers;
      if (entry.type === "sse") out.transport = "sse";
      if (entry.type === "http") out.transport = "http";
    } else {
      out.command = entry.command;
      if (entry.args && entry.args.length > 0) out.args = entry.args;
      if (entry.env && Object.keys(entry.env).length > 0) out.env = entry.env;
      if (entry.cwd) out.cwd = entry.cwd;
    }
    servers[name] = out;
  }

  return { servers, skipped };
}

/** Read `~/.claude.json` and return its `mcpServers` map. */
export function readClaudeServers(path: string): Record<string, ClaudeEntry> {
  if (!existsSync(path)) {
    throw new Error(`No Claude Code config at ${path}`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, ClaudeEntry> };
  return raw.mcpServers ?? {};
}

/**
 * Merge imported servers into an existing config, keeping its profiles. The
 * server list is replaced rather than merged, so a server removed from Claude
 * Code disappears here too.
 */
export function mergeIntoConfig(existing: CliConfig | undefined, servers: Record<string, ServerEntry>): CliConfig {
  return {
    mcpServers: servers,
    profiles: existing?.profiles && Object.keys(existing.profiles).length > 0
      ? existing.profiles
      : { default: { block: [] } },
  };
}

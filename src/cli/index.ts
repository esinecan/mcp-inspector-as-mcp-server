#!/usr/bin/env node

/**
 * mcp-cli — a non-interactive MCP client for agents and shells.
 *
 * The name is `mcp-cli` rather than `mcp` because the Python SDK already owns
 * `mcp` on PATH. Every call connects, acts and disconnects, so a server edited
 * between two calls shows its new tools on the second one.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { dirname } from "path";
import { homedir } from "os";
import { join } from "path";
import type { Client } from "@modelcontextprotocol/client";

import { parseArgs, UnknownServerError, UsageError, type ParsedArgs } from "./args.js";
import {
  ConfigError,
  configPath,
  loadConfig,
  parseConfig,
  profileName,
  resolveProfile,
  blockedBy,
  DEFAULT_CONFIG_PATH,
  type CliConfig,
  type ResolvedProfile,
} from "./config.js";
import { Connector, ServerError, transportOf, CLIENT_VERSION } from "./connection.js";
import { resolveAddress, splitAddress } from "./match.js";
import { ArgumentError, parseArguments, readArgumentText, readStdinSync } from "./input.js";
import { convertServers, mergeIntoConfig, readClaudeServers } from "./import.js";

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;
const EXIT_BLOCKED = 3;

const HELP = `mcp-cli ${CLIENT_VERSION} — call MCP servers from the shell.

Usage:
  mcp-cli servers                          list configured servers
  mcp-cli tools [server] [--all]           list tools as server.tool
  mcp-cli call <server.tool> [args]        call a tool
  mcp-cli info <server>                    serverInfo, protocol version, era
  mcp-cli resources <server>               list resources
  mcp-cli read <server> <uri>              read one resource
  mcp-cli prompts <server>                 list prompts
  mcp-cli prompt <server.name> [args]      get one prompt
  mcp-cli import-claude                    build the config from ~/.claude.json

Arguments for call and prompt are JSON, given as inline text, as "-" to read
stdin, or as "@path" to read a file.

Global flags:
  --config <path>   config file (default ${DEFAULT_CONFIG_PATH}, env MCP_CLI_CONFIG)
  --profile <name>  blocklist profile (env MCP_CLI_PROFILE, default "default")
  --json            one JSON object on stdout instead of text
  --timeout <ms>    budget for connecting and for each request
  --all             with "tools", also show blocked tools, marked
  --help, --version

Exit codes: 0 success, 1 failure, 2 usage error, 3 tool blocked by the profile.`;

async function main(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    return fail(err as Error, EXIT_USAGE);
  }

  if (args.version) {
    process.stdout.write(`${CLIENT_VERSION}\n`);
    return EXIT_OK;
  }
  if (args.help || args.command === undefined || args.command === "help") {
    process.stdout.write(`${HELP}\n`);
    return EXIT_OK;
  }

  try {
    switch (args.command) {
      case "import-claude":
        return cmdImportClaude(args);
      case "servers":
        return cmdServers(args);
      case "tools":
        return await cmdTools(args);
      case "call":
        return await cmdCall(args);
      case "info":
        return await cmdInfo(args);
      case "resources":
        return await cmdResources(args);
      case "read":
        return await cmdRead(args);
      case "prompts":
        return await cmdPrompts(args);
      case "prompt":
        return await cmdPrompt(args);
      default:
        throw new UsageError(`Unknown command "${args.command}". Run mcp-cli --help.`);
    }
  } catch (err) {
    if (err instanceof UsageError) return fail(err, EXIT_USAGE);
    if (err instanceof ConfigError) return fail(err, EXIT_USAGE);
    if (err instanceof ArgumentError) return fail(err, EXIT_USAGE);
    if (err instanceof BlockedError) return fail(err, EXIT_BLOCKED);
    return fail(err as Error, EXIT_FAILURE);
  }
}

class BlockedError extends Error {}

function fail(err: Error, code: number): number {
  process.stderr.write(`mcp-cli: ${err.message}\n`);
  return code;
}

/** Everything a server-touching command needs. */
interface Context {
  config: CliConfig;
  profile: ResolvedProfile;
  connector: Connector;
  json: boolean;
}

function context(args: ParsedArgs): Context {
  const path = configPath(args.config);
  const config = loadConfig(path);
  const profile = resolveProfile(config, profileName(args.profile));
  return {
    config,
    profile,
    connector: new Connector(config, { timeoutMs: args.timeoutMs }),
    json: args.json,
  };
}

function emit(json: boolean, value: unknown, text: () => string): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } else {
    const rendered = text();
    process.stdout.write(rendered.endsWith("\n") || rendered === "" ? rendered : `${rendered}\n`);
  }
}

/* -------------------------------------------------------------- servers -- */

function cmdServers(args: ParsedArgs): number {
  const ctx = context(args);
  const rows = Object.entries(ctx.config.mcpServers).map(([name, entry]) => ({
    name,
    transport: transportOf(entry),
    target: entry.url ?? [entry.command, ...(entry.args ?? [])].join(" "),
  }));
  rows.sort((a, b) => a.name.localeCompare(b.name));

  emit(ctx.json, { profile: ctx.profile.name, servers: rows }, () => {
    if (rows.length === 0) return "(no servers configured)";
    const width = Math.max(...rows.map((r) => r.name.length));
    return rows
      .map((r) => `${r.name.padEnd(width)}  ${r.transport.padEnd(5)}  ${r.target}`)
      .join("\n");
  });
  return EXIT_OK;
}

/* ---------------------------------------------------------------- tools -- */

interface ToolRow {
  address: string;
  server: string;
  name: string;
  description?: string;
  blockedBy?: string;
}

async function listServerTools(ctx: Context, serverName: string): Promise<ToolRow[]> {
  return ctx.connector.with(serverName, async (client) => {
    const result = await client.listTools(undefined, ctx.connector.requestOptions);
    return result.tools.map((tool) => {
      const address = `${serverName}.${tool.name}`;
      const pattern = blockedBy(address, ctx.profile);
      const row: ToolRow = {
        address,
        server: serverName,
        name: tool.name,
        description: tool.description,
      };
      if (pattern) row.blockedBy = pattern;
      return row;
    });
  });
}

async function cmdTools(args: ParsedArgs): Promise<number> {
  const ctx = context(args);
  const target = args.positionals[0];
  const names = target ? [target] : Object.keys(ctx.config.mcpServers).sort();
  if (target) ctx.connector.entry(target); // fail early on an unknown name

  const rows: ToolRow[] = [];
  const errors: Array<{ server: string; error: string }> = [];

  for (const name of names) {
    try {
      rows.push(...(await listServerTools(ctx, name)));
    } catch (err) {
      // One unreachable server must not sink a whole-fleet listing.
      errors.push({ server: name, error: oneLine((err as Error).message) });
    }
  }

  const visible = args.all ? rows : rows.filter((r) => !r.blockedBy);

  emit(ctx.json, { profile: ctx.profile.name, tools: visible, errors }, () => {
    const lines: string[] = [];
    if (visible.length === 0) lines.push("(no tools)");
    const width = Math.min(48, Math.max(0, ...visible.map((r) => r.address.length)));
    for (const row of visible) {
      const mark = row.blockedBy
        ? ` [blocked by profile ${ctx.profile.name}: ${row.blockedBy}]`
        : "";
      const desc = row.description ? `  ${firstLine(row.description)}` : "";
      lines.push(`${row.address.padEnd(width)}${desc}${mark}`);
    }
    for (const e of errors) {
      lines.push(`! ${e.server}: ${e.error}`);
    }
    return lines.join("\n");
  });

  // A per-server failure is reported but does not fail the run, unless the
  // caller asked for exactly that one server.
  return errors.length > 0 && names.length === 1 ? EXIT_FAILURE : EXIT_OK;
}

/* ----------------------------------------------------------------- call -- */

async function cmdCall(args: ParsedArgs): Promise<number> {
  const ctx = context(args);
  const query = args.positionals[0];
  if (!query) throw new UsageError("call needs a server.tool address");

  const split = splitAddress(query);
  if (!split) throw new UsageError(`"${query}" is not a server.tool address`);

  // Read the arguments before connecting, so a bad payload costs no process.
  const rawArgs = parseArguments(readArgumentText(args.positionals[1], readStdinSync));

  const serverName = resolveServerName(ctx, split.server);
  const rows = await listServerTools(ctx, serverName);
  const address = pickAddress(ctx, `${serverName}.${split.tool}`, rows);

  const toolName = address.slice(serverName.length + 1);
  const result = await ctx.connector.with(serverName, (client) =>
    client.callTool({ name: toolName, arguments: rawArgs }, ctx.connector.requestOptions),
  );

  const isError = (result as { isError?: boolean }).isError === true;
  emit(ctx.json, result, () => renderContent(result));
  return isError ? EXIT_FAILURE : EXIT_OK;
}

/** Resolve a possibly-fuzzy server name against the config. */
function resolveServerName(ctx: Context, query: string): string {
  const names = Object.keys(ctx.config.mcpServers);
  if (names.includes(query)) return query;
  const hits = names.filter((n) => n.toLowerCase() === query.toLowerCase());
  if (hits.length === 1) return hits[0];
  throw new UnknownServerError(
    `Unknown server "${query}". Configured servers: ${names.sort().join(", ") || "(none)"}`,
  );
}

/** Exact, then fuzzy, then the blocklist check. */
function pickAddress(ctx: Context, query: string, rows: ToolRow[]): string {
  const match = resolveAddress(
    query,
    rows.map((r) => r.address),
  );
  if (match.kind === "none") {
    throw new ServerError(
      `No tool matches "${query}". Run: mcp-cli tools ${query.split(".")[0]}`,
      query,
    );
  }
  if (match.kind === "ambiguous") {
    throw new ServerError(
      `"${query}" is ambiguous. Candidates: ${match.candidates.join(", ")}`,
      query,
    );
  }
  if (match.kind === "fuzzy") {
    process.stderr.write(`mcp-cli: "${query}" resolved to ${match.address}\n`);
  }

  const pattern = blockedBy(match.address, ctx.profile);
  if (pattern) {
    throw new BlockedError(
      `${match.address} is blocked by profile "${ctx.profile.name}" (pattern "${pattern}")`,
    );
  }
  return match.address;
}

/* ----------------------------------------------------------------- info -- */

async function cmdInfo(args: ParsedArgs): Promise<number> {
  const ctx = context(args);
  const target = args.positionals[0];
  if (!target) throw new UsageError("info needs a server name");
  const serverName = resolveServerName(ctx, target);

  const payload = await ctx.connector.with(serverName, async (client, info) => {
    const capabilities = client.getServerCapabilities();
    return {
      server: serverName,
      transport: info.transport,
      serverInfo: info.serverInfo ?? null,
      protocolVersion: info.protocolVersion ?? null,
      era: info.era ?? null,
      capabilities: capabilities ?? null,
    };
  });

  emit(ctx.json, payload, () =>
    [
      `server           ${payload.server}`,
      `transport        ${payload.transport}`,
      `serverInfo       ${payload.serverInfo ? `${payload.serverInfo.name ?? "?"} ${payload.serverInfo.version ?? ""}`.trim() : "(none)"}`,
      `protocolVersion  ${payload.protocolVersion ?? "(unknown)"}`,
      `era              ${payload.era ?? "(unknown)"}`,
      `capabilities     ${payload.capabilities ? Object.keys(payload.capabilities).sort().join(", ") : "(none)"}`,
    ].join("\n"),
  );
  return EXIT_OK;
}

/* ------------------------------------------------- resources and prompts -- */

async function cmdResources(args: ParsedArgs): Promise<number> {
  const ctx = context(args);
  const target = args.positionals[0];
  if (!target) throw new UsageError("resources needs a server name");
  const serverName = resolveServerName(ctx, target);

  const resources = await ctx.connector.with(serverName, async (client: Client) => {
    if (!client.getServerCapabilities()?.resources) return null;
    const result = await client.listResources(undefined, ctx.connector.requestOptions);
    return result.resources;
  });

  if (resources === null) {
    process.stderr.write(`mcp-cli: ${serverName} advertises no resources capability
`);
  }

  emit(ctx.json, { server: serverName, resources: resources ?? [] }, () =>
    resources === null || resources.length === 0
      ? "(no resources)"
      : resources.map((r) => `${r.uri}  ${r.name ?? ""}`.trimEnd()).join("\n"),
  );
  return EXIT_OK;
}

async function cmdRead(args: ParsedArgs): Promise<number> {
  const ctx = context(args);
  const [target, uri] = args.positionals;
  if (!target || !uri) throw new UsageError("read needs a server name and a resource URI");
  const serverName = resolveServerName(ctx, target);

  const result = await ctx.connector.with(serverName, (client) =>
    client.readResource({ uri }, ctx.connector.requestOptions),
  );

  emit(ctx.json, result, () =>
    (result.contents ?? [])
      .map((c) => ("text" in c && typeof c.text === "string" ? c.text : JSON.stringify(c)))
      .join("\n"),
  );
  return EXIT_OK;
}

async function cmdPrompts(args: ParsedArgs): Promise<number> {
  const ctx = context(args);
  const target = args.positionals[0];
  if (!target) throw new UsageError("prompts needs a server name");
  const serverName = resolveServerName(ctx, target);

  const prompts = await ctx.connector.with(serverName, async (client) => {
    if (!client.getServerCapabilities()?.prompts) return null;
    const result = await client.listPrompts(undefined, ctx.connector.requestOptions);
    return result.prompts;
  });

  if (prompts === null) {
    process.stderr.write(`mcp-cli: ${serverName} advertises no prompts capability
`);
  }

  emit(ctx.json, { server: serverName, prompts: prompts ?? [] }, () =>
    prompts === null || prompts.length === 0
      ? "(no prompts)"
      : prompts
          .map((p) =>
            `${serverName}.${p.name}  ${p.description ? firstLine(p.description) : ""}`.trimEnd(),
          )
          .join("\n"),
  );
  return EXIT_OK;
}

async function cmdPrompt(args: ParsedArgs): Promise<number> {
  const ctx = context(args);
  const query = args.positionals[0];
  if (!query) throw new UsageError("prompt needs a server.name address");
  const split = splitAddress(query);
  if (!split) throw new UsageError(`"${query}" is not a server.name address`);
  const serverName = resolveServerName(ctx, split.server);

  const raw = parseArguments(readArgumentText(args.positionals[1], readStdinSync));
  const promptArgs: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    promptArgs[k] = typeof v === "string" ? v : JSON.stringify(v);
  }

  const result = await ctx.connector.with(serverName, (client) =>
    client.getPrompt({ name: split.tool, arguments: promptArgs }, ctx.connector.requestOptions),
  );

  emit(ctx.json, result, () =>
    (result.messages ?? [])
      .map((m) => {
        const content = m.content as { type?: string; text?: string };
        return `[${m.role}] ${content?.type === "text" ? content.text : JSON.stringify(m.content)}`;
      })
      .join("\n"),
  );
  return EXIT_OK;
}

/* -------------------------------------------------------- import-claude -- */

function cmdImportClaude(args: ParsedArgs): number {
  const from = args.from ?? join(homedir(), ".claude.json");
  const out = args.out ?? configPath(args.config);

  const { servers, skipped } = convertServers(readClaudeServers(from));

  let existing: CliConfig | undefined;
  if (existsSync(out)) {
    existing = parseConfig(JSON.parse(readFileSync(out, "utf8")), out);
  }
  const merged = mergeIntoConfig(existing, servers);

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

  emit(
    args.json,
    { from, out, imported: Object.keys(servers).sort(), skipped: skipped.sort() },
    () =>
      [
        `wrote ${out}`,
        `imported ${Object.keys(servers).length} servers from ${from}`,
        skipped.length > 0 ? `skipped: ${skipped.sort().join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
  );
  return EXIT_OK;
}

/* ------------------------------------------------------------- helpers -- */

function firstLine(text: string): string {
  const line = text.split("\n")[0].trim();
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Render an MCP result's content blocks as plain text. */
function renderContent(result: unknown): string {
  const r = result as {
    content?: Array<{ type?: string; text?: string; [k: string]: unknown }>;
    structuredContent?: unknown;
  };
  if (Array.isArray(r.content) && r.content.length > 0) {
    return r.content
      .map((block) =>
        block.type === "text" && typeof block.text === "string"
          ? block.text
          : JSON.stringify(block),
      )
      .join("\n");
  }
  if (r.structuredContent !== undefined) return JSON.stringify(r.structuredContent, null, 2);
  return JSON.stringify(result, null, 2);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: Error) => {
    process.stderr.write(`mcp-cli: ${err.message}\n`);
    process.exitCode = EXIT_FAILURE;
  });

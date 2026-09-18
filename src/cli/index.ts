#!/usr/bin/env node

/**
 * mcp-cli — a non-interactive MCP client for agents and shells.
 *
 * The name is `mcp-cli` rather than `mcp` because the Python SDK already owns
 * `mcp` on PATH. Every call connects, acts and disconnects, so a server edited
 * between two calls shows its new tools on the second one.
 *
 * This file holds command bodies and nothing else. The fleet answers every
 * question that needs no connection, the executor is the only way to reach a
 * server, and the output module is the only thing that writes.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, realpathSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

import { parseArgs, type ParsedArgs } from "./args.js";
import { BlockedError, CliError, UsageError } from "./errors.js";
import {
  configPath,
  parseConfig,
  pruningSettings,
  routeSettings,
  supervisionSettings,
  DEFAULT_CONFIG_PATH,
  type CliConfig,
} from "./config.js";
import { loadFleet, type Fleet } from "./fleet.js";
import { CLIENT_VERSION, ServerError, type ToolDescriptor } from "./server-session.js";
import { resolveAddress, splitAddress } from "./match.js";
import { parseArguments, readArgumentText, readStdinSync } from "./input.js";
import { convertServers, mergeIntoConfig, readClaudeServers } from "./import.js";
import {
  Output,
  columnWidth,
  firstLine,
  oneLine,
  renderContent,
  type RenderOptions,
} from "./output.js";
import { cmdBridge } from "./bridge.js";
import { cmdDaemon, daemonEnabled, daemonSettings } from "./daemon.js";
import { fileSpillStore, runSpillCommand } from "./spill.js";
import {
  DaemonLane,
  EphemeralLane,
  McpExecutor,
  SupervisedError,
  fileSink,
  fileStateStore,
  NO_EVENTS,
  plainEnvelope,
  type Executed,
  type Lane,
  type Operation,
} from "../supervise/index.js";
import { cmdCircuits } from "./circuits.js";
import { cmdSearch } from "./search.js";

const EXIT_OK = 0;
const EXIT_FAILURE = 1;

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
  mcp-cli search <query> [--limit N]       web search, Google first and Brave when it fails
  mcp-cli circuits <status|reset> [server] what the supervisor refuses right now, and why
  mcp-cli import-claude                    build the config from ~/.claude.json
  mcp-cli bridge <serve|mcp|selftest|exec> run host commands over the path contract
  mcp-cli daemon <start|stop|status|serve> keep server connections warm between calls
  mcp-cli spill <get|path|prune>          read back a result that was spilled

Arguments for call and prompt are JSON, given as inline text, as "-" to read
stdin, or as "@path" to read a file.

Global flags:
  --config <path>   config file (default ${DEFAULT_CONFIG_PATH}, env MCP_CLI_CONFIG)
  --profile <name>  blocklist profile (env MCP_CLI_PROFILE, default "default")
  --json            one JSON object on stdout instead of text; a failure is an envelope
  --timeout <ms>    total budget of one operation, queue wait included
  --all             with "tools", also show blocked tools, marked
  --format <raw|compact|table|sample>  how a text result is re-encoded, with "call"
  --intent <text>   narrow a stored result to what it asked for, with "call"
  --limit <n>       with "search", how many rows
  --provider <name> with "search", one server instead of the route
  --port, --bind    with "bridge serve", the listening socket
  --port            with "daemon", its port (env MCP_CLI_DAEMON_PORT, default 8791)
  --log <path>      with "daemon serve" and "bridge serve", append the log there
  --cwd, --stdin    with "bridge exec", the working directory and standard input
  --help, --version

Exit codes: 0 success, 1 failure, 2 usage error, 3 tool blocked by the profile,
4 refused before dispatch (circuit open, excluded request, queue full, daemon
required, or arguments over the limit).

With a daemon running, every call reuses one warm connection per server, so a
stdio server keeps its own state between two calls. MCP_CLI_DAEMON=0 turns that
off for one run.`;

/** Executors opened by this run, closed when the command ends. */
const openExecutors: McpExecutor[] = [];

/**
 * Run one command and return its exit code. Exported so a test can drive the
 * whole surface in process; the file runs it only when it is the entry point.
 */
export async function main(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    return fail(new Output(false), err as Error, false);
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
      case "bridge":
        return await cmdBridge(args);
      case "daemon":
        return await cmdDaemon(args);
      case "spill":
        return cmdSpill(args);
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
      case "search":
        return await cmdSearch(args, context(args));
      case "circuits":
        return cmdCircuits(args, context(args));
      default:
        throw new UsageError(`Unknown command "${args.command}". Run mcp-cli --help.`);
    }
  } catch (err) {
    return fail(new Output(args.json), err as Error, args.json);
  } finally {
    await Promise.all(openExecutors.splice(0).map((executor) => executor.close()));
  }
}

/**
 * Report a failure and hand back the exit code the error itself carries.
 *
 * In text mode the message is one line on stderr, with the class and the
 * next move on a second line when the supervisor knows them. Under `--json`
 * the failure is the stable envelope on stdout, so a pipeline that reads
 * stdout always gets one JSON object, success or not.
 */
function fail(out: Output, err: Error, json: boolean): number {
  const code = err instanceof CliError ? err.exitCode : EXIT_FAILURE;
  if (json) {
    // Any failure that knows its own envelope prints it; the rest get the plain one.
    const withEnvelope = err as { envelope?: () => unknown };
    const envelope =
      typeof withEnvelope.envelope === "function"
        ? withEnvelope.envelope()
        : plainEnvelope(err as CliError);
    out.emit(envelope, () => "");
  }
  out.note(err.message);
  if (err instanceof SupervisedError) {
    const r = err.report;
    const tag = r.reason !== undefined ? `${r.class}/${r.reason}` : r.class;
    const lines = [`[${tag}] ${r.server} ${r.operation} attempts=${r.attempts} trace=${r.trace}`];
    if (r.remediation !== undefined) lines.push(r.remediation);
    out.note(lines.join("\n         "));
  }
  return code;
}

/** Everything a server-touching command needs. */
export interface Context {
  fleet: Fleet;
  executor: McpExecutor;
  out: Output;
  render: RenderOptions;
  /** The `--timeout` budget for every operation of this run, if given. */
  deadlineMs?: number;
}

/**
 * The one place the executor and its lanes are built.
 *
 * The ephemeral lane is always built, because it is also where an operation
 * goes when nothing answers on the daemon port. Which lane actually runs is
 * settled by the first operation of each run, not here: there is no
 * synchronous way to ask whether a TCP port is listening, and a refused
 * connection has to mean "no daemon" rather than "failure".
 */
export function context(args: ParsedArgs): Context {
  const fleet = loadFleet({ config: args.config, profile: args.profile });
  const settings = supervisionSettings(fleet.config);
  const ephemeral = new EphemeralLane(fleet);
  let primary: Lane = ephemeral;
  let fallback: Lane | undefined;

  if (daemonEnabled()) {
    const daemon = daemonSettings(args, process.env, fleet.config);
    primary = new DaemonLane({
      host: daemon.host,
      port: daemon.port,
      configPath: daemon.configPath,
      profile: fleet.profile.name,
    });
    fallback = ephemeral;
  }

  const executor = new McpExecutor({
    fleet,
    settings,
    primary,
    fallback,
    store: fileStateStore(join(settings.stateDir, "circuits.json")),
    events: settings.eventLog !== undefined ? fileSink(settings.eventLog) : NO_EVENTS,
  });
  openExecutors.push(executor);

  const out = new Output(args.json);
  const pruning = pruningSettings(fleet.config);
  const render: RenderOptions = {
    describeBlocks: pruning.describeBlocks,
    format: args.format ?? pruning.format,
    prune: { thresholdBytes: pruning.thresholdBytes, headBytes: pruning.headBytes },
    store: fileSpillStore(pruning.spillDir),
    note: (m) => out.note(m),
    intentBudget: pruning.intentBudget,
  };

  const ctx: Context = { fleet, executor, out, render };
  if (args.timeoutMs !== undefined) ctx.deadlineMs = args.timeoutMs;
  return ctx;
}

/** One operation through the executor, with this run's budget. */
export function run<O extends Operation>(
  ctx: Context,
  server: string,
  op: O,
): Promise<Executed<import("../supervise/operation.js").ResultOf<O>>> {
  return ctx.executor.execute(server, op, {
    ...(ctx.deadlineMs !== undefined ? { deadlineMs: ctx.deadlineMs } : {}),
  });
}

/** The routes block of this run's config. */
export function routesOf(ctx: Context): ReturnType<typeof routeSettings> {
  return routeSettings(ctx.fleet.config);
}

/** The one positional a command requires, or a usage error naming what it is. */
function required(args: ParsedArgs, index: number, what: string): string {
  const value = args.positionals[index];
  if (!value) throw new UsageError(what);
  return value;
}

/* -------------------------------------------------------------- servers -- */

function cmdServers(args: ParsedArgs): number {
  const ctx = context(args);
  const rows = ctx.fleet.describe();

  ctx.out.emit({ profile: ctx.fleet.profile.name, servers: rows }, () => {
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
  readOnly?: boolean;
  blockedBy?: string;
}

/** Mark each tool of one server with the block pattern that covers it. */
function toRows(fleet: Fleet, serverName: string, tools: ToolDescriptor[]): ToolRow[] {
  return tools.map((tool) => {
    const address = `${serverName}.${tool.name}`;
    const pattern = fleet.blockedBy(address);
    const row: ToolRow = { address, server: serverName, name: tool.name };
    if (tool.description !== undefined) row.description = tool.description;
    if (tool.annotations?.readOnlyHint === true) row.readOnly = true;
    if (pattern) row.blockedBy = pattern;
    return row;
  });
}

async function cmdTools(args: ParsedArgs): Promise<number> {
  const ctx = context(args);
  const target = args.positionals[0];
  const names = target ? [ctx.fleet.resolveServer(target)] : ctx.fleet.names();

  const rows: ToolRow[] = [];
  const errors: Array<{ server: string; error: string; class?: string }> = [];

  for (const name of names) {
    try {
      const { value } = await run(ctx, name, { kind: "listTools" });
      rows.push(...toRows(ctx.fleet, name, value));
    } catch (err) {
      // One unreachable server must not sink a whole-fleet listing.
      const row: { server: string; error: string; class?: string } = {
        server: name,
        error: oneLine((err as Error).message),
      };
      if (err instanceof SupervisedError) row.class = err.report.class;
      errors.push(row);
    }
  }

  const visible = args.all ? rows : rows.filter((r) => !r.blockedBy);

  ctx.out.emit({ profile: ctx.fleet.profile.name, tools: visible, errors }, () => {
    const lines: string[] = [];
    if (visible.length === 0) lines.push("(no tools)");
    const width = columnWidth(visible.map((r) => r.address));
    for (const row of visible) {
      const mark = row.blockedBy
        ? ` [blocked by profile ${ctx.fleet.profile.name}: ${row.blockedBy}]`
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
  const query = required(args, 0, "call needs a server.tool address");

  const split = splitAddress(query);
  if (!split) throw new UsageError(`"${query}" is not a server.tool address`);

  // Read the arguments before connecting, so a bad payload costs no process.
  const rawArgs = parseArguments(readArgumentText(args.positionals[1], readStdinSync));

  const serverName = ctx.fleet.resolveServer(split.server);
  // An address the profile blocks outright never reaches the server at all.
  refuseIfBlocked(ctx, `${serverName}.${split.tool}`);

  const tools = await run(ctx, serverName, { kind: "listTools" });
  const toolName = pickTool(ctx, `${serverName}.${split.tool}`, serverName, tools.value);
  const executed = await run(ctx, serverName, { kind: "callTool", name: toolName, args: rawArgs });
  const result = executed.value;

  if (executed.failure !== undefined && !args.json) {
    // The result is printed as the server answered it; the class is a remark.
    const f = executed.failure;
    ctx.out.note(
      `${serverName}.${toolName} reported ${f.class}${f.remediation ? `: ${f.remediation}` : ""}`,
    );
  }

  // The --json path is untouched: it serialises the raw result object, so no
  // pruning, describing, re-encoding or intent narrowing can ever reach it.
  ctx.out.emit(result, () => renderContent(result, renderIntent(ctx.render, args.intent)));
  return result.isError === true ? EXIT_FAILURE : EXIT_OK;
}

/**
 * The render of one call, with this call's `--intent` folded in.
 *
 * The intent belongs to the render, not after it: it searches the whole text
 * pruning spills, so it must be inside the same renderContent call rather than
 * applied to the head that call prints. No intent means the render as it is.
 */
function renderIntent(render: RenderOptions, intent: string | undefined): RenderOptions {
  return intent === undefined ? render : { ...render, intent };
}

/* ---------------------------------------------------------------- spill -- */

/** `mcp-cli spill <get|path|prune>`: the read-back surface for spilled results. */
function cmdSpill(args: ParsedArgs): number {
  const fleet = loadFleet({ config: args.config, profile: args.profile });
  const settings = pruningSettings(fleet.config);
  const out = new Output(args.json);
  // `parseArgs` consumes `--older-than` wherever it stands, so it is handed
  // back here; `runSpillCommand` keeps reading it too, for a caller who
  // escapes the whole subcommand behind `--`.
  const argv = [...args.positionals];
  if (args.olderThan !== undefined) argv.push("--older-than", String(args.olderThan));
  return runSpillCommand(argv, fileSpillStore(settings.spillDir), out);
}

/** Raise when the profile blocks this exact address. */
function refuseIfBlocked(ctx: Context, address: string): void {
  const pattern = ctx.fleet.blockedBy(address);
  if (pattern) {
    throw new BlockedError(
      `${address} is blocked by profile "${ctx.fleet.profile.name}" (pattern "${pattern}")`,
    );
  }
}

/** Exact, then fuzzy, then the blocklist check. Returns the bare tool name. */
function pickTool(
  ctx: Context,
  query: string,
  serverName: string,
  tools: ToolDescriptor[],
): string {
  const addresses = tools.map((t) => `${serverName}.${t.name}`);
  const match = resolveAddress(query, addresses);

  if (match.kind === "none") {
    throw new ServerError(
      `No tool matches "${query}". Run: mcp-cli tools ${serverName}`,
      serverName,
    );
  }
  if (match.kind === "ambiguous") {
    throw new ServerError(
      `"${query}" is ambiguous. Candidates: ${match.candidates.join(", ")}`,
      serverName,
    );
  }
  if (match.kind === "fuzzy") {
    ctx.out.note(`"${query}" resolved to ${match.address}`);
  }

  refuseIfBlocked(ctx, match.address);
  return match.address.slice(serverName.length + 1);
}

/* ----------------------------------------------------------------- info -- */

async function cmdInfo(args: ParsedArgs): Promise<number> {
  const ctx = context(args);
  const serverName = ctx.fleet.resolveServer(required(args, 0, "info needs a server name"));

  const { value: info } = await run(ctx, serverName, { kind: "info" });
  const payload = {
    server: serverName,
    transport: info.transport,
    serverInfo: info.serverInfo ?? null,
    protocolVersion: info.protocolVersion ?? null,
    era: info.era ?? null,
    capabilities: info.capabilities,
  };

  ctx.out.emit(payload, () =>
    [
      `server           ${payload.server}`,
      `transport        ${payload.transport}`,
      `serverInfo       ${payload.serverInfo ? `${payload.serverInfo.name ?? "?"} ${payload.serverInfo.version ?? ""}`.trim() : "(none)"}`,
      `protocolVersion  ${payload.protocolVersion ?? "(unknown)"}`,
      `era              ${payload.era ?? "(unknown)"}`,
      `capabilities     ${payload.capabilities.length > 0 ? payload.capabilities.join(", ") : "(none)"}`,
    ].join("\n"),
  );
  return EXIT_OK;
}

/* ------------------------------------------------- resources and prompts -- */

async function cmdResources(args: ParsedArgs): Promise<number> {
  const ctx = context(args);
  const serverName = ctx.fleet.resolveServer(required(args, 0, "resources needs a server name"));

  const { value: resources } = await run(ctx, serverName, { kind: "listResources" });
  if (resources === null) {
    ctx.out.note(`${serverName} advertises no resources capability`);
  }

  ctx.out.emit({ server: serverName, resources: resources ?? [] }, () =>
    resources === null || resources.length === 0
      ? "(no resources)"
      : resources.map((r) => `${r.uri}  ${r.name ?? ""}`.trimEnd()).join("\n"),
  );
  return EXIT_OK;
}

async function cmdRead(args: ParsedArgs): Promise<number> {
  const ctx = context(args);
  const target = required(args, 0, "read needs a server name and a resource URI");
  const uri = required(args, 1, "read needs a server name and a resource URI");
  const serverName = ctx.fleet.resolveServer(target);

  const { value: result } = await run(ctx, serverName, { kind: "readResource", uri });

  ctx.out.emit(result, () =>
    (result.contents ?? [])
      .map((c) => ("text" in c && typeof c.text === "string" ? c.text : JSON.stringify(c)))
      .join("\n"),
  );
  return EXIT_OK;
}

async function cmdPrompts(args: ParsedArgs): Promise<number> {
  const ctx = context(args);
  const serverName = ctx.fleet.resolveServer(required(args, 0, "prompts needs a server name"));

  const { value: prompts } = await run(ctx, serverName, { kind: "listPrompts" });
  if (prompts === null) {
    ctx.out.note(`${serverName} advertises no prompts capability`);
  }

  ctx.out.emit({ server: serverName, prompts: prompts ?? [] }, () =>
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
  const query = required(args, 0, "prompt needs a server.name address");
  const split = splitAddress(query);
  if (!split) throw new UsageError(`"${query}" is not a server.name address`);
  const serverName = ctx.fleet.resolveServer(split.server);

  const raw = parseArguments(readArgumentText(args.positionals[1], readStdinSync));
  const promptArgs: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    promptArgs[k] = typeof v === "string" ? v : JSON.stringify(v);
  }

  const { value: result } = await run(ctx, serverName, {
    kind: "getPrompt",
    name: split.tool,
    args: promptArgs,
  });

  ctx.out.emit(result, () =>
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
  const output = new Output(args.json);

  const { servers, skipped } = convertServers(readClaudeServers(from));

  let existing: CliConfig | undefined;
  if (existsSync(out)) {
    existing = parseConfig(JSON.parse(readFileSync(out, "utf8")), out);
  }
  const merged = mergeIntoConfig(existing, servers);

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

  output.emit({ from, out, imported: Object.keys(servers).sort(), skipped: skipped.sort() }, () =>
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

/**
 * True when node was started on this file rather than importing it.
 *
 * The comparison is between real paths, not between URLs. A global install
 * reaches this file through a symlinked node_modules directory, so the path
 * node was given and the path this module resolved to differ as text and name
 * the same file on disk.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: Error) => {
      process.stderr.write(`mcp-cli: ${err.message}\n`);
      process.exitCode = EXIT_FAILURE;
    });
}

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
import { BlockedError, CliError, UnknownServerError, UsageError } from "./errors.js";
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
import { callArguments, readStdinSync } from "./input.js";
import { queryResult, sourceEnvelope } from "./result-query.js";
import { spillHint } from "./spill-hints.js";
import { retainSource } from "./result-source.js";
import { buildEnvelope, textOf } from "./envelope.js";
import { callExample, nearest } from "./example.js";
import { fileToolCache, serversWithTools, type ToolCache } from "./tool-cache.js";
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
import { cmdAuth } from "./auth.js";
import { cmdSearch } from "./search.js";
import { credentialStoreFor } from "../auth/index.js";

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
  mcp-cli auth <login|status|logout|refresh> [server]  OAuth for a url server; login opens a browser
  mcp-cli import-claude                    build the config from ~/.claude.json
  mcp-cli bridge <serve|mcp|selftest|exec> run host commands over the path contract
  mcp-cli daemon <start|stop|status|serve> keep server connections warm between calls
  mcp-cli spill <query|get|path|prune>    inspect or read back a result that was spilled

Arguments for call and prompt are JSON, given as inline text, as "-" to read
stdin, as "@path" to read a file, or with --args-file <path> for the same file
without the sigil. PowerShell reads a leading "@" as the array operator, so
--args-file is the file form that needs no quoting rule. --arg key=value gives
one string argument with no file and no quoting rule in any shell; repeat it
for more, and use --arg-json key=<json> for a number, boolean, list or object.

Global flags:
  --config <path>   config file (default ${DEFAULT_CONFIG_PATH}, env MCP_CLI_CONFIG)
  --profile <name>  blocklist profile (env MCP_CLI_PROFILE, default "default")
  --json            one JSON envelope on stdout: {ok, result} or {ok, error}
  --timeout <ms>    total budget of one operation, queue wait included
  --all             with "tools", also show blocked tools, marked
  --schema          with "tools", also show each tool's argument schema
  --format <raw|compact|table|sample>  how a text result is re-encoded, with "call"
  --intent <text>   narrow a stored result to what it asked for, with "call"
  --envelope-version <1|2>  opt into typed call results (default 1)
  --select <pointer>  exact field, repeatable, with spill query
  --within <pointer> --query <words> --cursor <cursor> --max-bytes <n>
                      spill query scope/search/page/budget (default 4096)
                      A pointer is record/body, /record/body or #/record/body.
                      Under Git Bash write record/body: MSYS rewrites an
                      argument that starts with / or #/ as a Windows path.
  --request-file <path>  structured request for bridge exec
  --args-file <path>  read a call's JSON arguments from a file, without the @ sigil
  --arg <key=value>   one string argument, repeatable; a.b=c nests
  --arg-json <key=json>  one typed argument, repeatable
  --limit <n>       with "search", how many rows
  --provider <name> with "search", one server instead of the route
  --port, --bind    with "bridge serve", the listening socket
  --port            with "daemon", its port (env MCP_CLI_DAEMON_PORT, default 8791)
  --log <path>      with "daemon serve" and "bridge serve", append the log there
  --scope <s>       with "auth login", the OAuth scope to request (default: what the server names)
  --callback-port <n>  with "auth login", the loopback port for the redirect (default 8792)
  --no-browser      with "auth login", print the URL and open nothing
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
      case "auth":
        return await cmdAuth(args);
      default:
        throw new UsageError(`Unknown command "${args.command}". Run mcp-cli --help.`);
    }
  } catch (err) {
    return fail(
      new Output(args.json),
      err as Error,
      args.json,
      args.envelopeVersion === 2 || (args.command === "spill" && args.positionals[0] === "query"),
    );
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
function fail(out: Output, err: Error, json: boolean, v2 = false): number {
  const code = err instanceof CliError ? err.exitCode : EXIT_FAILURE;
  if (json) {
    // Any failure that knows its own envelope prints it; the rest get the plain one.
    const withEnvelope = err as { envelope?: () => unknown };
    const envelope =
      typeof withEnvelope.envelope === "function"
        ? withEnvelope.envelope()
        : plainEnvelope(err as CliError);
    out.emit(
      v2 ? { ...(envelope as object), schemaVersion: 2, result: { kind: "error" } } : envelope,
      () => "",
    );
    // The envelope carries the message and the class. A second copy on stderr
    // reaches a caller whose tool merges the two streams as the same text
    // twice, and a pipeline that reads stdout has already been answered.
    return code;
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
  /**
   * What each server last showed, so an unresolvable address can be answered
   * with the fleet's tools instead of a fan-out. Written by every successful
   * listing; never consulted before a call is allowed.
   */
  toolCache: ToolCache;
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
  const authStore = credentialStoreFor(fleet.config);
  const ephemeral = new EphemeralLane(fleet, process.env, authStore);
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
    credentialStamp: (server) => authStore.stamp(server),
    onFallback: (reason) => {
      if (!args.json)
        out.note(
          `using ephemeral connection: ${reason === "config_mismatch" ? "scoped config differs" : "daemon is not running"}`,
        );
    },
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

  const toolCache = fileToolCache(join(settings.stateDir, "tools.json"), fleet.source || undefined);
  const ctx: Context = { fleet, executor, out, render, toolCache };
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
  /** The tool's argument schema, carried when `--schema` asked for it. */
  inputSchema?: Record<string, unknown>;
}

/** Mark each tool of one server with the block pattern that covers it. */
function toRows(
  fleet: Fleet,
  serverName: string,
  tools: ToolDescriptor[],
  schema = false,
): ToolRow[] {
  return tools.map((tool) => {
    const address = `${serverName}.${tool.name}`;
    const pattern = fleet.blockedBy(address);
    const row: ToolRow = { address, server: serverName, name: tool.name };
    if (tool.description !== undefined) row.description = tool.description;
    if (tool.annotations?.readOnlyHint === true) row.readOnly = true;
    if (pattern) row.blockedBy = pattern;
    // Schemas are large, and a listing is read far more often than a schema is
    // needed, so they are carried only when the flag asked for them.
    if (schema && tool.inputSchema !== undefined) row.inputSchema = tool.inputSchema;
    return row;
  });
}

async function cmdTools(args: ParsedArgs): Promise<number> {
  const ctx = context(args);
  const target = args.positionals[0];
  const exact = target ? splitAddress(target) : undefined;
  const names = target ? [ctx.fleet.resolveServer(exact?.server ?? target)] : ctx.fleet.names();

  const rows: ToolRow[] = [];
  const errors: Array<{ server: string; error: string; class?: string }> = [];

  for (const name of names) {
    try {
      const { value } = await run(ctx, name, { kind: "listTools" });
      // Every listing feeds the record the error path reads later.
      ctx.toolCache.put(
        name,
        value.map((t) => t.name),
      );
      const selected = exact ? value.filter((t) => t.name === exact.tool) : value;
      if (exact && selected.length === 0) {
        const suggestion = nearest(
          exact.tool,
          value.map((t) => t.name),
        );
        throw new UsageError(
          `Unknown tool "${exact.tool.slice(0, 120)}".${suggestion ? ` Try ${name}.${suggestion.slice(0, 120)}.` : ""}`,
        );
      }
      rows.push(...toRows(ctx.fleet, name, selected, args.schema));
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

  if (exact && !args.all && rows[0]?.blockedBy) refuseIfBlocked(ctx, rows[0].address);
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
      if (row.inputSchema !== undefined) {
        lines.push(indent(JSON.stringify(row.inputSchema, null, 2), "    "));
      }
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
  if (!split) {
    throw new UsageError(`"${query}" is not a server.tool address. ${fleetListing(ctx)}`);
  }

  // Read the arguments before connecting, so a bad payload costs no process.
  const argSpec = args.positionals[1];
  const rawArgs = callArguments(argSpec, readStdinSync, {
    argsFile: args.argsFile,
    arg: args.arg,
    argJson: args.argJson,
  });

  let serverName: string;
  try {
    serverName = ctx.fleet.resolveServer(split.server);
  } catch (err) {
    // The fleet names its servers; a call that named none of them also needs
    // their tools, because the tool is what the caller was actually reaching
    // for and the server name is only how it is spelled.
    if (err instanceof UnknownServerError) {
      throw new UnknownServerError(`Unknown server "${split.server}". ${fleetListing(ctx)}`);
    }
    throw err;
  }
  // An address the profile blocks outright never reaches the server at all.
  refuseIfBlocked(ctx, `${serverName}.${split.tool}`);

  const tools = await run(ctx, serverName, { kind: "listTools" });
  ctx.toolCache.put(
    serverName,
    tools.value.map((t) => t.name),
  );
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

  const ref = retainSource(ctx.render.store, result, { server: serverName, tool: toolName });
  const execution = {
    lane: executed.lane,
    ...(executed.fallbackReason ? { fallbackReason: executed.fallbackReason } : {}),
  };
  if (args.envelopeVersion === 2) {
    const extra = { lane: executed.lane, execution };
    const view =
      args.intent === undefined
        ? sourceEnvelope(ctx.render.store, ref, extra, args.maxBytes)
        : queryResult(
            ctx.render.store,
            { ref, query: args.intent, maxBytes: args.maxBytes },
            extra,
          );
    ctx.out.emit(view, () => JSON.stringify(view, null, 2));
    return result.isError === true ? EXIT_FAILURE : EXIT_OK;
  }
  const render = renderIntent({ ...ctx.render, sourceRef: ref }, args.intent);
  // Both paths render the same result; only the reader differs. The JSON path
  // falls back to the text rendering whenever the result is not one JSON
  // document, so the two never disagree about what a result says.
  ctx.out.emitLazy(
    () => ({
      ...callEnvelope(result, executed.lane, render, args.intent),
      ...(executed.fallbackReason ? { execution } : {}),
    }),
    () => renderContent(result, render),
  );
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

/**
 * The object `--json` prints for one call.
 *
 * The shape mirrors the failure envelope `fail()` writes, so a caller tests
 * `.ok` once and then reads `.result` or `.error`. `lane` says whether the warm
 * daemon or a fresh connection served the call: a caller running under a
 * narrowed `MCP_CLI_CONFIG` needs that to know what its narrowing bought.
 */
function callEnvelope(
  result: { isError?: boolean },
  lane: string,
  render: RenderOptions,
  intent: string | undefined,
): Record<string, unknown> {
  const isError = result.isError === true;

  // An intent asked for an answer, not a document, and the text path already
  // searched the whole stored text for it. The JSON path carries that answer.
  if (intent !== undefined) {
    return { ok: !isError, isError, lane, result: renderContent(result, render) };
  }

  const text = textOf(result);
  const envelope =
    text === undefined
      ? { result: renderContent(result, render) }
      : buildEnvelope(text, renderContent(result, render), {
          prune: render.prune,
          store: render.store,
          sourceRef: render.sourceRef,
        });

  const out: Record<string, unknown> = { ok: !isError, isError, lane, result: envelope.result };
  if (envelope.spill !== undefined) {
    // One ref, named three times for three readers: `spill` for a v1 caller
    // doing `spill get`, `source.ref` for one doing `spill query`, and `next`
    // as the command that reaches the first withheld field.
    out.spill = envelope.spill;
    out.source = { ref: envelope.spill };
    out.next = spillHint(envelope.spill, envelope.withheldPath);
    out.withheldBytes = envelope.withheldBytes ?? 0;
  }
  return out;
}

/* ---------------------------------------------------------------- spill -- */

/** `mcp-cli spill <get|path|prune>`: the read-back surface for spilled results. */
function cmdSpill(args: ParsedArgs): number {
  const fleet = loadFleet({ config: args.config, profile: args.profile });
  const settings = pruningSettings(fleet.config);
  const out = new Output(args.json);
  if (args.positionals[0] === "query") {
    const view = queryResult(fileSpillStore(settings.spillDir), {
      ref: args.positionals[1],
      select: args.select,
      within: args.within,
      query: args.query,
      cursor: args.cursor,
      maxBytes: args.maxBytes,
    });
    out.emit(view, () => JSON.stringify(view, null, 2));
    return view.ok ? EXIT_OK : EXIT_FAILURE;
  }
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

/**
 * Indent every line of a block, so a schema sits under the tool it belongs to.
 */
function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? line : `${prefix}${line}`))
    .join("\n");
}

/**
 * Every configured server with the tools it last showed.
 *
 * This is the widest of the three answers an unresolvable address can get, and
 * it is read from the record on disk, never fetched. A fan-out over a whole
 * fleet costs tens of seconds and dials servers that are only failing, which is
 * far too much to spend on an error message.
 */
function fleetListing(ctx: Context): string {
  const lines = serversWithTools(ctx.toolCache, ctx.fleet.names());
  return `Configured servers:\n${lines.map((l) => `  ${l}`).join("\n")}`;
}

/**
 * Exact, then fuzzy, then the blocklist check. Returns the bare tool name.
 *
 * A failure here answers with as much as it can determine. The tool list has
 * already been fetched by the caller, and each descriptor carries its schema,
 * so naming the likely tool and printing the call for it costs nothing beyond
 * the comparison.
 */
function pickTool(
  ctx: Context,
  query: string,
  serverName: string,
  tools: ToolDescriptor[],
): string {
  const addresses = tools.map((t) => `${serverName}.${t.name}`);
  const match = resolveAddress(query, addresses);

  if (match.kind === "none") {
    throw new ServerError(noMatchMessage(query, serverName, tools, addresses), serverName);
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

/**
 * What to say when no tool of a known server matches the address.
 *
 * One tool close enough to be a typo gets the call that would have worked.
 * Otherwise the server's whole tool list goes in the message: the caller has
 * already paid for that listing, and telling it to run a second command to see
 * what it could have been shown is a round trip for nothing.
 */
function noMatchMessage(
  query: string,
  serverName: string,
  tools: ToolDescriptor[],
  addresses: string[],
): string {
  const guess = nearest(query, addresses);
  if (guess !== undefined) {
    const tool = tools.find((t) => `${serverName}.${t.name}` === guess);
    const example = tool ? callExample(guess, tool) : undefined;
    const how = example ?? `mcp-cli call ${guess} '{}'`;
    return `No tool matches "${query}". Did you mean ${guess}?\n  ${how}`;
  }
  const names = tools.map((t) => `${serverName}.${t.name}`);
  const listing = names.length > 0 ? names.map((n) => `  ${n}`).join("\n") : "  (no tools)";
  return `No tool matches "${query}". ${serverName} has:\n${listing}`;
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

  const raw = callArguments(args.positionals[1], readStdinSync, {
    argsFile: args.argsFile,
    arg: args.arg,
    argJson: args.argJson,
  });
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

# mcp-cli architecture pass

Scope: `src/cli/**` and the seams it opens into `src/transport.ts`, `src/session.ts`
and `src/client.ts`. The MCP-server side of the repo is out of scope.

The vocabulary is the one in the `codebase-design` skill: **module**, **interface**,
**depth**, **seam**, **adapter**, **leverage**, **locality**. "Interface" here means
everything a caller must know, not only the type signature.

This document replaces the HTML report the `improve-codebase-architecture` skill
normally writes, because this pass ran with no user in the loop. Each opportunity
below carries a recommendation strength and a line saying whether the pass applied
it.

---

## 1. The connection seam does not admit a second adapter

**Strength: Strong. Applied.**

**Files:** `src/cli/connection.ts`, `src/cli/index.ts`, `docs/mcp-cli-daemon.md`.

**Problem.** `Connector.with(serverName, fn)` hands its callback a live
`@modelcontextprotocol/client` `Client`. The daemon design says the daemon
"replaces the body of that method and nothing above it changes". That is not
buildable. A warm daemon answers over a loopback HTTP surface and returns JSON.
It cannot return a live `Client` object. Any daemon adapter would therefore have
to fake a whole SDK class, or every command would have to change. The seam is in
the right *place* and has the wrong *interface*.

The interface leaks in a second way. Every command must also know to pass
`ctx.connector.requestOptions` into each SDK call. The timeout is a property of
the connection, and a caller that forgets it silently loses its budget. Nine call
sites each repeat that fact.

There is a third cost. `cmdCall` calls `listServerTools` and then
`connector.with` again, so one `mcp-cli call` opens two connections and, for a
stdio server, launches the process twice.

**Solution.** Name the module `ServerSession`: one open conversation with one
server. Its interface is the seven MCP operations the CLI actually performs
(`listTools`, `callTool`, `listResources`, `readResource`, `listPrompts`,
`getPrompt`, plus the `info` it was opened with). The timeout lives inside it.
Capability checks live inside it too: `listResources` returns `null` when the
server advertises no resources capability, so no caller reads
`getServerCapabilities`.

The seam becomes `SessionProvider.run(serverName, fn)`. `EphemeralSessions` is
the one adapter behind it and does what v0 does: connect, act, disconnect. A
daemon adapter is then a plain second implementation of the same two interfaces.

**Benefits.** Leverage: a command learns one small interface and gets timeout
handling, stderr capture, capability checks and cleanup for free. Locality: the
`requestOptions` rule is stated once instead of nine times; a change to how
timeouts work is one edit. Tests: a `ServerSession` can be a literal object, so
command behaviour becomes testable with no process and no socket. Under v0 that
required a real server.

---

## 2. Config and profile are a scattered cluster, not a module

**Strength: Strong. Applied.**

**Files:** `src/cli/config.ts`, `src/cli/index.ts`, `src/cli/connection.ts`.

**Problem.** `config.ts` is a good bag of pure functions, but nothing composes
them. `index.ts` calls `configPath`, `loadConfig`, `profileName`,
`resolveProfile` and `blockedBy` itself, and reaches into
`ctx.config.mcpServers` in four separate places. Server-name resolution exists
twice, in two shapes: `resolveServerName` in `index.ts` does exact-then-
case-insensitive, and `Connector.entry` does exact only. They produce two
different error texts for the same mistake, and `tools <name>` therefore rejects
a name that `call <name>.<tool>` accepts.

**Solution.** One module, `Fleet`: the configured servers plus the profile in
force. Interface: `names()`, `entry(name)`, `resolveServer(query)`,
`blockedBy(address)`, `describe()`, and the `profile` it resolved.
`loadFleet(...)` reads disk; `fleetFrom(config, profileName)` takes a config
object, so every rule in the module is testable with no file and no connection.
`transportOf` moves here, because it reads a config entry and never a
connection.

**Benefits.** Locality: "which server does this name mean" is answered in one
place, so the two error texts collapse into one. Leverage: a command needs the
fleet and nothing else to answer `servers`. Tests: the profile, `extends`
chain, glob and unknown-name rules are exercised through one small interface
against an in-memory object.

---

## 3. Output formatting is not a module

**Strength: Strong. Applied.**

**Files:** `src/cli/index.ts`.

**Problem.** `emit`, `firstLine`, `oneLine` and `renderContent` are loose
functions in `index.ts`, and they write to `process.stdout` directly. Two
commands write their own notes to `process.stderr` with a hand-typed `mcp-cli: `
prefix, and one of them embeds a raw newline in a template literal. Nothing that
decides between text and JSON can be tested without capturing the real process
streams.

**Solution.** One module, `Output`, constructed once per run from the `--json`
flag and a write sink. Interface: `emit(value, text)`, `note(message)`, plus the
pure renderers `renderContent`, `firstLine` and `oneLine`.

**Benefits.** Tests inject a sink and assert on strings. Locality: the
trailing-newline rule and the `mcp-cli: ` prefix are each stated once.

---

## 4. `call` launches a blocked tool's server before refusing

**Strength: Worth exploring. Applied.**

**Files:** `src/cli/index.ts`.

**Problem.** Exit code 3 is reached only after the tool list is fetched, so a
call the profile forbids still starts the server process.

**Solution.** Test the literal `server.tool` address against the blocklist
before opening any session, and keep the post-resolution test for the fuzzy
case. A blocked exact address now costs no process.

**Benefit.** The blocklist claim gets stronger: for an exact address the server
is never contacted at all.

---

## 5. `--force` is dead interface

**Strength: Worth exploring. Not applied.**

`ParsedArgs.force` is parsed and never read, and no command documents it. The
deletion test says removing it concentrates nothing. It is left because removing
it turns `--force` from a silently accepted flag into an unknown-flag usage
error, and this pass was told to keep the command surface identical.

---

## 6. `ParsedArgs` carries `from` and `out` for one command

**Strength: Speculative. Not applied.**

`import-claude` is the only reader of `--from` and `--out`. A per-command
options type would be tidier and would buy nothing at this size.

---

## 7. `match.ts` looks shallow and is not

**Strength: none, recorded so a later pass does not re-suggest it.**

`resolveAddress` is 16 lines behind a 2-argument interface. The deletion test
answers correctly: inlining it would spread the exact / case-insensitive /
substring ordering and the ambiguity rule across `call` and `prompt`. It stays.

---

## 8. Every failure kind was matched by hand in main()

**Strength: Strong. Applied.**

**Files:** `src/cli/index.ts`, `src/cli/errors.ts`.

**Problem.** `main` held a chain of four `instanceof` tests to turn an error into
an exit code, and the error classes were defined in four different files. A new
failure kind silently got exit code 1 unless someone remembered to extend the
chain. Folding the blocklist test into a session callback made this worse: a
`BlockedError` raised inside `Connector.with` would have been rewrapped as a
server failure and reported as exit 1 instead of exit 3.

**Solution.** One module, `errors.ts`. `CliError` carries its own `exitCode`,
and `UsageError`, `UnknownServerError`, `ConfigError`, `ArgumentError`,
`BlockedError` and `ServerError` set it. `main` reads the property.
`EphemeralSessions` rewraps anything that is not a `CliError`, and leaves the
CLI's own control-flow errors alone.

**Benefits.** Locality: the exit-code table is one file. Leverage: a new failure
kind states its code once and needs no edit in `main`.

---

## What changed

- Added `src/cli/server-session.ts`: the `ServerSession` and `SessionProvider`
  interfaces, the `EphemeralSessions` adapter, `withTimeout`, `CLIENT_NAME`,
  `CLIENT_VERSION`.
- Added `src/cli/fleet.ts`: the `Fleet` module, including `transportOf`.
- Added `src/cli/output.ts`: the `Output` module and the pure renderers.
- Deleted `src/cli/connection.ts`. Its `Connector` is replaced by
  `EphemeralSessions`; its `transportOf` moved to `fleet.ts`.
- `src/cli/index.ts` now holds command bodies and nothing else.
- `mcp-cli call` opens one session instead of two.
- Added `src/cli/errors.ts`: `CliError` and the six failures that carry an exit
  code.
- `src/cli/index.ts` exports `main` and bootstraps only when it is the entry
  point, so tests drive real command bodies in process.
- `docs/mcp-cli-daemon.md` restated against the seam as it now exists, naming
  the two interfaces a daemon adapter has to satisfy and where the choice of
  adapter is made.

## What was deliberately left

- `--force` (opportunity 5) and the shared `ParsedArgs` shape (opportunity 6).
- `src/cli/config.ts` keeps every export it had. `Fleet` composes them; it does
  not hide them, because `parseConfig` and `mergeIntoConfig` are also used by
  `import-claude`, which never opens a connection.
- `src/transport.ts`, `src/session.ts` and `src/client.ts` are untouched. The
  CLI consumes `createTransport`, `versionNegotiationFor` and `protocolEraOf`
  and adds nothing to their interfaces.
- The MCP-server side of the repo.

## Behaviour changes

One, and it is a widening: `mcp-cli tools FORUM` now resolves the same way
`mcp-cli call FORUM.poll` already did, because both go through
`Fleet.resolveServer`. Exit codes, flags, command names and output text are
otherwise identical.

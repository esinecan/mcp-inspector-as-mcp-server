# host bridge architecture pass

Scope: `src/bridge/**` and `src/cli/bridge.ts`, plus the seams they open into
`src/cli/config.ts`, `args.ts`, `output.ts`, `errors.ts` and `index.ts`. The rest
of mcp-cli is out of scope; `docs/mcp-cli-architecture-pass.md` covers it and its
decisions are not re-opened here.

The vocabulary is the one in the `codebase-design` skill: **module**,
**interface**, **depth**, **seam**, **adapter**, **leverage**, **locality**.
"Interface" means everything a caller must know, not only the type signature.

This document replaces the HTML report the `improve-codebase-architecture` skill
normally writes, because this pass ran with no user in the loop. Each opportunity
carries a recommendation strength and a line saying whether the pass applied it.

The behaviour contract held fixed through the pass: the wire format
(`POST /exec {cmd,cwd,stdin,timeout}` returning `{exit,stdout,stderr}`, exit 124
on timeout, 404 on anything else), the `host_exec` tool schema, the config keys
and their defaults, and every command name and exit code.

---

## 1. Both adapters check the request, and neither checks it fully

**Strength: Strong. Applied.**

**Files:** `src/bridge/exec.ts`, `src/bridge/http.ts`, `src/bridge/mcp-server.ts`.

**Problem.** `execBridged` took a typed `ExecRequest` and checked one field of
it, `cmd`. Both adapters reached it by casting an unchecked value: the HTTP
adapter wrote `JSON.parse(raw) as ExecRequest`, the MCP adapter wrote
`(args ?? {}) as unknown as ExecRequest`. The cast is a claim nobody verified.

The cost was a crash, not a style complaint. `execBridged` called
`pathMap.toHost(req.cwd)` before entering its promise, so a body of
`{"cmd":"dir","cwd":5}` raised `TypeError: p.startsWith is not a function`
synchronously. The HTTP adapter calls `execBridged` from inside a stream
callback, where a synchronous throw is an uncaught exception, so one malformed
body took the whole server down. A `stdin` of the wrong type reached
`child.stdin.write` and did the same later.

Applying the **deletion test** to per-adapter checking confirms the direction: if
each adapter grew its own field checks, the same four rules would exist twice and
would drift the first time one field changed.

**Solution.** `execBridged` takes `unknown`. A private `checkRequest` inside the
core checks every field and resolves the timeout, and the whole entry is wrapped
so a failure is always a rejected promise. `cmd`, `cwd` and `stdin` are strict.
`timeout` stays lenient, because the Python bridge treated a missing key and a
useless value as the same "no budget named", and the wire format must not change.

**Benefits.** Leverage: an adapter hands over whatever it read off the wire and
learns nothing about valid shapes. Locality: "what is a valid request" is one
function, so the HTTP surface and the MCP surface cannot disagree about it.
Tests: the rules are exercised through `execBridged` with no socket and no
server, and a regression test states the no-synchronous-throw invariant that the
HTTP adapter depends on.

---

## 2. Failure shaping is written twice

**Strength: Strong. Applied.**

**Files:** `src/bridge/exec.ts`, `src/bridge/http.ts`, `src/bridge/mcp-server.ts`.

**Problem.** Both adapters held the line
`err instanceof BridgeExecError ? err.message : String(err)`. That is one fact
about the core stated in two modules that import the core. It is the response
shaping the brief asks to de-duplicate.

**Solution.** `bridgeErrorMessage(err)` exported from `exec.ts`. Both adapters
call it. The HTTP status (500) and the MCP envelope (`isError: true`) stay in
their own adapters, because those genuinely differ.

**Benefit.** Locality: a new failure class in the core is reported correctly by
both adapters with no edit in either.

---

## 3. The HTTP adapter writes responses in five places and logs in three

**Strength: Worth exploring. Applied.**

**Files:** `src/bridge/http.ts`.

**Problem.** `send` wrote the response, and each call site separately decided
whether to log. The 413 path logged nothing, so a rejected body left no trace.
The success and failure lines were built in two different shapes. The request
stream had no `error` handler, so a client that disconnected mid-body raised an
unhandled stream error.

**Solution.** `send(status, payload, note)` is the one place a response is
written and the one place a line is logged, so every answer produces exactly one
line with the same leading `METHOD URL -> status`. `readBody` funnels `end`,
`error` and over-size through one `done`, and a disconnect is reported the same
way an over-size body is.

**Benefit.** Locality: the log format and the "one line per request" rule are
each stated once. The existing test that counts lines now covers every path.

---

## 4. `--timeout` was carried as a string so one command could re-read it

**Strength: Worth exploring. Applied.**

**Files:** `src/cli/args.ts`, `src/cli/bridge.ts`.

**The judgement the brief asked for: keep the flag, sharpen the carrier.**

**Problem.** `--timeout` is milliseconds for every MCP command and seconds for
`bridge exec`. That split is correct and stays: the exec wire format and the
Python bridge both count in seconds, and a second flag name would put two
spellings of one idea on the command line.

The carrier was the defect. `args.ts` validated the value as a positive finite
number, stored it as `timeoutMs`, and also stored the original text as
`timeoutRaw`. `bridge.ts` then ran `Number(args.timeoutRaw)` a second time. That
second parse can only produce what the first one already produced, so its `NaN`
branch was unreachable defensive code, and `ParsedArgs` carried two fields whose
contents were always the same number in two spellings.

**Solution.** `timeoutRaw?: string` becomes `timeoutSeconds?: number`, set from
the same validated number in the same place as `timeoutMs`. `bridge exec` reads
`args.timeoutSeconds`. The helper in `bridge.ts` is deleted.

**Benefits.** The interface now states the true thing: one flag, one validation,
two fields whose names carry the unit. Locality: the unit choice is visible at
the one call site that makes it. No meaning changes for any command.

---

## 5. Process-tree kill on timeout

**Strength: Strong (correctness review). Applied as documentation only.**

**Files:** `src/bridge/exec.ts`.

**Finding.** The Windows branch is correct. `spawn(cmd, {shell: true})` on
Windows launches cmd.exe, and `child.kill()` would end cmd.exe and orphan the
program it started. The code instead runs `taskkill /pid N /T /F`, where `/T`
takes the descendants and `/F` does not ask. The smoke run confirms it: a
`ping -n 4 127.0.0.1` cut off at one second leaves no `ping.exe` behind.

The POSIX branch is also correct as written. `spawn` is given `detached: true`
when the platform is not win32, which makes the child a process-group leader
whose group id equals its pid, and `process.kill(-pid)` then reaches the whole
group. The fallback to `kill(pid)` covers a group that is already gone.

**Change.** No code change. The comment now states why `/T /F` is the right call,
states the link between `detached: true` and the negative pid, and marks the
POSIX branch as written from documented semantics and not exercised on the
Windows host this bridge serves. An unmarked untested branch reads as verified.

---

## 6. `PathMap` is already a deep module

**Strength: none. Recorded so a later pass does not re-suggest a change.**

**Files:** `src/bridge/path-map.ts`, `src/bridge/selftest.ts`.

Three methods, `toHost`, `rewriteCommand` and `toContainer`, hold all three
rewrite rules and the two guards that are the point of the contract. The module
constructs nothing, spawns nothing, and reads no configuration: a test builds one
from two strings. `path-map.test.ts` and `selftest.ts` both drive it with no
process. It needs nothing from this pass, and the requirement the brief places on
it is already met.

`runSelftest` stays a separate module rather than a `PathMap` method. It is the
disproof table ported from the Python bridge, it is data about the contract
rather than part of it, and folding it in would put test cases in the module
every caller loads.

---

## 7. The four subcommands build the same context, and that is right

**Strength: none. Recorded.**

**Files:** `src/cli/bridge.ts`.

`loadBridgeSettings` then `bridgeContext` runs at the top of all four
subcommands. The **deletion test** says this concentrates nothing: collapsing
them into one call in `cmdBridge` would save four lines and would force
`selftest`, which needs no timeout policy, through the same path as `serve`. Two
lines of composition are not a rule stated twice.

---

## 8. `bridge exec` reports a core failure as a generic exit 1

**Strength: Speculative. Not applied.**

**Files:** `src/cli/bridge.ts`, `src/cli/errors.ts`.

A `BridgeExecError` out of `cmdExec` is not a `CliError`, so `main` prints it and
returns exit 1. That is defensible: the exec surface already spends its exit code
on the child's exit code, and 1 is the right generic failure. Making it a
`CliError` would be tidier and would change no observable behaviour, so it buys
nothing today. Recorded rather than applied, because the brief holds exit codes
fixed and this is where a future change would land.

---

## What changed

- `src/bridge/exec.ts`: `execBridged` takes `unknown` and checks every field
  through a private `checkRequest`; it never throws synchronously. Added
  `bridgeErrorMessage`. The `killTree` comment states the Windows and the POSIX
  reasoning and marks the POSIX branch as unexercised here.
- `src/bridge/http.ts`: one `send` that writes and logs, a `readBody` that
  funnels end, error and over-size through one path, and no local error shaping.
- `src/bridge/mcp-server.ts`: passes tool arguments straight to the core and
  calls `bridgeErrorMessage`.
- `src/cli/args.ts`: `timeoutRaw?: string` becomes `timeoutSeconds?: number`.
- `src/cli/bridge.ts`: `execTimeoutS` deleted; `bridge exec` reads
  `args.timeoutSeconds`.
- Tests: eight added, covering request checking, the no-synchronous-throw
  invariant, `bridgeErrorMessage`, both `--timeout` units, and the two bad-body
  paths that used to end the HTTP server.

## What was deliberately left

- `src/bridge/path-map.ts` and `src/bridge/selftest.ts` are untouched
  (opportunity 6).
- The per-subcommand context construction in `src/cli/bridge.ts` (opportunity 7).
- The exit code `bridge exec` reports for a core failure (opportunity 8).
- `src/cli/config.ts` keeps the `bridge` block, its keys and its defaults exactly
  as they were.
- `src/cli/output.ts`, `errors.ts` and `index.ts` are untouched.

## Behaviour changes

Two, and both are failures that used to be worse.

1. A request with a wrongly typed `cwd` or `stdin` now answers HTTP 500 with a
   JSON error naming the field. It previously killed the server process.
2. A request whose JSON body is not an object now answers with
   `request must be a JSON object` instead of `cmd is required`.

The wire format, the exit codes, the `host_exec` schema, the config keys, the
defaults and every command name are unchanged.

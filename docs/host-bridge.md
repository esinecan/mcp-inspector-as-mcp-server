# The host bridge

`mcp-cli bridge` runs commands in a Windows `cmd.exe` shell for a client that
lives somewhere else. The usual client is an agent inside a container, such as
OpenHands, that needs a real Windows shell. This document is the long form; the
README carries the short one.

## Security

There is no allowlist. Anything that can reach the socket with the token can
run any command as you. Use it on one machine, let the Windows firewall prompt
be the boundary, and do not expose the port to a network you do not control.

A bridge bound to anything but loopback requires a bearer token on `/exec`.
`bridge.authTokenEnv` names the environment variable that holds it; the value
is read once at start, compared in constant time, and never written to the
config file, the log or a response. `bridge serve` refuses to start on a
network bind without a token name, or with a name whose variable is unset. A
loopback bind may go without. The health surfaces need no token, because they
say nothing a caller could not learn by connecting.

Two commands run at once and eight wait, in order; the ninth is answered 503
with `Retry-After: 1`, because a host shell that starts every command it is
sent is a host that can be flattened by a loop. Output is cut at
`maxOutputBytes` per stream, one mebibyte by default: the bytes past the cap
are counted, never buffered, and the result says how many were dropped.

## The path contract

One folder has two names. The client says `/workspace`, Windows says
`C:\Users\you\agent-workspace`. The bridge translates in three places.

**1. The working directory.** `cwd` maps by prefix. A request with no `cwd` runs
in the mapped container root.

**2. The command string.** Every container path inside the command becomes a
host path. Two guards keep that from over-reaching:

| Input | Result | Why |
| --- | --- | --- |
| `tool.exe /workspace/in.txt /workspace/out.txt` | both rewritten | each one is a path |
| `tool.exe --prefix=/workspace/x` | rewritten | a flag value is still a path |
| `dir /workspace` | rewritten | a bare root is a path |
| `tool.exe http://example.com/workspace/y` | untouched | the root is preceded by a slash, so it is part of a URL |
| `cat /workspace-foo` | untouched | the root is followed by a hyphen, so it is a longer name |

The lookbehind rejects a root preceded by a word character, a dot, a slash or a
hyphen. The lookahead on the bare form rejects a root followed by a word
character or a hyphen. The separator after a rewritten prefix becomes a
backslash.

**3. The output.** Host paths in stdout and stderr map back to container paths,
in both the backslash and the forward-slash spelling. The client therefore only
ever reads container paths.

A command that runs out of its budget returns exit 124, the partial stdout it
produced, and `timeout after Ns` as its stderr.

`mcp-cli bridge selftest` checks all of this and prints one row per case. The
six cases are the ones the Python bridge this replaces carried, unchanged.

## Config

A top-level `bridge` object in `~/.agents/mcp-cli.json`. Every key is optional
and falls back to the value shown:

```json
{
  "bridge": {
    "containerRoot": "/workspace",
    "hostRoot": "C:\\Users\\you\\agent-workspace",
    "port": 8790,
    "bind": "0.0.0.0",
    "defaultTimeout": 600,
    "maxTimeout": 3600,
    "authTokenEnv": "MCP_CLI_BRIDGE_TOKEN",
    "maxActive": 2,
    "maxQueued": 8,
    "maxOutputBytes": 1048576
  }
}
```

| Key | Meaning |
| --- | --- |
| `containerRoot` | the path the client uses. Must be absolute POSIX |
| `hostRoot` | the same folder on Windows. Must be absolute Windows |
| `port`, `bind` | the socket `bridge serve` listens on |
| `defaultTimeout` | seconds, used when a request names no timeout |
| `maxTimeout` | seconds. A request asking for more is clamped to this |
| `authTokenEnv` | the NAME of the environment variable holding the bearer token. Required when `bind` is not loopback |
| `maxActive` | commands running at once |
| `maxQueued` | requests waiting for a slot before the bridge answers 503 |
| `maxOutputBytes` | bytes kept per stream; the rest is cut and counted |

`--port` and `--bind` override the file. A bad root is a config error at load
time. The bridge runs on the defaults when the config file is absent, so a box
with no `mcp-cli.json` can still serve. `import-claude` leaves an existing
`bridge` block exactly as it found it.

## Subcommands

```bash
mcp-cli bridge selftest
# OK   rewrite both args -> "tool.exe C:\\Users\\you\\agent-workspace\\in.txt ..."
# exits 1 if any row says FAIL

mcp-cli bridge exec "type /workspace/hello.txt"
# hello from the host bridge
# exits with the command's own code

mcp-cli bridge serve --port 8790
# serves POST /exec and the three health surfaces, one log line per request on stderr
mcp-cli bridge serve --log C:\Users\you\.agents\mcp-cli-bridge.log
# the same, with the lines appended to a file; what the scheduled task runs

mcp-cli bridge mcp
# serves the host_exec tool over stdio, for an MCP client to register
```

`bridge exec` takes `--cwd`, `--stdin` and `--timeout`. `--timeout` is seconds
here, not milliseconds, because the bridge counts in seconds everywhere else.
`--stdin` takes the same three forms as tool arguments: inline text, `-` for
standard input, or `@path` for a file.

## Registering it with OpenHands

Start `mcp-cli bridge serve` on the host. From inside the container the host is
`host.docker.internal`, so one line does a whole command:

```bash
curl -s -X POST http://host.docker.internal:8790/exec \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $MCP_CLI_BRIDGE_TOKEN" \
  -d '{"cmd":"dir /workspace"}'
# {"exit":0,"stdout":" Directory of /workspace\r\n...","stderr":""}
```

The request body is `{cmd, cwd?, stdin?, timeout?}` and the response is
`{exit, stdout, stderr, truncated?}`. `GET /health/live`, `GET /health/ready`
and `GET /status` answer without a token; any other path or method answers
404. The wire format is the one the Python bridge served, plus the token
header on a network bind, so an existing client adds one header.

A command that fails is still a 200: its exit code is in `exit`. The other
statuses mean the request never became a process, and each one carries a JSON
body of `{"error": "..."}`:

| Status | Cause |
| --- | --- |
| 400 | the body is not JSON |
| 401 | the bearer token is missing or wrong |
| 413 | the body is over 4 MB, or the client disconnected part way through |
| 500 | the body is JSON but not a valid request, or the shell would not start |
| 503 | `maxActive` commands are running and `maxQueued` are waiting; `Retry-After: 1` |

The server answers all of these and keeps serving. Up to `maxActive` commands
run at once, so one slow command does not hold up the next, and the rest wait
in order.

## Registering the MCP adapter

`bridge mcp` is a stdio MCP server with one tool, `host_exec`. Its input is
`{cmd, cwd?, stdin?, timeout?}` and its result is the same JSON as the HTTP
surface, returned as text. A non-zero exit is a normal result, so `isError`
stays unset; it is set only when the bridge could not start the command at all.

Claude Code, Codex and mcp-cli all take the same block:

```json
{
  "mcpServers": {
    "bridge": { "command": "mcp-cli", "args": ["bridge", "mcp"] }
  }
}
```

Use `"command": "node"` with
`"args": ["C:/path/to/dist/cli/index.js", "bridge", "mcp"]` if the client
cannot resolve the `mcp-cli` shim on PATH.

```bash
mcp-cli tools bridge
# bridge.host_exec  Run a command in a cmd.exe shell on the Windows host...

mcp-cli call bridge.host_exec '{"cmd":"type /workspace/hello.txt"}'
```

## Narrowing it

The bridge filters no commands. Inspecting command text to decide what is safe
gives a boundary that is easy to walk around, and a host shell is the thing
being offered in the first place. The one narrowing that exists is the mcp-cli
profile blocklist, and it applies when the tool is reached through `mcp-cli
call`:

```bash
mcp-cli call bridge.host_exec '{"cmd":"dir /workspace"}' --profile nobridge
# mcp-cli: bridge.host_exec is blocked by profile "nobridge" (pattern "bridge.*")
# exit 3
```

A client that talks to `bridge mcp` over stdio, or to `POST /exec` directly,
does not pass through that blocklist.

## Module layout

`src/bridge/` holds the core and both adapters:

- `path-map.ts`: the three rewrites and the two guarded regular expressions. It
  spawns nothing and reads no configuration, so a test builds one from two
  strings.
- `exec.ts`: `execBridged`, the request checking, the timeout, and the
  process-tree kill.
- `selftest.ts`: the six cases.
- `http.ts`: `POST /exec` behind the token and the gate, plus the three health
  surfaces.
- `mcp-server.ts`: the `host_exec` tool over stdio.

`src/cli/bridge.ts` holds the four subcommand bodies. The HTTP adapter and the
MCP adapter are peers: both call `execBridged` directly, so the two surfaces
cannot drift apart.

`execBridged` takes an unchecked value and checks every field itself, because
both adapters hand it something read off a wire. `cmd`, `cwd` and `stdin` must
be strings; a `timeout` that is not a positive number means the default applies.
It never throws, so a bad request is a rejected promise and cannot end the HTTP
server. `bridgeErrorMessage` turns such a failure into the one sentence both
adapters report.

On a timeout the child is killed by process tree. On Windows that is
`taskkill /pid N /T /F`, because ending the cmd.exe that `spawn` starts would
leave the program it launched running. On other platforms the child is spawned
detached, which makes it a process-group leader, and the group is killed by
negative pid. The bridge serves a Windows host, so the Windows branch is the
tested one.

`docs/host-bridge-architecture-pass.md` records the design decisions behind this
layout.

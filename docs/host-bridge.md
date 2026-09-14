# The host bridge

`mcp-cli bridge` runs commands in a Windows `cmd.exe` shell for a client that
lives somewhere else. The usual client is an agent inside a container, such as
OpenHands, that needs a real Windows shell. This document is the long form; the
README carries the short one.

## Security

There is no authentication and no allowlist. Anything that can reach the socket
can run any command as you. Use it on one machine, let the Windows firewall
prompt be the boundary, and do not expose the port to a network you do not
control.

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
    "maxTimeout": 3600
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
# serves POST /exec and nothing else, one log line per request on stderr

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
  -d '{"cmd":"dir /workspace"}'
# {"exit":0,"stdout":" Directory of /workspace\r\n...","stderr":""}
```

The request body is `{cmd, cwd?, stdin?, timeout?}` and the response is
`{exit, stdout, stderr}`. Any other path or method answers 404. The wire format
is the one the Python bridge served, so an existing client needs no change.

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

- `path-map.ts`: the three rewrites and the two guarded regular expressions.
- `exec.ts`: `execBridged`, the timeout, and the process-tree kill.
- `selftest.ts`: the six cases.
- `http.ts`: `POST /exec`.
- `mcp-server.ts`: the `host_exec` tool over stdio.

`src/cli/bridge.ts` holds the four subcommand bodies. The HTTP adapter and the
MCP adapter are peers: both call `execBridged` directly, so the two surfaces
cannot drift apart.

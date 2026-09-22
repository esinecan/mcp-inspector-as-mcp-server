# Inspect retained results and check process execution

Use an exact tool address when you need one argument schema. If you already know the arguments, call the tool directly.

```powershell
mcp-cli tools records.read --schema --json
mcp-cli call records.read --args-file read-args.json --json --envelope-version 2
```

The default envelope remains version 1. Version 2 returns an object in `result`, with `kind` identifying JSON, text, blocks, an outline, selections, or excerpts. A failed upstream tool remains failed even when its output contains matching passages. A search miss says `no_match` and does not mean the source lacks the answer.

## Read only the fields and passages you need

Every call retains the original MCP response before rendering. When a response is too large, follow its `next.argv` action or the printed spill hint. The reference below is an example. Substitute the reference returned by your call.

```powershell
mcp-cli spill query 0123456789abcdef --json
mcp-cli spill query 0123456789abcdef --select /record/name --select /record/updated --query 'Node PATH zstd' --json
mcp-cli spill query 0123456789abcdef --within /record/body --query 'keep-alive' --json
mcp-cli spill query 0123456789abcdef --within record/body --query 'keep-alive' --json   # Git Bash
mcp-cli spill get 0123456789abcdef
```

Pointers address the logical payload, outside the CLI envelope. Structured content takes precedence, followed by a single JSON text block, plain text, or an array of MCP blocks. Original blocks remain in the retained source record. Existing text spills can still be queried or read in full.

Selections report `complete`, `missing`, or `deferred`. A present JSON null remains null. An oversized selection returns a reference instead of a clipped value. Omit both selection and query to inspect an outline with paths, types, counts, and text headings.

A pointer may be written `/record/body`, `#/record/body` or `record/body`; the CLI reads the three as one RFC 6901 pointer, and its hints use the last spelling because Git Bash (MSYS) rewrites an argument that starts with `/` or `#/` as a Windows path. A rewritten path is refused with a message that names the slash-free spelling. Search uses words, not natural-language reasoning. Hits contain verbatim text, the source reference, a pointer, and a block index when applicable. `start` and `end` use UTF-16 code units in the decoded string, with an exclusive end. They are not byte offsets into JSON. A hit marked `windowed` is a bounded excerpt of a longer passage. An excerpt's edges sit on word boundaries: a window that would open or close inside a word is moved to the nearest boundary within 160 code units, so a passage never starts or ends with a fragment of a word. `result.total` is the number of items in the whole answer before paging, the same on every page.

The default budget is 4096 UTF-8 bytes, including the pretty-printed response and its newline. `--max-bytes` accepts 1024 through 1048576. A response with `more:true` includes a cursor. Repeat the same selection, scope, and query with `--cursor` to continue. The budget may change between pages. An empty query is an error. Omit it to request an outline.

Retrieval reads the local store and makes no upstream request. It never prunes its own response into another spill. The MCP inspector exposes the same implementation as `result_query`, using the spill directory selected by `MCP_CLI_CONFIG`.

`spill get` returns the retained file in full. Canonical source files contain the original MCP response and provenance. Legacy and derived text files retain their original contents. Derived files have sidecars linking them to their source. Only explicit `spill prune --older-than DAYS` removes retained files.

## Run a native program with checked arguments

Write a request file, then pass it to the bridge. `timeout` is in seconds, as in the existing bridge protocol.

```json
{
  "mode": "process",
  "executable": "node",
  "argv": ["-e", "console.error('warning'); process.exit(7)"],
  "cwd": "/workspace",
  "timeout": 10,
  "acceptedExitCodes": [0]
}
```

```powershell
mcp-cli bridge exec --request-file request.json --json
```

Process mode launches without a shell. Arguments arrive literally. `cwd` and executable paths use the configured path map. Add zero-based `pathArgIndexes` only for arguments that are paths. Code, JSON, URLs, and other arguments are left untouched. Windows `.cmd` and `.bat` files need an explicit shell request. For npm tools, invoke Node with the underlying JavaScript entry point.

Read `execution.status` for success or failure and `execution.exitCode` for the actual child exit. Accepted nonzero exits return CLI exit 0 while preserving the child code in JSON. Warning text on stderr does not imply failure. Timeout, cancellation, signals, and spawn errors have separate statuses. The HTTP and MCP adapters accept the same requests. MCP retains its existing convention that a child nonzero exit is an ordinary tool result, so callers must inspect `execution.status`.

`bridge exec --json` returns the bridge result directly, with `execution` at the top level. It does not use the `{ok,result}` envelope for MCP calls. An unexpected child exit is propagated as the CLI exit code; for example, exit 7 remains 7.

## Check a sequence

```json
{
  "mode": "batch",
  "steps": [
    { "mode": "process", "executable": "node", "argv": ["-e", "process.exit(7)"] },
    { "mode": "process", "executable": "node", "argv": ["-e", "console.log('later')"] }
  ]
}
```

The bridge validates every step before starting and stops after the first unexpected failure. Set `continueOnError:true` to collect later results. Aggregate status remains failed even if the last step succeeds. Steps run as separate processes and share no shell variables. A batch accepts at most 100 steps.

Legacy `{ "cmd": "..." }` requests retain their shell behavior. `statusScope:"shell"` covers only the outer shell. An intermediate command can fail before a later command makes the shell exit 0. Process mode checks each native invocation directly.

## Preserve evidence

Raw stdout and stderr are captured before decoding or path rewriting. Each capture reports its local file path, SHA-256, retained and observed byte counts, and completeness. Display previews are separate. A complete capture preserves binary bytes, including output beyond the display limit and stderr written before a timeout.

The `bridge` config accepts `captureDir`, `maxCaptureBytes`, and `maxCaptureTotalBytes`. Defaults are the user directory `.agents/mcp-cli-capture`, 64 MiB per stream, and 1 GiB total. Capture contention, exhausted storage limits, or write errors mark the artifact incomplete while preserving the process result. Inspect both execution and capture status when collecting evidence. A stale `.capture-lock` after a killed writer requires operator recovery after checking that no writer is active.

```powershell
mcp-cli bridge prune-captures --older-than 7
```

Capture pruning is explicit. The existing HTTP bearer requirement, execution queue, profile restrictions, and process timeouts still apply.

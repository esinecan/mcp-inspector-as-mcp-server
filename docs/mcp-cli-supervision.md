# mcp-cli request supervision

Every command that reaches a server goes through one executor. The executor
takes an operation, not a callback, and owns everything between the command
and the server: the queue, the deadline, the classification of a failure,
the one retry a read may take, the circuits that remember failures across
processes, and the event log. A command asks for a result and gets a result
or a report. It coordinates nothing itself.

## The seam

```ts
const executed = await executor.execute("google-search", {
  kind: "callTool",
  name: "google_search",
  args: { query: "berlin" },
});
executed.value; // the server's answer, unchanged
executed.attempts; // 1 or 2
executed.failure; // set when the answer itself reports a failure
```

The seven operations are data: `info`, `listTools`, `callTool`, `listResources`,
`readResource`, `listPrompts`, `getPrompt`. A callback could hold a write, and
the executor may retry, so it is never handed one.

Behind the executor stand lanes. The ephemeral lane launches the server in
this process and keeps the session for the rest of the command, so a `call`
that lists the tools and then calls one launches the server once. The daemon
lane forwards one operation per request to the warm daemon. A scripted lane
answers from a script, for tests. The executor chooses the lane: the daemon
first, the ephemeral lane when no daemon answers, and a refusal when the
server is configured `daemonRequired`.

## Failure classes

Every failure is sorted into one of eight classes, from the class it already
carries (the daemon's envelope, a provider's `kind`), else from its JSON-RPC
code, else from its text.

| Class           | Meaning                                                     | Retried             | Opens                              |
| --------------- | ----------------------------------------------------------- | ------------------- | ---------------------------------- |
| `auth_required` | credentials refused, expired, or an unset `${VAR}`          | no                  | the server circuit, at once        |
| `rate_limited`  | 429, quota, Google's `/sorry/` page                         | after Retry-After   | the server circuit, at once        |
| `transient`     | connection closed, refused, reset, 502/503                  | once, reads only    | the server circuit, after three    |
| `timeout`       | the budget passed                                           | once, reads only    | counts as transient                |
| `structural`    | method not found, schema drift, unexpected shape            | no                  | a request circuit for that request |
| `bad_argument`  | invalid params, validation failed                           | no                  | nothing                            |
| `blocked`       | refused before dispatch: profile, circuit, queue, limit     | no                  | nothing                            |
| `unsafe_retry`  | a write-capable call failed with the outcome unknown        | never               | counts as transient                |

A successful answer that reports a failure in its body, `isError` or a `kind`
field, is classified the same way. The answer is still returned to the caller
unchanged; the class sits beside it, and the policy acts on it.

## Retry safety

Whether a second attempt is allowed is decided from what the operation is,
never from what went wrong. The six built-in reads are safe. A tool call is
safe when the tool carries `readOnlyHint` or the server's rule names it in
`readOnlyTools`. Everything else, an unknown tool included, gets exactly one
attempt, and a transient failure or a timeout on it is reported as
`unsafe_retry` with the original class as `cause`. A safe operation gets at
most two attempts in total, with a Retry-After honoured when the failure named
one and a jittered backoff otherwise. A wait that would outlive the deadline
is not taken; the failure is reported instead.

## Queue and deadline

One operation runs at a time per server, and up to thirty-two wait in order.
The thirty-third is refused at once with `queue_full`. Waiting counts against
the operation's deadline: an operation whose deadline passes while it waits
fails as a `timeout` with `attempts: 0`, and the server is never asked. The
deadline is `--timeout`, else the rule's `deadlineMs`, else sixty seconds.

The daemon keeps the same queue for the processes that share it, with the
same limits from the same config file, and tells the caller when a refusal
happened before dispatch, so a queued write that timed out is a `timeout`,
not an `unsafe_retry`.

## Circuits

A server circuit refuses every operation against one server. It opens at once
on `auth_required` and `rate_limited`, and after three consecutive transient
failures. The first cooldown is sixty seconds, or the Retry-After when one was
named; each failure while open doubles it, up to fifteen minutes. After the
cooldown one probe goes through; success closes the circuit, failure reopens
it for twice as long. An auth circuit also closes when the credentials it saw
fail change, which the executor detects from a fingerprint of the `${VAR}`
values the entry resolves.

A request circuit refuses one exact request: the same server, target and
argument digest. It opens on a structural failure, so a request the server
cannot take is not sent again unchanged during its cooldown, while a changed
request is tried. This is the exclusion that stops an agent from re-sending
the same broken payload until its budget is gone.

Circuits live in `~/.agents/mcp-cli-state/circuits.json`, because every
`mcp-cli` invocation is a new process. The file holds the class, a redacted
message of bounded length, the digest of that message, counts, timestamps,
the remediation, and the argument digest of an excluded request. It never
holds an argument, a credential, or a returned content block.

```bash
mcp-cli circuits status            # every open or counting circuit
mcp-cli circuits status google-search
mcp-cli circuits reset google-search   # after renewing credentials, say
mcp-cli circuits reset             # everything
```

## Refusals before dispatch

| Reason            | When                                                              | Exit |
| ----------------- | ----------------------------------------------------------------- | ---- |
| `profile`         | the blocklist covers the address                                  | 3    |
| `circuit_open`    | the server circuit is open                                        | 4    |
| `excluded`        | this exact request already failed structurally                    | 4    |
| `queue_full`      | the server's queue is at its bound                                | 4    |
| `daemon_required` | the server is `daemonRequired` and no daemon answers              | 4    |
| `request_limit`   | the arguments exceed the server's `maxArgumentBytes`              | 4    |

Exit code 4 means the server was not asked. An agent that sees it should not
repeat the call unchanged; the report says when it may.

## The report

In text mode a failure is one line on stderr with the message, and a second
with the class, the server, the attempts, the trace id and the next move.
Under `--json` it is one JSON object on stdout:

```json
{
  "ok": false,
  "error": {
    "class": "rate_limited",
    "message": "google-search: Google served /sorry/",
    "server": "google-search",
    "operation": "callTool",
    "target": "google_search",
    "attempts": 1,
    "trace": "t_3f9a1c2b7d4e",
    "elapsedMs": 812,
    "retryAfterMs": 60000,
    "remediation": "The provider is rate limiting. Wait for the cooldown; the circuit reopens on its own.",
    "lane": "daemon",
    "circuit": { "kind": "server", "state": "open", "until": "2026-09-18T15:04:05.000Z", "cooldownMs": 60000, "failures": 1 }
  },
  "exitCode": 1
}
```

A successful result is printed exactly as it always was; the envelope exists
only on failure.

## Events

Every decision is one JSON line in `~/.agents/mcp-cli-state/events.jsonl`,
keyed by the trace id of the operation: `queued`, `attempt`, `failed`, `retry`,
`session_invalidated`, `refused`, `succeeded`, `circuit_opened`,
`circuit_closed`. A failed attempt carries the class and the digest of its
redacted message, never the message of a request. Set
`supervision.eventLog` to `false` to turn the log off.

## Configuration

```json
{
  "supervision": {
    "defaults": {
      "deadlineMs": 60000,
      "concurrency": 1,
      "queueLength": 32,
      "maxAttempts": 2,
      "transientTripAfter": 3,
      "cooldownMs": 60000,
      "cooldownMaxMs": 900000,
      "backoffMs": [250, 2000]
    },
    "rules": {
      "google-search": { "daemonRequired": true, "readOnlyTools": ["google_*"] },
      "cortex": { "daemonRequired": true },
      "web-surfer-llm": { "maxArgumentBytes": 16384, "deadlineMs": 600000 }
    },
    "stateDir": "C:\\Users\\you\\.agents\\mcp-cli-state",
    "eventLog": "C:\\Users\\you\\.agents\\mcp-cli-state\\events.jsonl"
  },
  "routes": { "search": { "primary": "google-search", "fallback": "brave-search" } },
  "daemon": { "port": 8791, "prewarm": ["cortex", "flaui", "google-search", "memory-store"] }
}
```

Every key is optional and a config file that has never heard of any of them
still loads. A rule may name only a configured server. `maxAttempts` may not
exceed two. `readOnlyTools` are globs over the tool name, `*` covering any run
of characters.

## The search route

`mcp-cli search <query>` runs Google through the executor and, when Google
cannot answer, Brave. Every class but one sends the query on: a rate limit, an
expired login, a stale extractor, an exhausted connection, an open circuit. A
`bad_argument` does not, because the fault is in the query. The rows have one
shape from either provider, `{title, url, snippet, date?}`, and the outcome
says who answered:

```json
{
  "query": "berlin wohnung",
  "provider": "brave-search",
  "degraded": true,
  "attempts": [
    { "provider": "google-search", "ok": false, "class": "rate_limited", "message": "...", "ms": 640, "trace": "t_..." },
    { "provider": "brave-search", "ok": true, "rows": 10, "ms": 380, "trace": "t_..." }
  ],
  "rows": [{ "title": "...", "url": "https://...", "snippet": "...", "date": "2 days ago" }],
  "diagnostics": { "primary": "google-search", "fallback": "brave-search", "fellBackBecause": "google-search rate_limited: ..." }
}
```

`--provider <server>` names one provider and skips the route. `--limit <n>`
caps the rows. When both providers fail, the envelope carries every attempt.

## Modules

```
src/supervise/
  executor.ts       McpExecutor: execute, status, reset, close
  operation.ts      the seven operations as data
  classify.ts       the eight classes, from envelope, code or text
  policy.ts         retry safety, attempts, backoff, the auth fingerprint
  circuits.ts       server and request circuits, cooldowns, half-open probes
  store.ts          the circuit file, written atomically
  queue.ts          one bounded FIFO gate per server
  events.ts         the JSONL log and the trace id
  redact.ts         what may be persisted about a failure
  errors.ts         SupervisedError and the report
  ephemeral-lane.ts the lane that launches the server here
  daemon-lane.ts    the lane that forwards to the warm daemon
  scripted-lane.ts  the lane a test drives
src/search/
  provider.ts       the SearchProvider port and the row shape
  google.ts, brave.ts, route.ts
```

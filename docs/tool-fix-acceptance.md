# Tool-fix acceptance contract

Frozen before implementation, 2026-09-22. Tests cross the CLI, query, execution,
and MCP interfaces. Historical pilot artifacts are evidence, not editable fixtures.

| ID | Required observation |
| --- | --- |
| Q1 | Decoded JSON body matches return verbatim evidence and exact metadata within 4096 serialized UTF-8 bytes. |
| Q2 | Missing, null, deferred values, and no matches are distinct. Huge arrays and long lines cannot escape the budget. |
| Q3 | Source bytes remain immutable; retrieval cannot call upstream; cursor use is deterministic and bound to source/query/version. |
| Q4 | Mixed blocks retain identity; image base64 is not searched. Legacy spills remain readable. |
| C1 | Exact schema returns one tool, no callTool, with profile rules and a complete cache. Unknown target fails compactly. |
| C2 | V1 types remain compatible. V2 has an object result and upstream failures remain failures. |
| C3 | Fallback reports a typed reason only after success; required-daemon and failed-fallback paths never announce success. |
| E1 | Process argv is literal, exit 7 remains 7, accepted exit 1 succeeds, warning stderr alone does not fail. |
| E2 | Batch failure cannot be hidden by a later success; default stops and continuation retains aggregate failure. |
| E3 | Raw Unicode/binary bytes and original timeout stderr survive capture; quota loss is explicit. |
| E4 | Spawn, cancellation, timeout and process-tree cleanup are observable through CLI/HTTP/MCP without changing authorization. |
| P1 | Fresh Pi retrieval session follows targeted hints and supplies correct facts without full spill get. |
| P2 | Fresh Pi execution session correctly distinguishes checked failure, accepted exit, batch behavior and shell scope. |

Release requires lint, typecheck, formatting, tests, build, interface smoke checks,
and both focused Pi scenarios on the final candidate. No app rebuild or Pi-core patch.

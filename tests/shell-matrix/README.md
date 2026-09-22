# Shell matrix

Five caller-facing fixes, each checked through every shell a caller on this box
can use. A cell passes when the shell hands back the fixed contract; the
baseline shows the defects as observed in pilot-05 (2026-09-22), the candidate
must show every cell passing before release.

Run: `npm run build`, then `node scripts/shell-matrix.mjs baseline` or
`node scripts/shell-matrix.mjs candidate`. The script writes `baseline.json` or
`candidate.json` beside this file with stdout bytes, stderr bytes and exit code
for every cell, and exits 1 on a candidate with any failing cell.

## Shells

| Shell                  | Binary                                                      | Present on this box |
| ---------------------- | ----------------------------------------------------------- | ------------------- |
| cmd.exe                | `C:\Windows\System32\cmd.exe`                               | yes                 |
| Windows PowerShell 5.1 | `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` | yes                 |
| Git Bash 5.2.37 (MSYS) | `C:\Program Files\Git\bin\bash.exe`                         | yes                 |
| PowerShell 7 (`pwsh`)  | not installed                                               | no                  |
| macOS zsh/bash         | deferred                                                    | no                  |

## Fixes and their contracts

| Id  | Fix                                | Pass condition read from the shell's output                                                                                                                                                                                                                                                               |
| --- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | `--arg key=value`                  | `--json call frozen.read --arg name=pi-stack` returns `ok:true` with no argument file on disk                                                                                                                                                                                                             |
| F2  | one error report under `--json`    | `--json call frozen.read --args-file <missing>` writes one envelope to stdout, 0 bytes to stderr, exit 2                                                                                                                                                                                                  |
| F3  | one ref and one `next`             | the withheld-body envelope has `spill` absent or equal to `source.ref`, and `next.argv` contains `--within`                                                                                                                                                                                               |
| F4  | excerpt boundaries and match total | `spill query <ref> --within <body> --query "pi 0.85.1"` returns `result.total` and no excerpt ending inside a word                                                                                                                                                                                        |
| F5  | pointer aliases                    | `--within /record/body`, `record/body` and `#/record/body` all return the outline in cmd.exe and PowerShell; under Git Bash the `/` and `#/` forms arrive as drive paths (MSYS rewrite), so those cells pass when the CLI names the rewrite and the slash-free fix, and `record/body` returns the outline |

## Baseline, mcp-cli 2.1.0 at `6fcb389`

| Shell                  | F1                          | F2                     | F3                                        | F4                                           | F5                                           |
| ---------------------- | --------------------------- | ---------------------- | ----------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| cmd.exe                | fail: `Unknown flag: --arg` | fail: stderr 247 bytes | fail: two refs, `next` without `--within` | fail: no `total`, 1 mid-word cut             | fail: only `/record/body` accepted           |
| Windows PowerShell 5.1 | fail: `Unknown flag: --arg` | fail: stderr 247 bytes | fail: two refs, `next` without `--within` | fail: no `total`, 1 mid-word cut             | fail: only `/record/body` accepted           |
| Git Bash               | fail: `Unknown flag: --arg` | fail: stderr 247 bytes | fail: two refs, `next` without `--within` | fail: `Invalid JSON Pointer` (blocked by F5) | fail: all three forms `Invalid JSON Pointer` |

Notes on the baseline run:

- Every F2 cell exits 2 with the same 247-byte stderr line that the JSON envelope on stdout already carries.
- `powershell.exe -Command` reports exit 1 for any failed last command; the script appends `; exit $LASTEXITCODE` so the CLI's own exit code is what the cell records.
- Under Git Bash, F4 cannot run until F5 lands, because its `--within` argument is a pointer; the script uses the `record/body` form for bash and the `/record/body` form elsewhere.
- The frozen server is `frozen-server.mjs` beside this file, answering `read {"name":"pi-stack"}` with `record.json` (19,074 bytes, body 18,432 bytes). The daemon is off for every cell (`MCP_CLI_DAEMON=0`), so each call is a fresh stdio connection.

## Candidate

Written by `node scripts/shell-matrix.mjs candidate` as `candidate.json`. Release
requires all fifteen cells passing.

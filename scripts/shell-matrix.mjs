#!/usr/bin/env node
/**
 * Shell matrix: run the built CLI through each shell on this box and record
 * what each shell hands back for the caller-facing fixes F1 to F5.
 *
 *   node scripts/shell-matrix.mjs baseline     -> tests/shell-matrix/baseline.json
 *   node scripts/shell-matrix.mjs candidate    -> tests/shell-matrix/candidate.json
 *
 * Shells: cmd.exe, Windows PowerShell 5.1 (powershell.exe), Git Bash. Each case
 * is one argv; the script quotes it the way that shell needs and spawns the
 * shell, so what reaches the CLI is what a caller typing in that shell would
 * get, MSYS path rewriting included. The frozen server beside the fixtures is
 * the only MCP server; the daemon is off so every call is a fresh connection.
 *
 * A cell passes when the observed output meets the fixed contract for that fix.
 * On the baseline the failing cells are the findings; on a candidate every
 * cell must pass.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = join(ROOT, "tests", "shell-matrix");
const TMP = join(FIX, ".tmp");
const CLI = join(ROOT, "dist", "cli", "index.js");
const NODE = process.execPath;
const label = process.argv[2] ?? "candidate";

if (!existsSync(CLI)) {
  console.error(`shell-matrix: ${CLI} is missing; run npm run build first`);
  process.exit(2);
}

rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, "spill"), { recursive: true });
mkdirSync(join(TMP, "state"), { recursive: true });
const config = join(TMP, "config.json");
writeFileSync(
  config,
  JSON.stringify(
    {
      mcpServers: { frozen: { command: NODE, args: [join(FIX, "frozen-server.mjs")] } },
      profiles: { default: { block: [] } },
      pruning: { spillDir: join(TMP, "spill") },
      supervision: { stateDir: join(TMP, "state") },
    },
    null,
    2,
  ),
);
const argsFile = join(TMP, "args.json");
writeFileSync(argsFile, '{"name":"pi-stack"}');
const missingFile = join(TMP, "missing.json");
const bodyLength = JSON.parse(readFileSync(join(FIX, "record.json"), "utf8")).record.body.length;

const env = { ...process.env, MCP_CLI_CONFIG: config, MCP_CLI_DAEMON: "0" };

/* ------------------------------------------------------------ shells -- */

const shells = {
  cmd: {
    name: "cmd.exe",
    quote: (t) => (/^[A-Za-z0-9_./:=#~-]+$/.test(t) ? t : `"${t.replace(/"/g, '\\"')}"`),
    run: (line) => spawnSync("cmd.exe", ["/d", "/s", "/c", `"${line}"`], { env, windowsVerbatimArguments: true }),
  },
  powershell: {
    name: "Windows PowerShell 5.1",
    quote: (t) => `'${t.replace(/'/g, "''")}'`,
    run: (line) =>
      // powershell.exe -Command exits 1 for any failed last command; exit
      // $LASTEXITCODE hands the native exit code through unchanged.
      spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", `& ${line}; exit $LASTEXITCODE`],
        { env },
      ),
  },
  bash: {
    name: "Git Bash",
    quote: (t) => `'${t.replace(/'/g, "'\\''")}'`,
    run: (line) => spawnSync("C:\\Program Files\\Git\\bin\\bash.exe", ["-c", line], { env }),
  },
};

function invoke(shell, argv) {
  const s = shells[shell];
  const line = [NODE, CLI, ...argv].map(s.quote).join(" ");
  const r = s.run(line);
  const stdout = r.stdout ? r.stdout.toString("utf8") : "";
  const stderr = r.stderr ? r.stderr.toString("utf8") : "";
  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = undefined;
  }
  return {
    argv,
    line,
    exit: r.status,
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    stdout_head: stdout.slice(0, 400),
    stderr_head: stderr.slice(0, 400),
    json,
  };
}

/* ------------------------------------------------------------- cases -- */

const endsInsideWord = (text) => /[\p{L}\p{N}]$/u.test(text);

const cases = {
  F2: {
    title: "one error report under --json",
    run: (shell) => {
      const r = invoke(shell, ["--json", "call", "frozen.read", "--args-file", missingFile]);
      r.pass = r.stderr_bytes === 0 && r.json?.ok === false && r.exit === 2;
      r.note = r.pass ? "envelope only" : `stderr ${r.stderr_bytes} bytes, exit ${r.exit}`;
      return r;
    },
  },
  F3: {
    title: "one ref and one next",
    run: (shell, state) => {
      const r = invoke(shell, ["--json", "call", "frozen.read", "--args-file", argsFile]);
      const j = r.json ?? {};
      state.ref = j.source?.ref;
      const oneRef = j.spill === undefined || j.spill === j.source?.ref;
      const nextReaches = Array.isArray(j.next?.argv) && j.next.argv.includes("--within");
      r.pass = j.ok === true && oneRef && nextReaches;
      r.note = j.ok !== true ? "call failed" : `oneRef=${oneRef} nextHasWithin=${nextReaches}`;
      return r;
    },
  },
  F1: {
    title: "quote-free --arg",
    run: (shell) => {
      const r = invoke(shell, ["--json", "call", "frozen.read", "--arg", "name=pi-stack"]);
      r.pass = r.json?.ok === true;
      r.note = r.pass ? "ok" : (r.json?.error?.message ?? r.stderr_head).slice(0, 120);
      return r;
    },
  },
  F4: {
    title: "excerpt boundaries and match total",
    run: (shell, state) => {
      if (!state.ref) return { skipped: "no ref from F3", pass: false };
      const within = shell === "bash" ? "record/body" : "/record/body";
      const r = invoke(shell, ["spill", "query", state.ref, "--within", within, "--query", "pi 0.85.1"]);
      const items = r.json?.result?.items ?? [];
      const total = r.json?.result?.total;
      const cut = items.filter((i) => typeof i.text === "string" && endsInsideWord(i.text) && i.end !== bodyLength);
      r.pass = r.json?.ok === true && Number.isInteger(total) && items.length > 0 && cut.length === 0;
      r.note =
        r.json?.ok !== true
          ? (r.json?.error?.message ?? r.stderr_head).slice(0, 120)
          : `total=${total} items=${items.length} midWordCuts=${cut.length}`;
      return r;
    },
  },
  F5: {
    title: "pointer aliases",
    run: (shell, state) => {
      if (!state.ref) return { skipped: "no ref from F3", pass: false };
      const forms = ["/record/body", "record/body", "#/record/body"];
      const runs = forms.map((form) => {
        const r = invoke(shell, ["spill", "query", state.ref, "--within", form]);
        r.form = form;
        r.pass = r.json?.ok === true && r.json?.result?.kind === "outline";
        r.note = r.pass ? "outline" : (r.json?.error?.message ?? r.stderr_head).slice(0, 80);
        return r;
      });
      return {
        forms: runs,
        pass: runs.every((x) => x.pass),
        note: runs.map((x) => `${x.form}:${x.pass ? "ok" : x.note}`).join(" | "),
      };
    },
  },
};

/* --------------------------------------------------------------- run -- */

const order = ["F2", "F3", "F1", "F4", "F5"];
const table = { label, when: new Date().toISOString(), node: process.version, cli: CLI, shells: {} };
for (const shell of Object.keys(shells)) {
  const state = {};
  table.shells[shell] = { name: shells[shell].name, cases: {} };
  for (const id of order) {
    const r = cases[id].run(shell, state);
    delete r.json;
    if (r.forms) for (const f of r.forms) delete f.json;
    table.shells[shell].cases[id] = { title: cases[id].title, ...r };
  }
}

const out = join(FIX, `${label}.json`);
writeFileSync(out, JSON.stringify(table, null, 2) + "\n");

const width = 24;
console.log(`shell matrix (${label})`);
console.log("shell".padEnd(width) + order.map((id) => id.padEnd(8)).join(""));
for (const [shell, row] of Object.entries(table.shells)) {
  console.log(
    row.name.padEnd(width) + order.map((id) => (row.cases[id].pass ? "pass" : "FAIL").padEnd(8)).join(""),
  );
}
for (const [shell, row] of Object.entries(table.shells))
  for (const id of order) console.log(`  ${shell}/${id}: ${row.cases[id].note ?? row.cases[id].skipped}`);
console.log(`written ${out}`);
const allPass = Object.values(table.shells).every((row) => order.every((id) => row.cases[id].pass));
process.exit(label === "baseline" ? 0 : allPass ? 0 : 1);

/**
 * One affordance shared by every bounded result view. argv is authoritative.
 *
 * The pointer is written without its leading slash, `record/body`, because
 * that spelling survives every shell on Windows: Git Bash rewrites an argument
 * that starts with `/` as a path, and cmd.exe and PowerShell pass either form
 * through. The CLI reads `record/body`, `/record/body` and `#/record/body` as
 * the same pointer.
 */
export function spillHint(ref: string, within?: string) {
  const scope = within?.replace(/^#?\//, "");
  const argv = ["spill", "query", ref, ...(scope ? ["--within", scope] : [])];
  // Single quotes with doubled quotes are literal in PowerShell, including $ and `.
  const quote = (s: string) => (/^[a-zA-Z0-9_./:-]+$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`);
  return { command: "mcp-cli", argv, text: `mcp-cli ${argv.map(quote).join(" ")}` };
}

export function pointerToken(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

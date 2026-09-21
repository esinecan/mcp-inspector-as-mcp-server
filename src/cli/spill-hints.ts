/** One affordance shared by every bounded result view. argv is authoritative. */
export function spillHint(ref: string, within?: string) {
  const argv = ["spill", "query", ref, ...(within !== undefined ? ["--within", within] : [])];
  // Single quotes with doubled quotes are literal in PowerShell, including $ and `.
  const quote = (s: string) => (/^[a-zA-Z0-9_./:-]+$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`);
  return { command: "mcp-cli", argv, text: `mcp-cli ${argv.map(quote).join(" ")}` };
}

export function pointerToken(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

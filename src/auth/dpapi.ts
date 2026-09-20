/**
 * The Windows cipher: DPAPI in the current user's scope, reached through
 * PowerShell because Node ships no binding for it.
 *
 * The data crosses to PowerShell on standard input as base64 and comes back
 * the same way. Nothing secret is ever on the command line, where any process
 * of any user could read it from the process table. The entropy is the
 * SHA-256 of the server URL, so a blob copied under another server's name
 * does not open.
 *
 * One PowerShell start costs a few hundred milliseconds. The CLI pays it once
 * per process and the daemon once per warm entry; both are measured in the
 * evidence and both are acceptable for a login-grade operation.
 */

import { spawn } from "child_process";
import type { CredentialCipher } from "./store.js";

export class DpapiError extends Error {}

/** What runs PowerShell. Replaced by a fake in tests. */
export type PowerShellRunner = (
  script: string,
  stdin: string,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** The script is fixed text; the mode is spliced in, the data never is. */
const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Security",
  "$mode = '__MODE__'",
  "$in = [Console]::In.ReadToEnd().Trim()",
  "$parts = $in.Split('.')",
  "$entropy = [Convert]::FromBase64String($parts[0])",
  "$data = [Convert]::FromBase64String($parts[1])",
  "$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser",
  "if ($mode -eq 'protect') {",
  "  $out = [Security.Cryptography.ProtectedData]::Protect($data, $entropy, $scope)",
  "} else {",
  "  $out = [Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, $scope)",
  "}",
  "[Console]::Out.Write([Convert]::ToBase64String($out))",
].join("\n");

export const defaultRunner: PowerShellRunner = (script, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
    child.stdin.end(stdin, "utf8");
  });

/** The DPAPI cipher. `runner` is the seam a test replaces. */
export function dpapiCipher(runner: PowerShellRunner = defaultRunner): CredentialCipher {
  const run = async (mode: "protect" | "unprotect", data: Buffer, entropy: Buffer) => {
    const script = SCRIPT.replace("__MODE__", mode);
    const stdin = `${entropy.toString("base64")}.${data.toString("base64")}`;
    let result: Awaited<ReturnType<PowerShellRunner>>;
    try {
      result = await runner(script, stdin);
    } catch (err) {
      throw new DpapiError(`powershell.exe could not be started: ${(err as Error).message}`);
    }
    if (result.code !== 0) {
      const line = result.stderr.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "no detail";
      throw new DpapiError(`DPAPI ${mode} failed: ${line.trim().slice(0, 160)}`);
    }
    const text = result.stdout.trim();
    if (!/^[A-Za-z0-9+/=]+$/.test(text)) throw new DpapiError(`DPAPI ${mode} returned no data`);
    return Buffer.from(text, "base64");
  };
  return {
    name: "dpapi",
    protect: (plain, entropy) => run("protect", plain, entropy),
    unprotect: (blob, entropy) => run("unprotect", blob, entropy),
  };
}

/**
 * The path contract between a container view and the Windows host.
 *
 * One folder has two names. The agent says `/workspace`, Windows says
 * `C:\Users\you\agent-workspace`. Three places need the translation, and each
 * one has a different rule:
 *
 *   1. `cwd`, which is a whole path and maps by prefix.
 *   2. The command string, where a container path is one token among many and
 *      must be told apart from a URL path or a longer name.
 *   3. Output, where a host path has leaked and must be hidden again.
 *
 * The guards in `rewriteCommand` are the whole point of the module. A bare
 * substring replacement would rewrite `http://example.com/workspace/y` and
 * `/workspace-foo`, and both are wrong.
 */

import { win32 } from "path";

export interface PathMapOptions {
  /** The path as the agent sees it. Absolute POSIX, e.g. `/workspace`. */
  containerRoot: string;
  /** The same folder on Windows, e.g. `C:\Users\you\agent-workspace`. */
  hostRoot: string;
}

/** Escape a literal string for use inside a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class PathMap {
  readonly containerRoot: string;
  readonly hostRoot: string;

  /**
   * Match the container root only where it is a path, not where it is a
   * substring. The lookbehind rejects `http://x/workspace/y`, because the root
   * is preceded by a slash there. The lookahead on the bare form rejects
   * `/workspace-foo`.
   *
   * The slash variant runs first, so the separator after a rewritten prefix
   * becomes a backslash.
   */
  private readonly insideCmdSlash: RegExp;
  private readonly insideCmdBare: RegExp;

  constructor(options: PathMapOptions) {
    this.containerRoot = options.containerRoot;
    this.hostRoot = options.hostRoot;
    const root = escapeRegExp(this.containerRoot);
    this.insideCmdSlash = new RegExp(`(?<![\\w./-])${root}/`, "g");
    this.insideCmdBare = new RegExp(`(?<![\\w./-])${root}(?![\\w-])`, "g");
  }

  /** Map a whole container path to its Windows spelling. */
  toHost(p: string): string {
    if (!p.startsWith(this.containerRoot)) return p;
    const rest = p.slice(this.containerRoot.length).replace(/\//g, "\\");
    return win32.normalize(this.hostRoot + rest);
  }

  /**
   * Map every container path inside a command string. Replacement uses a
   * function, because a plain replacement string would eat the backslashes of
   * the host root.
   */
  rewriteCommand(cmd: string): string {
    const withSlash = cmd.replace(this.insideCmdSlash, () => `${this.hostRoot}\\`);
    return withSlash.replace(this.insideCmdBare, () => this.hostRoot);
  }

  /**
   * Hide host paths from the agent again. Both spellings are mapped, because a
   * program may print the folder with forward slashes.
   */
  toContainer(s: string): string {
    return s
      .split(this.hostRoot)
      .join(this.containerRoot)
      .split(this.hostRoot.replace(/\\/g, "/"))
      .join(this.containerRoot);
  }
}

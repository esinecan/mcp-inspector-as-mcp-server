/**
 * The six cases that say the path contract still holds.
 *
 * They are the disproof cases, not a demonstration: each one names a rewrite
 * that a bare substring replacement would get wrong. The set is ported
 * unchanged from the Python bridge it replaces, so a rewrite that passes there
 * passes here.
 */

import { win32 } from "path";
import type { PathMap } from "./path-map.js";

export interface SelftestRow {
  name: string;
  ok: boolean;
  got: string;
  want: string;
}

export function runSelftest(pathMap: PathMap): SelftestRow[] {
  const h = pathMap.hostRoot;
  const c = pathMap.containerRoot;

  const cases: Array<{ name: string; got: string; want: string }> = [
    {
      name: "rewrite both args",
      got: pathMap.rewriteCommand(`tool.exe ${c}/in.txt ${c}/out.txt`),
      want: `tool.exe ${h}\\in.txt ${h}\\out.txt`,
    },
    {
      name: "rewrite after a flag value",
      got: pathMap.rewriteCommand(`tool.exe --prefix=${c}/x`),
      want: `tool.exe --prefix=${h}\\x`,
    },
    {
      name: "do NOT rewrite URL paths",
      got: pathMap.rewriteCommand(`tool.exe http://example.com${c}/y`),
      want: `tool.exe http://example.com${c}/y`,
    },
    {
      name: "rewrite bare container root",
      got: pathMap.rewriteCommand(`dir ${c}`),
      want: `dir ${h}`,
    },
    {
      name: "do NOT rewrite a longer name",
      got: pathMap.rewriteCommand(`cat ${c}-foo`),
      want: `cat ${c}-foo`,
    },
    {
      name: "cwd mapping",
      got: pathMap.toHost(`${c}/sub/x.txt`),
      want: win32.normalize(`${h}\\sub\\x.txt`),
    },
  ];

  return cases.map((one) => ({ ...one, ok: one.got === one.want }));
}

/** Render the rows the way the Python bridge printed them. */
export function formatSelftest(rows: SelftestRow[]): string {
  return rows
    .map((r) => `${r.ok ? "OK  " : "FAIL"} ${r.name} -> ${JSON.stringify(r.got)}`)
    .join("\n");
}

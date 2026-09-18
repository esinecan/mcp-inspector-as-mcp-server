/**
 * Where the circuit file lives between two processes.
 *
 * Every `mcp-cli` invocation is a new process, so a circuit that lived only
 * in memory would be forgotten before the next call could honour it. The file
 * store reads the whole file, hands it to the caller, and writes it back
 * atomically: a temporary file next to the target, then a rename, so a
 * reader never sees half a file. Two processes writing at once lose one
 * another's update, which is accepted: the loser's failure is counted again
 * the next time it happens.
 *
 * A file that cannot be read starts empty rather than failing the call. The
 * circuit file is memory, not authority.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, rmSync } from "fs";
import { dirname, join } from "path";
import { emptyCircuits, type CircuitFile } from "./circuits.js";

export interface StateStore {
  load(): CircuitFile;
  save(file: CircuitFile): void;
  /** Where it lives, for the status output. */
  readonly location: string;
}

export function fileStateStore(path: string): StateStore {
  return {
    location: path,
    load(): CircuitFile {
      if (!existsSync(path)) return emptyCircuits();
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<CircuitFile>;
        if (raw && raw.version === 1 && raw.servers && raw.requests) {
          return { version: 1, servers: raw.servers, requests: raw.requests };
        }
      } catch {
        // Unreadable state is empty state.
      }
      return emptyCircuits();
    },
    save(file: CircuitFile): void {
      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = join(dirname(path), `.${process.pid}.${Date.now()}.tmp`);
        writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
        try {
          renameSync(tmp, path);
        } catch {
          // Windows refuses to rename over a file another process holds open
          // for a moment; fall back to a plain write rather than lose the state.
          writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
          rmSync(tmp, { force: true });
        }
      } catch {
        // A state that cannot be written must not fail the call it describes.
      }
    },
  };
}

/** Holds one file in memory; what a test and the scripted lane use. */
export function memoryStateStore(initial: CircuitFile = emptyCircuits()): StateStore {
  let current = initial;
  return {
    location: "(memory)",
    load: () => structuredClone(current),
    save: (file) => {
      current = structuredClone(file);
    },
  };
}

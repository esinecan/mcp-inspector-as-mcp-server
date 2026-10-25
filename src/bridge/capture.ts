/** Raw disk evidence, independent of display decoding and path mapping. */
import { mkdirSync, readdirSync, statSync, openSync, closeSync, writeSync, rmSync } from "fs";
import { createHash, randomUUID } from "crypto";
import { join } from "path";
import { homedir } from "os";

export const DEFAULT_CAPTURE_DIR = join(homedir(), ".agents", "mcp-cli-capture");
export interface CaptureOptions {
  captureDir?: string;
  maxCaptureBytes?: number;
  maxCaptureTotalBytes?: number;
}
export interface CaptureInfo {
  path?: string;
  bytes: number;
  observedBytes: number;
  sha256: string;
  complete: boolean;
  bom?: ByteOrderMark;
  error?: string;
}

export type ByteOrderMark = "utf-8" | "utf-16le";

export function byteOrderMark(head: Buffer): ByteOrderMark | undefined {
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return "utf-8";
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return "utf-16le";
  return undefined;
}

export function decodeDisplay(bytes: Buffer): string {
  const bom = byteOrderMark(bytes);
  if (bom === "utf-16le") return bytes.subarray(2).toString("utf16le");
  if (bom === "utf-8") return bytes.subarray(3).toString("utf8");
  return bytes.toString("utf8");
}

const isArtifact = (s: string) => /^[0-9a-f-]{36}\.(stdout|stderr)\.raw$/.test(s);
export function pruneCaptures(dir: string, days: number): number {
  if (!Number.isFinite(days) || days < 0) throw new Error("older-than must be nonnegative days");
  let removed = 0;
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, ".capture-lock");
  mkdirSync(lock);
  try {
    for (const name of readdirSync(dir).filter(isArtifact)) {
      const p = join(dir, name);
      if (Date.now() - statSync(p).mtimeMs > days * 86400000) {
        rmSync(p);
        removed++;
      }
    }
  } finally {
    rmSync(lock, { recursive: true });
  }
  return removed;
}

export class RawCapture {
  private path?: string;
  private fd?: number;
  private bytes = 0;
  private observed = 0;
  private error?: string;
  private hash = createHash("sha256");
  private head = Buffer.alloc(0);
  private readonly dir: string;
  constructor(
    stream: "stdout" | "stderr",
    private readonly options: CaptureOptions,
  ) {
    this.dir = options.captureDir ?? DEFAULT_CAPTURE_DIR;
    try {
      mkdirSync(this.dir, { recursive: true });
      this.path = join(this.dir, `${randomUUID()}.${stream}.raw`);
      this.fd = openSync(this.path, "wx");
    } catch {
      this.error = "capture_open_failed";
    }
  }
  push(chunk: Buffer): void {
    this.observed += chunk.length;
    if (this.head.length < 3) this.head = Buffer.concat([this.head, chunk.subarray(0, 3 - this.head.length)]);
    if (this.fd === undefined || this.error) return;
    const lock = join(this.dir, ".capture-lock");
    try {
      mkdirSync(lock);
    } catch {
      this.error = "capture_busy";
      return;
    }
    try {
      const used = readdirSync(this.dir)
        .filter(isArtifact)
        .reduce((n, f) => n + statSync(join(this.dir, f)).size, 0);
      const room = Math.max(
        0,
        Math.min(
          (this.options.maxCaptureBytes ?? 64 * 1024 * 1024) - this.bytes,
          (this.options.maxCaptureTotalBytes ?? 1024 * 1024 * 1024) - used,
        ),
      );
      const keep = chunk.subarray(0, room);
      let offset = 0;
      while (offset < keep.length) {
        const written = writeSync(this.fd, keep, offset, keep.length - offset);
        if (!written) throw Error("no progress");
        this.hash.update(keep.subarray(offset, offset + written));
        this.bytes += written;
        offset += written;
      }
      if (keep.length !== chunk.length) this.error = "capture_quota_exceeded";
    } catch {
      this.error = "capture_write_failed";
    } finally {
      rmSync(lock, { recursive: true });
    }
  }
  finish(): CaptureInfo {
    if (this.fd !== undefined) {
      closeSync(this.fd);
      this.fd = undefined;
    }
    const bom = byteOrderMark(this.head);
    return {
      path: this.path,
      bytes: this.bytes,
      observedBytes: this.observed,
      sha256: this.hash.digest("hex"),
      complete: !this.error && this.bytes === this.observed,
      ...(bom ? { bom } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }
}

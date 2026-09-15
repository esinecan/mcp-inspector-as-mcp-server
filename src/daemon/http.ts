/**
 * The daemon's loopback surface: `POST /op`, `GET /status`, `POST /shutdown`.
 *
 * There is no authentication, and that is safe only because the listener binds
 * `127.0.0.1`. The host bridge binds `0.0.0.0` on purpose, because a container
 * has to reach it; this one must not, because it holds live connections to
 * servers that already carry the user's credentials. A container worker reaches
 * the daemon the long way round, through the bridge, which runs `mcp-cli` on
 * the host.
 *
 * The adapter checks nothing about a request body beyond "it is JSON". Field
 * checking and refusal live in `handleOp`, so this surface and the CLI cannot
 * disagree about what a valid request is.
 */

import { createServer, type Server as HttpServer } from "http";
import { readBody } from "../http-body.js";
import { asDaemonError, handleOp, statusFor } from "./core.js";
import type { WarmProvider, WarmRow } from "./registry.js";

export interface DaemonHttpOptions {
  warm: WarmProvider;
  /** Where the daemon listens, reported by `/status`. */
  port: number;
  bind: string;
  /** One line per request goes here. Defaults to stderr. */
  log?: (line: string) => void;
  /** Called after `POST /shutdown` has answered. */
  onShutdown?: () => void;
  /** Rows for `/status`. Defaults to the warm store's own listing. */
  rows?: () => WarmRow[];
}

/** The largest request body the daemon accepts, in bytes. */
const MAX_BODY = 8 * 1024 * 1024;

/** The shape `GET /status` returns. */
export interface DaemonStatus {
  ok: true;
  pid: number;
  bind: string;
  port: number;
  uptimeSeconds: number;
  config: string;
  servers: WarmRow[];
}

/** Build the HTTP server. The caller decides when and where it listens. */
export function createDaemonHttpServer(options: DaemonHttpOptions): HttpServer {
  const log = options.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const startedAt = Date.now();

  return createServer((req, res) => {
    const began = Date.now();
    const where = `${req.method ?? "?"} ${req.url ?? "?"}`;

    /** The one place a response is written and the one place a line is logged. */
    const send = (status: number, payload: unknown, note: string): void => {
      const body = Buffer.from(JSON.stringify(payload), "utf8");
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": String(body.length),
      });
      res.end(body);
      log(`${where} -> ${status} ${note} ${Date.now() - began}ms`);
    };

    if (req.method === "GET" && req.url === "/status") {
      const status: DaemonStatus = {
        ok: true,
        pid: process.pid,
        bind: options.bind,
        port: options.port,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        config: options.warm.configPath,
        servers: options.rows ? options.rows() : [],
      };
      send(200, status, `warm=${status.servers.length}`);
      return;
    }

    if (req.method === "POST" && req.url === "/shutdown") {
      send(200, { ok: true, pid: process.pid }, "shutdown");
      // Answer first, then stop: the caller is waiting on this response.
      res.on("finish", () => options.onShutdown?.());
      return;
    }

    if (req.method !== "POST" || req.url !== "/op") {
      send(
        404,
        { error: "not found. The daemon serves POST /op, GET /status and POST /shutdown." },
        "",
      );
      return;
    }

    readBody(req, MAX_BODY, (raw) => {
      if (raw === null) {
        send(413, { error: "request body too large, or the client disconnected" }, "body");
        return;
      }
      let request: unknown;
      try {
        request = JSON.parse(raw);
      } catch (err) {
        send(
          400,
          { error: `invalid JSON body (${(err as Error).message})`, code: "usage" },
          "invalid JSON",
        );
        return;
      }

      const label = describe(request);
      handleOp(request, options.warm).then(
        (result) => send(200, { result }, label),
        (err: unknown) => {
          const daemonError = asDaemonError(err);
          send(
            statusFor(daemonError.code),
            { error: daemonError.message, code: daemonError.code },
            `${label} ${daemonError.code}`,
          );
        },
      );
    });
  });
}

/** A short label for the log line, built from whatever the caller sent. */
function describe(request: unknown): string {
  if (typeof request !== "object" || request === null) return "?";
  const r = request as { server?: unknown; op?: unknown; name?: unknown };
  const parts = [r.server, r.op, r.name].filter((p) => typeof p === "string");
  return parts.length > 0 ? parts.join(" ") : "?";
}

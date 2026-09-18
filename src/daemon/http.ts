/**
 * The daemon's loopback surface: `POST /op`, `GET /status`, `GET /health/live`,
 * `GET /health/ready`, `POST /shutdown`.
 *
 * There is no authentication, and that is safe only because the listener binds
 * `127.0.0.1`. The host bridge binds `0.0.0.0` on purpose, because a container
 * has to reach it; this one must not, because it holds live connections to
 * servers that already carry the user's credentials. A container worker reaches
 * the daemon the long way round, through the bridge, which runs `mcp-cli` on
 * the host.
 *
 * Liveness says the process answers. Readiness says it has done what it was
 * told to do at start: the prewarm list is connected, or has been tried. A
 * watchdog restarts on a dead liveness and reports on a false readiness.
 *
 * The adapter checks nothing about a request body beyond "it is JSON". Field
 * checking and refusal live in `handleOp`, so this surface and the CLI cannot
 * disagree about what a valid request is.
 */

import { createServer, type Server as HttpServer } from "http";
import { readBody } from "../http-body.js";
import { asDaemonError, handleOp, statusFor, type DaemonCore } from "./core.js";
import type { WarmProvider, WarmRow } from "./registry.js";

export interface Readiness {
  ready: boolean;
  /** One entry per prewarm server: "warm", "pending", or "failed: <why>". */
  prewarm: Record<string, string>;
}

export interface DaemonHttpOptions {
  warm: WarmProvider;
  /** Where the daemon listens, reported by `/status`. */
  port: number;
  bind: string;
  /** The queue and its limits. Without it requests are not serialised. */
  core?: DaemonCore;
  /** One line per request goes here. Defaults to stderr. */
  log?: (line: string) => void;
  /** Called after `POST /shutdown` has answered. */
  onShutdown?: () => void;
  /** Rows for `/status`. Defaults to the warm store's own listing. */
  rows?: () => WarmRow[];
  /** What `/health/ready` reports. Defaults to ready with nothing to prewarm. */
  readiness?: () => Readiness;
  /** The circuit file, for `/status`. */
  circuits?: () => unknown;
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
  ready: boolean;
  prewarm: Record<string, string>;
  servers: WarmRow[];
  queues: Record<string, { active: number; queued: number }>;
  circuits?: unknown;
}

/** Build the HTTP server. The caller decides when and where it listens. */
export function createDaemonHttpServer(options: DaemonHttpOptions): HttpServer {
  const log = options.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const startedAt = Date.now();
  const readiness = options.readiness ?? (() => ({ ready: true, prewarm: {} }));

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

    if (req.method === "GET" && req.url === "/health/live") {
      send(200, { ok: true, pid: process.pid, uptimeSeconds: uptime(startedAt) }, "live");
      return;
    }

    if (req.method === "GET" && req.url === "/health/ready") {
      const state = readiness();
      send(
        state.ready ? 200 : 503,
        { ...state, pid: process.pid },
        state.ready ? "ready" : "not ready",
      );
      return;
    }

    if (req.method === "GET" && req.url === "/status") {
      const state = readiness();
      const status: DaemonStatus = {
        ok: true,
        pid: process.pid,
        bind: options.bind,
        port: options.port,
        uptimeSeconds: uptime(startedAt),
        config: options.warm.configPath,
        ready: state.ready,
        prewarm: state.prewarm,
        servers: options.rows ? options.rows() : [],
        queues: options.core ? options.core.gates.depths() : {},
      };
      if (options.circuits) status.circuits = options.circuits();
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
        {
          error:
            "not found. The daemon serves POST /op, GET /status, GET /health/live, GET /health/ready and POST /shutdown.",
        },
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
      handleOp(request, options.warm, options.core).then(
        (result) => send(200, { result }, label),
        (err: unknown) => {
          const daemonError = asDaemonError(err);
          const payload: Record<string, unknown> = {
            error: daemonError.message,
            code: daemonError.code,
          };
          const c = daemonError.classified;
          if (c !== undefined) {
            payload.class = c.class;
            if (c.reason !== undefined) payload.reason = c.reason;
            if (c.retryAfterMs !== undefined) payload.retryAfterMs = c.retryAfterMs;
            if (c.remediation !== undefined) payload.remediation = c.remediation;
          }
          send(
            statusFor(daemonError.code),
            payload,
            `${label} ${daemonError.code}${c !== undefined ? ` ${c.class}` : ""}`,
          );
        },
      );
    });
  });
}

function uptime(startedAt: number): number {
  return Math.floor((Date.now() - startedAt) / 1000);
}

/** A short label for the log line, built from whatever the caller sent. */
function describe(request: unknown): string {
  if (typeof request !== "object" || request === null) return "?";
  const r = request as { server?: unknown; op?: unknown; name?: unknown; trace?: unknown };
  const parts = [r.server, r.op, r.name].filter((p) => typeof p === "string");
  const label = parts.length > 0 ? parts.join(" ") : "?";
  return typeof r.trace === "string" ? `${label} ${r.trace}` : label;
}

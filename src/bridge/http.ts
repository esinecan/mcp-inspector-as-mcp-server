/**
 * The HTTP adapter: `POST /exec`, plus `GET /health/live`, `GET /health/ready`
 * and `GET /status`.
 *
 * The wire format is the one the Python bridge served, so a client that already
 * posts to `host.docker.internal:8790` keeps working unchanged, with one
 * addition: when the bridge binds anything but loopback it requires a bearer
 * token on `/exec`, read at start from the environment variable the config
 * names. The token's value is never written to the config, the log or a
 * response. The health surfaces need no token: they say nothing a caller on
 * the network could not learn by connecting.
 *
 * Two commands run at once and eight wait; the ninth is answered 503 with a
 * Retry-After, because a host shell that starts every command it is sent is a
 * host that can be flattened by a loop. Output is cut at the configured cap
 * per stream, with the cut counted so a caller knows what it did not get.
 *
 * The adapter validates nothing about the request body beyond "it is JSON".
 * Field checking lives in `execBridged`, so this adapter and the MCP adapter
 * cannot disagree about what a valid request is.
 */

import { createServer, type Server as HttpServer } from "http";
import { timingSafeEqual } from "crypto";
import { readBody } from "../http-body.js";
import { Gate, QueueFull } from "../supervise/queue.js";
import { execBridged, bridgeErrorMessage, type ExecOptions } from "./exec.js";

export interface BridgeHttpOptions extends ExecOptions {
  /** One line per request goes here. Defaults to stderr. */
  log?: (line: string) => void;
  /** The bearer token `/exec` requires. Undefined means no authentication. */
  token?: string;
  /** Commands running at once. Defaults to 2. */
  maxActive?: number;
  /** Requests waiting for a slot. Defaults to 8. */
  maxQueued?: number;
  /** Where the bridge listens, reported by `/status`. */
  bind?: string;
  port?: number;
}

/** The largest request body the bridge accepts, in bytes. */
const MAX_BODY = 4 * 1024 * 1024;

export const DEFAULT_MAX_ACTIVE = 2;
export const DEFAULT_MAX_QUEUED = 8;

/** The shape `GET /status` returns. */
export interface BridgeStatus {
  ok: true;
  pid: number;
  bind?: string;
  port?: number;
  uptimeSeconds: number;
  auth: "bearer" | "none";
  active: number;
  queued: number;
  maxActive: number;
  maxQueued: number;
  containerRoot: string;
  maxOutputBytes?: number;
}

/** Constant-time comparison of a presented bearer token with the expected one. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  if (header === undefined) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const presented = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(token, "utf8");
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

/** Build the HTTP server. The caller decides when and where it listens. */
export function createBridgeHttpServer(options: BridgeHttpOptions): HttpServer {
  const log = options.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const startedAt = Date.now();
  const maxActive = options.maxActive ?? DEFAULT_MAX_ACTIVE;
  const maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED;
  const gate = new Gate(maxActive, maxQueued);

  return createServer((req, res) => {
    const started = Date.now();
    const where = `${req.method ?? "?"} ${req.url ?? "?"}`;

    /** The one place a response is written and the one place a line is logged. */
    const send = (
      status: number,
      payload: unknown,
      note: string,
      headers: Record<string, string> = {},
    ): void => {
      const body = Buffer.from(JSON.stringify(payload), "utf8");
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": String(body.length),
        ...headers,
      });
      res.end(body);
      log(`${where} -> ${status} ${note} ${Date.now() - started}ms`);
    };

    if (req.method === "GET" && req.url === "/health/live") {
      send(200, { ok: true, pid: process.pid, uptimeSeconds: uptime(startedAt) }, "live");
      return;
    }

    if (req.method === "GET" && (req.url === "/health/ready" || req.url === "/status")) {
      const depth = gate.depth();
      const status: BridgeStatus = {
        ok: true,
        pid: process.pid,
        uptimeSeconds: uptime(startedAt),
        auth: options.token !== undefined ? "bearer" : "none",
        active: depth.active,
        queued: depth.queued,
        maxActive,
        maxQueued,
        containerRoot: options.pathMap.containerRoot,
      };
      if (options.bind !== undefined) status.bind = options.bind;
      if (options.port !== undefined) status.port = options.port;
      if (options.maxOutputBytes !== undefined) status.maxOutputBytes = options.maxOutputBytes;
      send(200, req.url === "/status" ? status : { ready: true, ...status }, "ready");
      return;
    }

    if (req.method !== "POST" || req.url !== "/exec") {
      send(
        404,
        {
          error:
            "not found. The bridge serves POST /exec, GET /status, GET /health/live and GET /health/ready.",
        },
        "",
      );
      return;
    }

    if (options.token !== undefined && !bearerMatches(req.headers.authorization, options.token)) {
      // The body is not read: an unauthenticated caller gets nothing but the refusal.
      req.resume();
      send(401, { error: "unauthorized: a bearer token is required on /exec" }, "unauthorized", {
        "WWW-Authenticate": 'Bearer realm="mcp-cli bridge"',
      });
      return;
    }

    // A client that disconnects mid-body must not take the server with it;
    // `readBody` reports that the same way it reports an over-size body.
    readBody(req, MAX_BODY, (raw) => {
      if (raw === null) {
        send(413, { error: "request body too large, or the client disconnected" }, "body");
        return;
      }
      let request: unknown;
      try {
        request = JSON.parse(raw);
      } catch (err) {
        send(400, { error: `invalid JSON body (${(err as Error).message})` }, "invalid JSON");
        return;
      }

      const controller = new AbortController();
      res.once("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      gate.acquire().then(
        (release) => {
          execBridged(request, { ...options, signal: controller.signal })
            .then(
              (result) => {
                const cwd = (request as { cwd?: unknown }).cwd;
                send(
                  200,
                  result,
                  `cwd=${typeof cwd === "string" ? cwd : options.pathMap.containerRoot} exit=${result.exit}${
                    result.truncated ? " truncated" : ""
                  }`,
                );
              },
              (err: unknown) => {
                const message = bridgeErrorMessage(err);
                send(500, { error: message }, message);
              },
            )
            .finally(release);
        },
        (err: unknown) => {
          const depth = gate.depth();
          send(
            503,
            {
              error: `busy: ${depth.active} running, ${depth.queued} queued (limits ${maxActive}/${maxQueued})`,
              retryAfterSeconds: 1,
            },
            err instanceof QueueFull ? "queue full" : bridgeErrorMessage(err),
            { "Retry-After": "1" },
          );
        },
      );
    });
  });
}

function uptime(startedAt: number): number {
  return Math.floor((Date.now() - startedAt) / 1000);
}

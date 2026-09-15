/**
 * The HTTP adapter: `POST /exec` and nothing else.
 *
 * The wire format is the one the Python bridge served, so a client that already
 * posts to `host.docker.internal:8790` keeps working unchanged. There is no
 * authentication. The boundary is the Windows firewall, and the intended use is
 * same-machine, with a container reaching its host.
 *
 * The adapter validates nothing about the request body beyond "it is JSON".
 * Field checking lives in `execBridged`, so this adapter and the MCP adapter
 * cannot disagree about what a valid request is.
 */

import { createServer, type Server as HttpServer } from "http";
import { readBody } from "../http-body.js";
import { execBridged, bridgeErrorMessage, type ExecOptions } from "./exec.js";

export interface BridgeHttpOptions extends ExecOptions {
  /** One line per request goes here. Defaults to stderr. */
  log?: (line: string) => void;
}

/** The largest request body the bridge accepts, in bytes. */
const MAX_BODY = 4 * 1024 * 1024;

/** Build the HTTP server. The caller decides when and where it listens. */
export function createBridgeHttpServer(options: BridgeHttpOptions): HttpServer {
  const log = options.log ?? ((line: string) => void process.stderr.write(`${line}\n`));

  return createServer((req, res) => {
    const started = Date.now();
    const where = `${req.method ?? "?"} ${req.url ?? "?"}`;

    /** The one place a response is written and the one place a line is logged. */
    const send = (status: number, payload: unknown, note: string): void => {
      const body = Buffer.from(JSON.stringify(payload), "utf8");
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": String(body.length),
      });
      res.end(body);
      log(`${where} -> ${status} ${note} ${Date.now() - started}ms`);
    };

    if (req.method !== "POST" || req.url !== "/exec") {
      send(404, { error: "not found. The bridge serves POST /exec only." }, "");
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

      execBridged(request, options).then(
        (result) => {
          const cwd = (request as { cwd?: unknown }).cwd;
          send(
            200,
            result,
            `cwd=${typeof cwd === "string" ? cwd : options.pathMap.containerRoot} exit=${result.exit}`,
          );
        },
        (err: unknown) => {
          const message = bridgeErrorMessage(err);
          send(500, { error: message }, message);
        },
      );
    });
  });
}

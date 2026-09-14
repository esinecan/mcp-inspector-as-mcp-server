/**
 * The HTTP adapter: `POST /exec` and nothing else.
 *
 * The wire format is the one the Python bridge served, so a client that already
 * posts to `host.docker.internal:8790` keeps working unchanged. There is no
 * authentication. The boundary is the Windows firewall, and the intended use is
 * same-machine, with a container reaching its host.
 */

import { createServer, type Server as HttpServer } from "http";
import { execBridged, BridgeExecError, type ExecOptions, type ExecRequest } from "./exec.js";

export interface BridgeHttpOptions extends ExecOptions {
  /** One line per request goes here. Defaults to stderr. */
  log?: (line: string) => void;
}

/** The largest request body the bridge accepts, in bytes. */
const MAX_BODY = 4 * 1024 * 1024;

function readBody(stream: NodeJS.ReadableStream, onDone: (body: string | null) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let ended = false;
  stream.on("data", (c: Buffer) => {
    size += c.length;
    if (size > MAX_BODY) {
      if (!ended) {
        ended = true;
        onDone(null);
      }
      return;
    }
    chunks.push(c);
  });
  stream.on("end", () => {
    if (ended) return;
    ended = true;
    onDone(Buffer.concat(chunks).toString("utf8"));
  });
}

/** Build the HTTP server. The caller decides when and where it listens. */
export function createBridgeHttpServer(options: BridgeHttpOptions): HttpServer {
  const log = options.log ?? ((line: string) => void process.stderr.write(`${line}\n`));

  return createServer((req, res) => {
    const started = Date.now();

    const send = (status: number, payload: unknown): void => {
      const body = Buffer.from(JSON.stringify(payload), "utf8");
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": String(body.length),
      });
      res.end(body);
    };

    if (req.method !== "POST" || req.url !== "/exec") {
      send(404, { error: "not found. The bridge serves POST /exec only." });
      log(`${req.method ?? "?"} ${req.url ?? "?"} -> 404`);
      return;
    }

    readBody(req, (raw) => {
      if (raw === null) {
        send(413, { error: "request body too large" });
        return;
      }
      let request: ExecRequest;
      try {
        request = JSON.parse(raw) as ExecRequest;
      } catch (err) {
        send(400, { error: `invalid JSON body (${(err as Error).message})` });
        log(`POST /exec -> 400 invalid JSON`);
        return;
      }

      execBridged(request, options).then(
        (result) => {
          send(200, result);
          log(
            `POST /exec cwd=${request.cwd ?? options.pathMap.containerRoot} exit=${result.exit} ${Date.now() - started}ms`,
          );
        },
        (err: Error) => {
          const message = err instanceof BridgeExecError ? err.message : String(err);
          send(500, { error: message });
          log(`POST /exec -> 500 ${message} ${Date.now() - started}ms`);
        },
      );
    });
  });
}

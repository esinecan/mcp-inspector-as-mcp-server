/**
 * The loopback listener that receives the authorization code.
 *
 * It binds 127.0.0.1 only, answers one path, accepts one matching callback
 * and then closes. A callback whose state is not the one this process
 * issued is answered 400 and ignored, so a stray or forged redirect cannot
 * complete the login. The window is bounded, because a listener that waits
 * for ever is a port held for ever.
 */

import { createServer, type Server } from "http";

export interface CallbackResult {
  code: string;
  iss?: string;
}

export interface CallbackOptions {
  port: number;
  host?: string;
  path?: string;
  timeoutMs?: number;
  /** Whether a state value is the one this process issued. */
  stateMatches: (state: string | null) => boolean;
}

export interface CallbackListener {
  /** Resolves with the code, rejects on an AS error, a timeout, or a port in use. */
  result: Promise<CallbackResult>;
  close(): void;
}

/** The authorization server answered the redirect with an error. */
export class CallbackError extends Error {
  constructor(
    readonly code: string,
    description?: string,
  ) {
    super(description ? `${code}: ${description}` : code);
  }
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;margin:3em"><h1>${title}</h1><p>${body}</p></body>`;

export function listenForCallback(options: CallbackOptions): CallbackListener {
  const host = options.host ?? "127.0.0.1";
  const path = options.path ?? "/callback";
  const timeoutMs = options.timeoutMs ?? 300_000;
  let server: Server | undefined;
  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  let abandon: (() => void) | undefined;

  const result = new Promise<CallbackResult>((resolve, reject) => {
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
      // Let the response flush before the socket goes.
      setTimeout(() => close(), 100).unref();
    };
    abandon = () => finish(() => reject(new Error("the callback listener was closed")));

    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${host}:${options.port}`);
      if (req.method !== "GET" || url.pathname !== path) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      const error = url.searchParams.get("error");
      if (error) {
        res
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end(PAGE("Authorization refused", "You can close this window."));
        finish(() =>
          reject(new CallbackError(error, url.searchParams.get("error_description") ?? undefined)),
        );
        return;
      }
      if (!options.stateMatches(url.searchParams.get("state"))) {
        res
          .writeHead(400, { "content-type": "text/html; charset=utf-8" })
          .end(
            PAGE("Unexpected callback", "This callback does not belong to the login in progress."),
          );
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        res
          .writeHead(400, { "content-type": "text/html; charset=utf-8" })
          .end(PAGE("Incomplete callback", "The authorization server sent no code."));
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(
          PAGE("Signed in", "mcp-cli has received the authorization. You can close this window."),
        );
      const iss = url.searchParams.get("iss") ?? undefined;
      finish(() => resolve(iss !== undefined ? { code, iss } : { code }));
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      const message =
        err.code === "EADDRINUSE"
          ? `port ${options.port} on ${host} is in use; pass --callback-port <n> to use another`
          : err.message;
      finish(() => reject(new Error(message)));
    });

    server.listen(options.port, host, () => {
      timer = setTimeout(() => {
        finish(() =>
          reject(
            new Error(`no authorization callback arrived within ${Math.round(timeoutMs / 1000)}s`),
          ),
        );
      }, timeoutMs);
      timer.unref();
    });
  });

  // A rejection that lands before the caller awaits must not be "unhandled":
  // the caller still sees it through its own await.
  result.catch(() => {});

  const close = () => {
    abandon?.();
    if (timer) clearTimeout(timer);
    if (server) {
      server.closeAllConnections?.();
      server.close();
      server = undefined;
    }
  };

  return { result, close };
}

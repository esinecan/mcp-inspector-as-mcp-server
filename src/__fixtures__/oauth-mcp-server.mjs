#!/usr/bin/env node
/**
 * An OAuth-protected Streamable HTTP MCP server with its own authorization
 * server, for the auth tests and the manual scenarios.
 *
 * One process, one port, both roles: the resource server at `/mcp` and the
 * authorization server at `/authorize`, `/token`, `/register`, `/revoke`,
 * with RFC 9728 and RFC 8414 metadata where the spec says to look. Every
 * knob a test needs is a switch, settable at start through the environment
 * or at runtime through `POST /_control` with a JSON body, so one running
 * fixture can play a happy server, a server whose refresh grant has gone
 * stale, and a server that wants a wider scope, in that order.
 *
 * Switches (environment at start, or JSON keys on /_control):
 *   expiresIn        seconds an access token lives (default 3600)
 *   refresh          "ok" | "invalid_grant" (default "ok")
 *   challengeScope   the `scope` named in the 401 challenge, or "" (default "")
 *   prmScopes        `scopes_supported` in the resource metadata, or "" (default "")
 *   asScopes         `scopes_supported` of the AS (default "mock:read offline_access")
 *   requiredScope    a scope every tool call needs; missing → 403 insufficient_scope (default "")
 *   auto             "1": /authorize redirects at once; "0": it serves a page with the link
 *
 * Standalone: `node oauth-mcp-server.mjs` prints `{"port":N}` on stdout and
 * logs one line per request on stderr. In-process: `startOAuthMcpServer()`.
 */

import { createHash, randomBytes } from "crypto";
import { createServer } from "http";
import { fileURLToPath } from "url";
import { Server, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

const text = (value) => ({ content: [{ type: "text", text: String(value) }] });

export function startOAuthMcpServer(options = {}) {
  const state = {
    expiresIn: Number(options.expiresIn ?? process.env.OAUTH_EXPIRES_IN ?? 3600),
    refresh: options.refresh ?? process.env.OAUTH_REFRESH ?? "ok",
    challengeScope: options.challengeScope ?? process.env.OAUTH_CHALLENGE_SCOPE ?? "",
    prmScopes: options.prmScopes ?? process.env.OAUTH_PRM_SCOPES ?? "",
    asScopes: options.asScopes ?? process.env.OAUTH_AS_SCOPES ?? "mock:read offline_access",
    requiredScope: options.requiredScope ?? process.env.OAUTH_REQUIRED_SCOPE ?? "",
    auto: String(options.auto ?? process.env.OAUTH_AUTO ?? "1") === "1",
  };
  const log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
  const clients = new Map();
  const codes = new Map();
  const access = new Map();
  const refreshTokens = new Map();
  const events = [];
  let counter = 0;
  let base = "";

  const record = (line) => {
    events.push(line);
    log(line);
  };

  const mcp = new Server({ name: "oauth-mock", version: "1.0.0" }, { capabilities: { tools: {} } });
  const tools = [
    {
      name: "echo",
      description: "Answer with the text given.",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      annotations: { readOnlyHint: true },
    },
    {
      name: "counter",
      description: "The number of times this process answered it.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    },
    {
      name: "whoami",
      description: "The scope of the token that made the call.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    },
    {
      name: "write_thing",
      description: "A tool with no annotations, so the client must assume it writes.",
      inputSchema: { type: "object", properties: { value: { type: "string" } } },
    },
  ];
  mcp.setRequestHandler("tools/list", async () => ({ tools }));
  let currentScope = "";
  mcp.setRequestHandler("tools/call", async (request) => {
    const { name, arguments: args = {} } = request.params;
    switch (name) {
      case "echo":
        return text(args.text ?? "");
      case "counter":
        counter += 1;
        return text(counter);
      case "whoami":
        return text(currentScope || "(no scope)");
      case "write_thing":
        return text(`wrote ${args.value ?? ""}`);
      default:
        throw new Error(`unknown tool ${name}`);
    }
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const ready = mcp.connect(transport);

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const challenge = (res, status, error, description, extra = "") => {
    const scope = state.challengeScope ? `, scope="${state.challengeScope}"` : "";
    res.writeHead(status, {
      "content-type": "application/json",
      "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"${scope}${extra}${error ? `, error="${error}"` : ""}`,
    });
    res.end(JSON.stringify({ error: error ?? "invalid_token", error_description: description }));
  };
  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
    });
  const s256 = (verifier) => createHash("sha256").update(verifier).digest("base64url");
  const issue = (clientId, scope, resource) => {
    const accessToken = `at_${randomBytes(18).toString("base64url")}`;
    const refreshToken = `rt_${randomBytes(18).toString("base64url")}`;
    access.set(accessToken, { clientId, scope, resource, expiresAt: Date.now() + state.expiresIn * 1000 });
    refreshTokens.set(refreshToken, { clientId, scope, resource });
    const body = { access_token: accessToken, token_type: "bearer", expires_in: state.expiresIn };
    if (scope) body.scope = scope;
    if ((scope ?? "").split(" ").includes("offline_access") || !state.asScopes.includes("offline_access")) {
      body.refresh_token = refreshToken;
    }
    return body;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    const path = url.pathname;

    if (path === "/_control" && req.method === "POST") {
      const patch = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      Object.assign(state, patch);
      if (patch.expiresIn !== undefined) state.expiresIn = Number(patch.expiresIn);
      if (patch.auto !== undefined) state.auto = String(patch.auto) === "1" || patch.auto === true;
      record(`control ${JSON.stringify(patch)}`);
      return json(res, 200, { ok: true, state });
    }
    if (path === "/_events" && req.method === "GET") return json(res, 200, { events });

    if (path === "/.well-known/oauth-protected-resource/mcp") {
      const body = { resource: `${base}/mcp`, authorization_servers: [`${base}/`], resource_name: "OAuth mock" };
      if (state.prmScopes) body.scopes_supported = state.prmScopes.split(" ");
      return json(res, 200, body);
    }
    if (path === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer: `${base}/`,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        revocation_endpoint: `${base}/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: state.asScopes.split(" "),
      });
    }
    if (path === "/register" && req.method === "POST") {
      const metadata = JSON.parse((await readBody(req)).toString("utf8"));
      const clientId = `client_${randomBytes(6).toString("hex")}`;
      clients.set(clientId, metadata);
      record(`register client_name=${metadata.client_name} redirect_uris=${(metadata.redirect_uris ?? []).join(",")}`);
      return json(res, 201, { client_id: clientId, ...metadata, client_id_issued_at: Math.floor(Date.now() / 1000) });
    }
    if (path === "/authorize" && req.method === "GET") {
      const q = url.searchParams;
      const client = clients.get(q.get("client_id"));
      const scope = q.get("scope") ?? "";
      record(`authorize client_id=${q.get("client_id")} scope=${JSON.stringify(scope)} resource=${q.get("resource")} redirect_uri=${q.get("redirect_uri")} method=${q.get("code_challenge_method")}`);
      if (!client) return json(res, 400, { error: "invalid_client" });
      if (!(client.redirect_uris ?? []).includes(q.get("redirect_uri"))) return json(res, 400, { error: "invalid_request", error_description: "redirect_uri mismatch" });
      if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) return json(res, 400, { error: "invalid_request", error_description: "PKCE S256 required" });
      const code = `code_${randomBytes(12).toString("base64url")}`;
      codes.set(code, { clientId: q.get("client_id"), challenge: q.get("code_challenge"), redirectUri: q.get("redirect_uri"), resource: q.get("resource"), scope });
      const target = new URL(q.get("redirect_uri"));
      target.searchParams.set("code", code);
      if (q.get("state")) target.searchParams.set("state", q.get("state"));
      target.searchParams.set("iss", `${base}/`);
      if (state.auto) {
        res.writeHead(302, { location: target.toString() });
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<!doctype html><title>Consent</title><p>Connect mcp-cli?</p><a id="approve" href="${target.toString()}">Approve</a>`);
    }
    if (path === "/token" && req.method === "POST") {
      const form = new URLSearchParams((await readBody(req)).toString("utf8"));
      const grant = form.get("grant_type");
      record(`token grant_type=${grant} client_id=${form.get("client_id")} resource=${form.get("resource")}`);
      if (grant === "authorization_code") {
        const entry = codes.get(form.get("code"));
        codes.delete(form.get("code"));
        if (!entry) return json(res, 400, { error: "invalid_grant", error_description: "unknown code" });
        if (entry.clientId !== form.get("client_id")) return json(res, 400, { error: "invalid_grant", error_description: "client mismatch" });
        if (s256(form.get("code_verifier") ?? "") !== entry.challenge) return json(res, 400, { error: "invalid_grant", error_description: "PKCE verifier mismatch" });
        if (entry.redirectUri !== form.get("redirect_uri")) return json(res, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
        return json(res, 200, issue(entry.clientId, entry.scope, entry.resource));
      }
      if (grant === "refresh_token") {
        if (state.refresh === "invalid_grant") return json(res, 400, { error: "invalid_grant", error_description: "refresh token revoked" });
        const entry = refreshTokens.get(form.get("refresh_token"));
        if (!entry) return json(res, 400, { error: "invalid_grant", error_description: "unknown refresh token" });
        refreshTokens.delete(form.get("refresh_token"));
        return json(res, 200, issue(entry.clientId, entry.scope, entry.resource));
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    if (path === "/revoke" && req.method === "POST") {
      const form = new URLSearchParams((await readBody(req)).toString("utf8"));
      const token = form.get("token");
      access.delete(token);
      refreshTokens.delete(token);
      record("revoke");
      return json(res, 200, {});
    }
    if (path === "/mcp") {
      const header = req.headers.authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      const entry = access.get(token);
      if (!token) {
        record("mcp 401 no-token");
        return challenge(res, 401, "invalid_token", "Bearer access token is required.");
      }
      if (!entry) {
        record("mcp 401 unknown-token");
        return challenge(res, 401, "invalid_token", "The access token is not known.");
      }
      if (entry.expiresAt < Date.now()) {
        record("mcp 401 expired");
        return challenge(res, 401, "invalid_token", "The access token has expired.");
      }
      if (state.requiredScope && !(entry.scope ?? "").split(" ").includes(state.requiredScope)) {
        record(`mcp 403 insufficient_scope need=${state.requiredScope}`);
        return challenge(res, 403, "insufficient_scope", `Scope ${state.requiredScope} is required.`, `, scope="${state.requiredScope}"`);
      }
      currentScope = entry.scope ?? "";
      record(`mcp ok scope=${JSON.stringify(currentScope)}`);
      await ready;
      const body = req.method === "POST" ? await readBody(req) : undefined;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const request = new Request(url.toString(), { method: req.method, headers, body, duplex: "half" });
      const response = await transport.handleRequest(request);
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      return res.end();
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  const port = Number(options.port ?? process.env.PORT ?? 0);
  const started = new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const actual = server.address().port;
      base = `http://127.0.0.1:${actual}`;
      resolve({
        port: actual,
        url: `${base}/mcp`,
        base,
        state,
        events,
        clients,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
  return started;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fixture = await startOAuthMcpServer();
  process.stdout.write(`${JSON.stringify({ port: fixture.port, url: fixture.url })}\n`);
}

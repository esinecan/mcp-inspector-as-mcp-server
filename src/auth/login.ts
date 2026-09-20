/**
 * The interactive login: the one place a browser opens.
 *
 * The SDK drives the flow; this file orders the steps around the human. The
 * listener starts first, so a port in use fails before a browser opens. The
 * URL is handed out at once, so a caller that printed it can wait as long
 * as the window allows. The code is exchanged, the tokens are stored, and
 * the new token is proved by one `initialize` and one `tools/list` before
 * the command reports success, so "logged in" means "the server answered".
 */

import { auth, Client } from "@modelcontextprotocol/client";
import { createTransport, versionNegotiationFor, type TransportConfig } from "../transport.js";
import { CLIENT_NAME, CLIENT_VERSION } from "../cli/server-session.js";
import type { ServerEntry } from "../cli/config.js";
import { ClassifiedError } from "../supervise/classify.js";
import { CallbackError, listenForCallback } from "./callback.js";
import { classifyOAuthFailure } from "./classify.js";
import { headlessAuth, McpCliOAuthProvider } from "./provider.js";
import type { CredentialStore } from "./store.js";
import type { AuthSettings } from "./index.js";
import { providerFor } from "./index.js";

export interface LoginOptions {
  server: string;
  entry: ServerEntry;
  store: CredentialStore;
  settings: AuthSettings;
  scope?: string;
  callbackPort?: number;
  /** Called with the authorization URL as soon as it exists. */
  onUrl: (url: string) => void | Promise<void>;
  /** How long to wait for the callback. */
  timeoutMs?: number;
  /** How long the proof connection may take. */
  connectTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export interface LoginSummary {
  server: string;
  serverUrl: string;
  issuer?: string;
  clientId?: string;
  /** The scope the server granted, as it said it; absent when it said nothing. */
  scope?: string;
  expiresAt?: string;
  refreshable: boolean;
  /** How the tokens were obtained: a browser round trip or a refresh that made it unnecessary. */
  via: "browser" | "refresh";
  tools: number;
}

export async function login(options: LoginOptions): Promise<LoginSummary> {
  const { server, entry, store, settings } = options;
  if (!entry.url) {
    throw new ClassifiedError({
      class: "bad_argument",
      code: "oauth_not_http",
      message: `${server} is a stdio server; OAuth applies to HTTP servers only`,
    });
  }

  let authorizationUrl: URL | undefined;
  const requestedPort =
    options.callbackPort ?? store.meta(server)?.redirectPort ?? settings.callbackPort;
  const provider = providerFor(server, entry, store, settings, "interactive", {
    env: options.env,
    scope: options.scope,
    redirectPort: requestedPort,
    onRedirect: (url) => {
      authorizationUrl = url;
    },
  });

  // A client registered for another port does not fit this login: the AS
  // exact-matches the redirect URI. Drop it so the SDK registers again.
  const previousPort = store.meta(server)?.redirectPort;
  if (previousPort !== undefined && previousPort !== requestedPort) {
    await provider.invalidateCredentials("client");
  }

  const listener = listenForCallback({
    port: requestedPort,
    timeoutMs: options.timeoutMs,
    stateMatches: (state) => provider.stateMatches(state),
  });
  // A port in use rejects here, before any browser opens.
  const listening = listener.result.catch((err: Error) => err);

  let via: LoginSummary["via"];
  try {
    const first = await auth(provider, { serverUrl: entry.url, scope: options.scope });
    if (first === "AUTHORIZED") {
      via = "refresh";
    } else {
      if (!authorizationUrl) throw new Error("the flow asked for a redirect but gave no URL");
      const early = await Promise.race([listening, Promise.resolve(undefined)]);
      if (early instanceof Error) throw early;
      await options.onUrl(authorizationUrl.toString());
      const callback = await listener.result;
      const second = await auth(provider, {
        serverUrl: entry.url,
        authorizationCode: callback.code,
        iss: callback.iss,
        scope: options.scope,
      });
      if (second !== "AUTHORIZED") throw new Error("the code exchange did not authorize");
      via = "browser";
    }
  } catch (err) {
    if (err instanceof CallbackError) {
      throw new ClassifiedError({
        class: "auth_required",
        code: `oauth_${err.code}`,
        message: `${server}: the authorization server refused the login: ${err.message}`,
        remediation: `Run: mcp-cli auth login ${server}`,
      });
    }
    throw classifyOAuthFailure(err, server);
  } finally {
    listener.close();
  }

  const tools = await prove(server, entry, provider, options.connectTimeoutMs);
  const record = await provider.current();
  const meta = store.meta(server);
  const summary: LoginSummary = {
    server,
    serverUrl: provider.serverUrl,
    refreshable: meta?.refreshable === true,
    via,
    tools,
  };
  if (record?.issuer !== undefined) summary.issuer = record.issuer;
  if (meta?.clientId !== undefined) summary.clientId = meta.clientId;
  if (record?.tokens?.scope !== undefined) summary.scope = record.tokens.scope;
  if (record?.expiresAt !== undefined) summary.expiresAt = new Date(record.expiresAt).toISOString();
  return summary;
}

/** One connection with the new token; the count of tools it lists. */
async function prove(
  server: string,
  entry: ServerEntry,
  provider: McpCliOAuthProvider,
  timeoutMs = 30_000,
): Promise<number> {
  const config: TransportConfig = {
    url: entry.url,
    headers: entry.headers,
    transport: entry.transport,
    negotiation: entry.negotiation ?? "auto",
    authProvider: headlessAuth(provider),
    onInsufficientScope: "throw",
  };
  const transport = createTransport(config);
  const client = new Client(
    { name: CLIENT_NAME, version: CLIENT_VERSION },
    { versionNegotiation: versionNegotiationFor(config) },
  );
  try {
    await client.connect(transport, { timeout: timeoutMs });
    const listed = await client.listTools(undefined, { timeout: timeoutMs });
    return listed.tools.length;
  } catch (err) {
    throw classifyOAuthFailure(err, server);
  } finally {
    try {
      await transport.close();
    } catch {
      // Nothing to report about a transport that is already gone.
    }
  }
}

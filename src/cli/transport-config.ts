/**
 * The one builder of a `TransportConfig` from a server entry, shared by the
 * ephemeral lane and the warm daemon so the two cannot drift.
 *
 * A URL server gets the headless provider: a stored token goes on every
 * request, a 401 runs the SDK's refresh when a record exists, and a login is
 * refused with `oauth_login_required`. A stdio entry is built exactly as
 * before this module existed.
 */

import { authSettings, headlessAuth, providerFor } from "../auth/index.js";
import type { CredentialStore } from "../auth/store.js";
import type { HeadlessAuth } from "../auth/provider.js";
import type { TransportConfig } from "../transport.js";
import { resolveServerEntry, type CliConfig, type ServerEntry } from "./config.js";

export interface TransportBuild {
  config: TransportConfig;
  /** Set when the transport carries the headless provider. */
  auth?: HeadlessAuth;
}

export function transportConfigFor(
  server: string,
  raw: ServerEntry,
  deps: { config?: CliConfig; authStore?: CredentialStore; env?: NodeJS.ProcessEnv },
): TransportBuild {
  const env = deps.env ?? process.env;
  const entry = resolveServerEntry(raw, env);
  const config: TransportConfig = {
    command: entry.command,
    args: entry.args,
    env: entry.env,
    cwd: entry.cwd,
    url: entry.url,
    headers: entry.headers,
    transport: entry.transport,
    negotiation: entry.negotiation ?? "auto",
  };
  // Every URL server gets the headless provider once a store exists: with no
  // record it costs one file check and turns a 401 that carries an OAuth
  // challenge into "log in", and a 401 without one into the plain report.
  const store = deps.authStore;
  if (store === undefined || !raw.url) return { config };
  const auth = headlessAuth(
    providerFor(server, raw, store, authSettings(deps.config), "headless", { env }),
  );
  config.authProvider = auth;
  config.onInsufficientScope = "throw";
  return { config, auth };
}

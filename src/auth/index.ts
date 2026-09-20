/**
 * The auth module's surface: the store a config resolves to, and the
 * provider a lane or the login command builds for one server.
 */

import { join } from "path";
import {
  supervisionSettings,
  type AuthEntry,
  type CliConfig,
  type ServerEntry,
} from "../cli/config.js";
import { dpapiCipher } from "./dpapi.js";
import { PLAIN_CIPHER, credentialStore, type CredentialStore } from "./store.js";
import { DEFAULT_CALLBACK_PORT, DEFAULT_CLIENT_NAME, McpCliOAuthProvider } from "./provider.js";

export interface AuthSettings {
  store: "dpapi" | "file";
  callbackPort: number;
  clientName: string;
}

/** The `auth` block with every default filled in. */
export function authSettings(
  config: CliConfig | undefined,
  platform: NodeJS.Platform = process.platform,
): AuthSettings {
  const entry: AuthEntry = config?.auth ?? {};
  return {
    store: entry.store ?? (platform === "win32" ? "dpapi" : "file"),
    callbackPort: entry.callbackPort ?? DEFAULT_CALLBACK_PORT,
    clientName: entry.clientName ?? DEFAULT_CLIENT_NAME,
  };
}

/** The credential store a config file resolves to: `<stateDir>/auth`, with the backend the config names. */
export function credentialStoreFor(
  config: CliConfig | undefined,
  platform: NodeJS.Platform = process.platform,
): CredentialStore {
  const dir = join(supervisionSettings(config).stateDir, "auth");
  const settings = authSettings(config, platform);
  return credentialStore(dir, settings.store === "dpapi" ? dpapiCipher() : PLAIN_CIPHER);
}

/** The provider for one server, in the mode the caller runs in. */
export function providerFor(
  server: string,
  entry: ServerEntry,
  store: CredentialStore,
  settings: AuthSettings,
  mode: "interactive" | "headless",
  options: {
    env?: NodeJS.ProcessEnv;
    scope?: string;
    redirectPort?: number;
    onRedirect?: (url: URL) => void | Promise<void>;
  } = {},
): McpCliOAuthProvider {
  if (!entry.url)
    throw new Error(`server "${server}" has no url; OAuth applies to HTTP servers only`);
  const env = options.env ?? process.env;
  const secretName = entry.auth?.clientSecretEnv;
  const clientSecret = secretName !== undefined ? env[secretName] : undefined;
  return new McpCliOAuthProvider({
    server,
    serverUrl: entry.url,
    store,
    mode,
    redirectPort: options.redirectPort ?? store.meta(server)?.redirectPort ?? settings.callbackPort,
    clientName: settings.clientName,
    scope: options.scope ?? entry.auth?.scope,
    clientId: entry.auth?.clientId,
    clientSecret,
    onRedirect: options.onRedirect,
  });
}

export { McpCliOAuthProvider, headlessAuth, DEFAULT_CALLBACK_PORT } from "./provider.js";
export { classifyOAuthFailure, loginRequired } from "./classify.js";
export {
  credentialStore,
  CredentialReadError,
  type CredentialMeta,
  type CredentialRecord,
  type CredentialStore,
} from "./store.js";
export { login, type LoginSummary } from "./login.js";

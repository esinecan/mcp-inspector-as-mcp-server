/**
 * The SDK's OAuth client provider, backed by the credential store.
 *
 * The SDK runs the whole flow: discovery, registration, PKCE, the code
 * exchange, the refresh grant. This class only answers its questions from
 * the store and writes its answers back. It has two modes that differ in one
 * method. In `interactive` mode, `redirectToAuthorization` hands the URL to
 * the login command, which opens a browser and waits for the callback. In
 * `headless` mode, the mode of every lane that serves a call, the same
 * method throws `auth_required / oauth_login_required`: a call is never the
 * place where a browser opens.
 *
 * Both modes return a `redirectUrl`, because a provider without one is taken
 * by the SDK for a `client_credentials` client and sent down a flow this
 * tool does not use.
 */

import { randomBytes, timingSafeEqual } from "crypto";
import {
  auth,
  extractWWWAuthenticateParams,
  type AuthProvider,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { ClassifiedError } from "../supervise/classify.js";
import { classifyOAuthFailure, loginRequired } from "./classify.js";
import { canonicalServerUrl, type CredentialRecord, type CredentialStore } from "./store.js";

export const DEFAULT_CALLBACK_PORT = 8792;
export const DEFAULT_CLIENT_NAME = "mcp-cli";

export interface ProviderOptions {
  /** The config name of the server; the store is keyed by it. */
  server: string;
  serverUrl: string;
  store: CredentialStore;
  mode: "interactive" | "headless";
  /** The loopback port the redirect lands on. */
  redirectPort?: number;
  clientName?: string;
  /** An explicit scope; absent means the spec's selection: challenge, then PRM, then none. */
  scope?: string;
  /** A pre-registered client, when the server has one for this tool. */
  clientId?: string;
  clientSecret?: string;
  /** Interactive mode: where the authorization URL goes. */
  onRedirect?: (url: URL) => void | Promise<void>;
  now?: () => number;
}

export class McpCliOAuthProvider implements OAuthClientProvider {
  private record?: CredentialRecord;
  private loaded = false;
  private expectedState?: string;
  /** Whether tokens were held when this process started; the headless detail reads it. */
  private hadTokens = false;
  private readonly now: () => number;

  constructor(private readonly options: ProviderOptions) {
    this.now = options.now ?? Date.now;
  }

  get server(): string {
    return this.options.server;
  }

  get serverUrl(): string {
    return canonicalServerUrl(this.options.serverUrl);
  }

  get redirectPort(): number {
    return this.options.redirectPort ?? DEFAULT_CALLBACK_PORT;
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.redirectPort}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    const metadata: OAuthClientMetadata = {
      redirect_uris: [this.redirectUrl],
      client_name: this.options.clientName ?? DEFAULT_CLIENT_NAME,
      token_endpoint_auth_method: this.options.clientSecret ? "client_secret_post" : "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
    if (this.options.scope !== undefined) metadata.scope = this.options.scope;
    return metadata;
  }

  /** The state of the next authorization request, generated once and checked on the callback. */
  state(): string {
    if (this.expectedState === undefined) {
      this.expectedState = randomBytes(24).toString("base64url");
    }
    return this.expectedState;
  }

  /** Whether a callback's state is the one this process issued. Constant time. */
  stateMatches(candidate: string | null | undefined): boolean {
    if (this.expectedState === undefined || typeof candidate !== "string") return false;
    const a = Buffer.from(this.expectedState, "utf8");
    const b = Buffer.from(candidate, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** The record as the store holds it; loaded once per process. */
  async current(): Promise<CredentialRecord | undefined> {
    if (!this.loaded) {
      this.record = await this.options.store.load(this.options.server);
      this.hadTokens = this.record?.tokens !== undefined;
      this.loaded = true;
    }
    return this.record;
  }

  private async mutable(): Promise<CredentialRecord> {
    const existing = await this.current();
    if (existing) return existing;
    this.record = { version: 1, serverUrl: this.serverUrl };
    return this.record;
  }

  private async persist(): Promise<void> {
    const record = this.record;
    if (!record) return;
    const empty =
      record.tokens === undefined && record.client === undefined && record.discovery === undefined;
    if (empty) {
      await this.options.store.delete(this.options.server);
      this.record = undefined;
      return;
    }
    await this.options.store.save(this.options.server, record);
  }

  async clientInformation(
    _ctx?: OAuthClientInformationContext,
  ): Promise<StoredOAuthClientInformation | undefined> {
    if (this.options.clientId !== undefined) {
      const info: StoredOAuthClientInformation = { client_id: this.options.clientId };
      if (this.options.clientSecret !== undefined) info.client_secret = this.options.clientSecret;
      return info;
    }
    return (await this.current())?.client;
  }

  async saveClientInformation(info: StoredOAuthClientInformation): Promise<void> {
    if (this.options.clientId !== undefined) return;
    const record = await this.mutable();
    record.client = info;
    record.redirectPort = this.redirectPort;
    if (info.issuer !== undefined) record.issuer = info.issuer;
    await this.persist();
  }

  async tokens(_ctx?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    return (await this.current())?.tokens;
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    const record = await this.mutable();
    record.tokens = tokens;
    record.obtainedAt = this.now();
    if (typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in)) {
      record.expiresAt = record.obtainedAt + tokens.expires_in * 1000;
    } else {
      delete record.expiresAt;
    }
    if (tokens.issuer !== undefined) record.issuer = tokens.issuer;
    delete record.codeVerifier;
    await this.persist();
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (this.options.mode === "headless") {
      throw loginRequired(
        this.options.server,
        this.hadTokens ? "previous session expired" : undefined,
      );
    }
    await this.options.onRedirect?.(url);
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    const record = await this.mutable();
    record.codeVerifier = verifier;
    await this.persist();
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.current())?.codeVerifier;
    if (verifier === undefined) {
      throw new ClassifiedError({
        class: "structural",
        code: "oauth_no_verifier",
        message: `${this.options.server}: no PKCE verifier is stored for this login; start it again`,
      });
    }
    return verifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    const record = await this.mutable();
    record.discovery = state;
    await this.persist();
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.current())?.discovery;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    const record = await this.current();
    if (!record) return;
    switch (scope) {
      case "all":
        this.record = undefined;
        await this.options.store.delete(this.options.server);
        return;
      case "client":
        delete record.client;
        delete record.redirectPort;
        break;
      case "tokens":
        delete record.tokens;
        delete record.expiresAt;
        delete record.obtainedAt;
        break;
      case "verifier":
        delete record.codeVerifier;
        break;
      case "discovery":
        delete record.discovery;
        break;
    }
    await this.persist();
  }
}

/**
 * The provider a lane hands to the transport: the SDK's minimal shape, so the
 * transport never runs discovery or registration on its own on a 401.
 *
 * With no record at all the answer is immediate: log in. That keeps a
 * headless 401 from registering a client at the authorization server every
 * time a call runs before anyone has logged in. With a record, the SDK's
 * flow runs and may refresh; a redirect is refused by the provider's mode.
 */
export interface HeadlessAuth extends AuthProvider {
  readonly provider: McpCliOAuthProvider;
  /** Whether this process renewed the token at least once. */
  readonly refreshed: boolean;
}

export function headlessAuth(provider: McpCliOAuthProvider): HeadlessAuth {
  let refreshed = false;
  return {
    provider,
    get refreshed() {
      return refreshed;
    },
    async token() {
      try {
        return (await provider.tokens())?.access_token;
      } catch (err) {
        throw classifyOAuthFailure(err, provider.server);
      }
    },
    async onUnauthorized(ctx) {
      let record: CredentialRecord | undefined;
      try {
        record = await provider.current();
      } catch (err) {
        throw classifyOAuthFailure(err, provider.server);
      }
      const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(ctx.response);
      if (record?.tokens === undefined) {
        // No record: an OAuth challenge means "log in"; a bare 401 from a
        // server that takes a static header means the header is wrong.
        const header = ctx.response.headers.get("www-authenticate") ?? "";
        if (resourceMetadataUrl !== undefined || /^bearer\b/i.test(header)) {
          throw loginRequired(provider.server);
        }
        throw new ClassifiedError({
          class: "auth_required",
          message: `${provider.server}: the server answered HTTP 401 with no OAuth challenge`,
        });
      }
      try {
        const result = await auth(provider, {
          serverUrl: ctx.serverUrl,
          resourceMetadataUrl,
          scope,
          fetchFn: ctx.fetchFn,
        });
        if (result !== "AUTHORIZED") throw loginRequired(provider.server);
        refreshed = true;
      } catch (err) {
        throw classifyOAuthFailure(err, provider.server, { refreshed });
      }
    },
  };
}

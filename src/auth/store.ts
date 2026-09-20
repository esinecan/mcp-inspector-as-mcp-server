/**
 * Where an OAuth credential lives between two processes, and what may be read
 * about it without decrypting.
 *
 * One record per server, under `<stateDir>/auth/`. The record itself is one
 * blob in `<server>.cred`, protected by the cipher of the backend: DPAPI on
 * Windows, so only this user on this machine can open it; a plain file with
 * owner-only permissions where DPAPI does not exist. Next to it a sidecar
 * `<server>.meta.json` holds the fields that are not secret: the issuer, the
 * client id, the scope, the expiry and the time of the last write. Status
 * output, the auth fingerprint and the daemon's staleness check read the
 * sidecar and never the blob, so none of them pays for a decrypt and none of
 * them can leak a token.
 *
 * A record that cannot be read is reported, never silently treated as empty:
 * a corrupt blob means "log in again", and the caller says so.
 */

import { createHash } from "crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import type {
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";

export type CredentialBackend = "dpapi" | "file";

/** Everything the OAuth flow persists for one server. Secret as a whole. */
export interface CredentialRecord {
  version: 1;
  /** The MCP server URL the record was minted for, canonical form. */
  serverUrl: string;
  issuer?: string;
  client?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  /** When the tokens were saved, epoch milliseconds. */
  obtainedAt?: number;
  /** When the access token expires, epoch milliseconds; absent when the server said nothing. */
  expiresAt?: number;
  discovery?: OAuthDiscoveryState;
  /** The loopback port the client was registered with; the AS exact-matches it. */
  redirectPort?: number;
  /** The PKCE verifier between redirect and callback. Cleared once exchanged. */
  codeVerifier?: string;
}

/** The sidecar: what may be printed and persisted in the open. */
export interface CredentialMeta {
  server: string;
  serverUrl: string;
  backend: CredentialBackend;
  issuer?: string;
  clientId?: string;
  scope?: string;
  expiresAt?: number;
  /** Whether a refresh token is held, as a boolean only. */
  refreshable: boolean;
  redirectPort?: number;
  /** Epoch milliseconds of the last write; the auth fingerprint reads this. */
  updatedAt: number;
}

/** A cipher over the blob. The file backend uses the identity cipher. */
export interface CredentialCipher {
  readonly name: CredentialBackend;
  protect(plain: Buffer, entropy: Buffer): Promise<Buffer>;
  unprotect(blob: Buffer, entropy: Buffer): Promise<Buffer>;
}

export interface CredentialStore {
  readonly backend: CredentialBackend;
  readonly dir: string;
  load(server: string): Promise<CredentialRecord | undefined>;
  save(server: string, record: CredentialRecord): Promise<void>;
  /** Remove both files. True when something was removed. */
  delete(server: string): Promise<boolean>;
  /** The sidecar, read without decrypting. */
  meta(server: string): CredentialMeta | undefined;
  /** A short string that changes on every write, empty when no record exists. */
  stamp(server: string): string;
  list(): CredentialMeta[];
}

/** The record could not be opened: wrong user, wrong machine, or a damaged file. */
export class CredentialReadError extends Error {
  constructor(
    readonly server: string,
    detail: string,
  ) {
    super(
      `the stored credential for "${server}" cannot be read (${detail}); run: mcp-cli auth logout ${server} && mcp-cli auth login ${server}`,
    );
  }
}

/** The identity cipher: the file backend's blob is the JSON itself. */
export const PLAIN_CIPHER: CredentialCipher = {
  name: "file",
  protect: async (plain) => plain,
  unprotect: async (blob) => blob,
};

/** The canonical form of a server URL: lowercase scheme and host, no trailing slash, no fragment. */
export function canonicalServerUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
}

/** The entropy that binds a blob to one server URL, so a copied blob does not open under another name. */
export function entropyFor(serverUrl: string): Buffer {
  return createHash("sha256").update(canonicalServerUrl(serverUrl), "utf8").digest();
}

/** A server name as a file name. Names hold no dot, but may hold anything else. */
function fileStem(server: string): string {
  return encodeURIComponent(server);
}

export function credentialStore(
  dir: string,
  cipher: CredentialCipher = PLAIN_CIPHER,
  now: () => number = Date.now,
): CredentialStore {
  const blobPath = (server: string) => join(dir, `${fileStem(server)}.cred`);
  const metaPath = (server: string) => join(dir, `${fileStem(server)}.meta.json`);

  const readMeta = (server: string): CredentialMeta | undefined => {
    const path = metaPath(server);
    if (!existsSync(path)) return undefined;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<CredentialMeta>;
      if (typeof raw.updatedAt !== "number" || typeof raw.serverUrl !== "string") return undefined;
      return { ...raw, server, refreshable: raw.refreshable === true } as CredentialMeta;
    } catch {
      return undefined;
    }
  };

  const ensureDir = () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Windows has no mode bits; DPAPI is the boundary there.
    }
  };

  const writeAtomic = (path: string, data: Buffer | string) => {
    const tmp = join(dir, `.${process.pid}.${now()}.${Math.random().toString(36).slice(2)}.tmp`);
    writeFileSync(tmp, data, { mode: 0o600 });
    try {
      renameSync(tmp, path);
    } catch {
      writeFileSync(path, data, { mode: 0o600 });
      rmSync(tmp, { force: true });
    }
    try {
      chmodSync(path, 0o600);
    } catch {
      // See above.
    }
  };

  return {
    backend: cipher.name,
    dir,

    async load(server) {
      const path = blobPath(server);
      if (!existsSync(path)) return undefined;
      const meta = readMeta(server);
      const serverUrl = meta?.serverUrl;
      if (serverUrl === undefined) throw new CredentialReadError(server, "its sidecar is missing");
      let plain: Buffer;
      try {
        const raw = readFileSync(path);
        const blob =
          cipher.name === "file" ? raw : Buffer.from(raw.toString("utf8").trim(), "base64");
        plain = await cipher.unprotect(blob, entropyFor(serverUrl));
      } catch (err) {
        throw new CredentialReadError(server, (err as Error).message);
      }
      let record: CredentialRecord;
      try {
        record = JSON.parse(plain.toString("utf8")) as CredentialRecord;
      } catch {
        throw new CredentialReadError(server, "the decrypted content is not JSON");
      }
      if (record.version !== 1 || typeof record.serverUrl !== "string") {
        throw new CredentialReadError(server, "unknown record version");
      }
      return record;
    },

    async save(server, record) {
      ensureDir();
      const serverUrl = canonicalServerUrl(record.serverUrl);
      const stored: CredentialRecord = { ...record, serverUrl };
      const plain = Buffer.from(JSON.stringify(stored), "utf8");
      const blob = await cipher.protect(plain, entropyFor(serverUrl));
      const meta: CredentialMeta = {
        server,
        serverUrl,
        backend: cipher.name,
        refreshable: typeof stored.tokens?.refresh_token === "string",
        updatedAt: now(),
      };
      if (stored.issuer !== undefined) meta.issuer = stored.issuer;
      if (stored.client?.client_id !== undefined) meta.clientId = stored.client.client_id;
      if (stored.tokens?.scope !== undefined) meta.scope = stored.tokens.scope;
      if (stored.expiresAt !== undefined) meta.expiresAt = stored.expiresAt;
      if (stored.redirectPort !== undefined) meta.redirectPort = stored.redirectPort;
      // The sidecar first, so a reader that sees the blob also sees its serverUrl.
      writeAtomic(metaPath(server), `${JSON.stringify(meta, null, 2)}\n`);
      writeAtomic(
        blobPath(server),
        cipher.name === "file" ? plain : `${blob.toString("base64")}\n`,
      );
    },

    async delete(server) {
      const existed = existsSync(blobPath(server)) || existsSync(metaPath(server));
      rmSync(blobPath(server), { force: true });
      rmSync(metaPath(server), { force: true });
      return existed;
    },

    meta: readMeta,

    stamp(server) {
      const meta = readMeta(server);
      return meta ? String(meta.updatedAt) : "";
    },

    list() {
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((name) => name.endsWith(".meta.json"))
        .map((name) => readMeta(decodeURIComponent(name.slice(0, -".meta.json".length))))
        .filter((meta): meta is CredentialMeta => meta !== undefined)
        .sort((a, b) => a.server.localeCompare(b.server));
    },
  };
}

/**
 * `mcp-cli auth <login|status|logout|refresh> [server]`: the credential a
 * URL server is called with, and the one command that may open a browser.
 *
 * Nothing here prints a token. Status reads the sidecar, which holds none;
 * login reports what the server granted and when it expires; logout removes
 * both files. Every failure leaves as a classified report, so an agent that
 * reads the envelope knows whether the next move is a login or a fix.
 */

import type { ParsedArgs } from "./args.js";
import { BlockedError, UsageError } from "./errors.js";
import { loadFleet } from "./fleet.js";
import { Output } from "./output.js";
import { authSettings, credentialStoreFor, login, refresh } from "../auth/index.js";
import { canonicalServerUrl, type CredentialMeta } from "../auth/store.js";
import { openBrowser } from "../auth/browser.js";
import { ClassifiedError } from "../supervise/classify.js";
import { SupervisedError, newTrace } from "../supervise/index.js";

const EXIT_OK = 0;

type CredentialState = "none" | "valid" | "expiring" | "expired" | "refreshable" | "stale-url";

/** One row of `auth status`. Nothing in it is secret. */
export interface StatusRow {
  server: string;
  serverUrl?: string;
  backend: string;
  state: CredentialState;
  issuer?: string;
  clientId?: string;
  scope?: string;
  expiresAt?: string;
  refreshable: boolean;
  redirectPort?: number;
  updatedAt?: string;
}

/** Five minutes: a token that expires within it is reported as expiring. */
const EXPIRING_MS = 5 * 60_000;

export function stateOf(
  meta: CredentialMeta | undefined,
  now = Date.now(),
  entryUrl?: string,
): CredentialState {
  if (
    meta &&
    entryUrl !== undefined &&
    canonicalServerUrl(meta.serverUrl) !== canonicalServerUrl(entryUrl)
  ) {
    return "stale-url";
  }
  if (!meta || !meta.hasAccessToken) return meta?.refreshable ? "refreshable" : "none";
  if (meta.expiresAt === undefined) return "valid";
  if (meta.expiresAt <= now) return meta.refreshable ? "refreshable" : "expired";
  if (meta.expiresAt - now < EXPIRING_MS) return "expiring";
  return "valid";
}

export function statusRow(
  server: string,
  meta: CredentialMeta | undefined,
  backend: string,
  entryUrl?: string,
): StatusRow {
  const row: StatusRow = {
    server,
    backend: meta?.backend ?? backend,
    state: stateOf(meta, Date.now(), entryUrl),
    refreshable: meta?.refreshable === true,
  };
  if (meta?.serverUrl !== undefined) row.serverUrl = meta.serverUrl;
  if (meta?.issuer !== undefined) row.issuer = meta.issuer;
  if (meta?.clientId !== undefined) row.clientId = meta.clientId;
  if (meta?.scope !== undefined) row.scope = meta.scope;
  if (meta?.expiresAt !== undefined) row.expiresAt = new Date(meta.expiresAt).toISOString();
  if (meta?.redirectPort !== undefined) row.redirectPort = meta.redirectPort;
  if (meta?.updatedAt !== undefined) row.updatedAt = new Date(meta.updatedAt).toISOString();
  return row;
}

function renderRow(row: StatusRow): string {
  const parts = [`${row.server.padEnd(16)} ${row.state.padEnd(11)} ${row.backend}`];
  if (row.expiresAt) parts.push(`expires=${row.expiresAt}`);
  parts.push(`refreshable=${row.refreshable ? "yes" : "no"}`);
  if (row.scope) parts.push(`scope="${row.scope}"`);
  if (row.issuer) parts.push(`issuer=${row.issuer}`);
  if (row.clientId) parts.push(`client=${row.clientId}`);
  return parts.join("  ");
}

export async function cmdAuth(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[0];
  const out = new Output(args.json);
  const fleet = loadFleet({ config: args.config, profile: args.profile });
  const store = credentialStoreFor(fleet.config);
  const settings = authSettings(fleet.config);

  const serverArg = (): string => {
    const query = args.positionals[1];
    if (!query) throw new UsageError(`auth ${sub} needs a server name`);
    const server = fleet.resolveServer(query);
    const entry = fleet.entry(server);
    if (!entry.url) {
      throw new UsageError(`${server} is a stdio server; OAuth applies to "url" servers only`);
    }
    // A profile that blocks every tool of the server blocks its login too:
    // a credential nothing may use is a credential nobody should mint.
    const whole = [`${server}.*`, `${server}.**`, "*.*", "**"];
    const blocked = fleet.profile.block.find((pattern) => whole.includes(pattern));
    if (blocked !== undefined) {
      throw new BlockedError(
        `${server} is blocked entirely by profile "${fleet.profile.name}" (pattern "${blocked}")`,
      );
    }
    return server;
  };

  /** A classified failure becomes the same envelope a call would print. */
  const supervised = (server: string, err: unknown): never => {
    if (err instanceof ClassifiedError) {
      throw new SupervisedError({
        ...err.toClassified(),
        server,
        operation: `auth ${sub}`,
        attempts: 1,
        trace: newTrace(),
        elapsedMs: 0,
      });
    }
    throw err;
  };

  switch (sub) {
    case "login": {
      const server = serverArg();
      if (store.backend === "file" && process.platform === "win32") {
        out.note(
          `auth.store is "file": the credential is written in the clear under ${store.dir}; "dpapi" binds it to this Windows user`,
        );
      }
      try {
        const summary = await login({
          server,
          entry: fleet.entry(server),
          store,
          settings,
          scope: args.scope,
          callbackPort: args.callbackPort,
          timeoutMs: args.timeoutMs ?? 300_000,
          onUrl: (url) => {
            out.note(`Open this URL to sign in:\n  ${url}`);
            if (!args.noBrowser && openBrowser(url)) out.note("(a browser window was opened)");
            out.note("Waiting for the authorization to come back on the loopback callback…");
          },
        });
        out.emit({ ok: true, ...summary }, () =>
          [
            `${server}: signed in via ${summary.via}`,
            summary.issuer ? `  issuer      ${summary.issuer}` : undefined,
            summary.clientId ? `  client      ${summary.clientId}` : undefined,
            `  scope       ${summary.scope ?? "(none granted)"}`,
            `  expires     ${summary.expiresAt ?? "(the server set no expiry)"}`,
            `  refreshable ${summary.refreshable ? "yes" : "no"}`,
            `  tools       ${summary.tools}`,
          ]
            .filter((line): line is string => line !== undefined)
            .join("\n"),
        );
        return EXIT_OK;
      } catch (err) {
        return supervised(server, err);
      }
    }
    case "status": {
      const query = args.positionals[1];
      const rows: StatusRow[] =
        query === undefined
          ? fleet
              .names()
              .filter((name) => fleet.entry(name).url !== undefined)
              .map((name) =>
                statusRow(name, store.meta(name), store.backend, fleet.entry(name).url),
              )
          : [
              statusRow(
                fleet.resolveServer(query),
                store.meta(fleet.resolveServer(query)),
                store.backend,
                fleet.entry(fleet.resolveServer(query)).url,
              ),
            ];
      out.emit({ store: store.dir, backend: store.backend, servers: rows }, () =>
        rows.length === 0
          ? `(no url servers configured; store ${store.dir})`
          : [...rows.map(renderRow), `store ${store.dir}`].join("\n"),
      );
      return EXIT_OK;
    }
    case "logout": {
      const server = serverArg();
      const removed = await store.delete(server);
      out.emit({ ok: true, server, removed }, () =>
        removed ? `${server}: credential removed` : `${server}: no credential was stored`,
      );
      return EXIT_OK;
    }
    case "refresh": {
      const server = serverArg();
      try {
        const summary = await refresh({ server, entry: fleet.entry(server), store, settings });
        out.emit({ ok: true, ...summary }, () =>
          [
            `${server}: token renewed`,
            `  expires     ${summary.expiresAt ?? "(the server set no expiry)"}`,
            `  refreshable ${summary.refreshable ? "yes" : "no"}`,
          ].join("\n"),
        );
        return EXIT_OK;
      } catch (err) {
        return supervised(server, err);
      }
    }
    default:
      throw new UsageError(
        `auth needs one of: login, status, logout, refresh${sub ? ` (got "${sub}")` : ""}`,
      );
  }
}

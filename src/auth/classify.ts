/**
 * What an OAuth failure means to the supervisor.
 *
 * The SDK throws typed errors from three places: the flow (`auth()`), the
 * transport's 401 retry, and the transport's 403 step-up. Every one of them
 * is sorted here into one of the eight failure classes with an `oauth_*`
 * code and a remediation that names the command to run, so an agent reading
 * the envelope knows whether a login, a re-login or a config change is the
 * next move, and never retries an operation that a human step must precede.
 */

import {
  AuthorizationServerMismatchError,
  InsecureTokenEndpointError,
  InsufficientScopeError,
  IssuerMismatchError,
  OAuthError,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { ClassifiedError } from "../supervise/classify.js";
import { redact } from "../supervise/redact.js";
import { CredentialReadError } from "./store.js";
import { DpapiError } from "./dpapi.js";

/** Whether a thrown value came out of the SDK's OAuth machinery or this module. */
export function isOAuthFailure(err: unknown): boolean {
  return (
    err instanceof ClassifiedError ||
    err instanceof CredentialReadError ||
    err instanceof DpapiError ||
    err instanceof InsufficientScopeError ||
    err instanceof UnauthorizedError ||
    err instanceof InsecureTokenEndpointError ||
    err instanceof AuthorizationServerMismatchError ||
    err instanceof IssuerMismatchError ||
    err instanceof OAuthError
  );
}

export function loginRemediation(server: string, scope?: string): string {
  const flag = scope ? ` --scope "${scope}"` : "";
  return `Run: mcp-cli auth login ${server}${flag}`;
}

/** The failure a headless lane reports when only a login can help. */
export function loginRequired(server: string, detail?: string): ClassifiedError {
  const why = detail ? ` (${detail})` : "";
  return new ClassifiedError({
    class: "auth_required",
    code: "oauth_login_required",
    message: `${server}: the server requires an OAuth login${why}`,
    remediation: loginRemediation(server),
  });
}

/**
 * Sort a failure that came out of the OAuth machinery. `refreshed` says
 * whether this process already renewed the token once, which turns a second
 * 401 from "log in" into "the server rejects the token it just issued".
 */
export function classifyOAuthFailure(
  err: unknown,
  server: string,
  context: { refreshed?: boolean } = {},
): ClassifiedError {
  if (err instanceof ClassifiedError) return err;
  if (err instanceof CredentialReadError || err instanceof DpapiError) {
    return new ClassifiedError({
      class: "auth_required",
      code: "oauth_store_unreadable",
      message: redact(err.message),
      remediation: `Run: mcp-cli auth logout ${server} && mcp-cli auth login ${server}`,
    });
  }
  if (err instanceof InsufficientScopeError) {
    const scope = err.requiredScope;
    return new ClassifiedError({
      class: "auth_required",
      code: "oauth_insufficient_scope",
      message: redact(
        `${server}: the server needs scope "${scope ?? "(unnamed)"}"${
          err.errorDescription ? `: ${err.errorDescription}` : ""
        }`,
      ),
      remediation: loginRemediation(server, scope),
    });
  }
  if (err instanceof UnauthorizedError) {
    return context.refreshed
      ? new ClassifiedError({
          class: "auth_required",
          code: "oauth_token_rejected",
          message: `${server}: the server rejected a freshly renewed token`,
          remediation: `Run: mcp-cli auth logout ${server} && mcp-cli auth login ${server}`,
        })
      : loginRequired(server);
  }
  if (
    err instanceof InsecureTokenEndpointError ||
    err instanceof AuthorizationServerMismatchError ||
    err instanceof IssuerMismatchError
  ) {
    return new ClassifiedError({
      class: "structural",
      code: `oauth_${err.constructor.name
        .replace(/Error$/, "")
        .replace(/([a-z])([A-Z])/g, "$1_$2")
        .toLowerCase()}`,
      message: redact(`${server}: ${err.message}`),
      remediation: `The authorization server does not fit the flow; see: mcp-cli auth status ${server}`,
    });
  }
  if (err instanceof OAuthError) {
    return new ClassifiedError({
      class: "structural",
      code: `oauth_${err.code}`,
      message: redact(`${server}: the authorization server answered ${err.code}: ${err.message}`),
      remediation: `The authorization server refused the flow; see: mcp-cli auth status ${server}`,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(message)) {
    return new ClassifiedError({
      class: "transient",
      code: "oauth_unreachable",
      message: redact(`${server}: the authorization server could not be reached: ${message}`),
    });
  }
  return new ClassifiedError({
    class: "auth_required",
    code: "oauth_failed",
    message: redact(`${server}: ${message}`),
    remediation: loginRemediation(server),
  });
}

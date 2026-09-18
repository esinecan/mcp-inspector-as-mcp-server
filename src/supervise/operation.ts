/**
 * The operations the executor performs, named as data.
 *
 * A caller hands the executor an operation, never a callback. That is the
 * whole reason the executor may retry: a callback could hold a write, and a
 * replayed write is the one thing a retry must never do. An operation says
 * what it is, so the policy module can tell a read from a call and a call to
 * a read-only tool from a call to an unknown one.
 *
 * The seven kinds are the seven a `ServerSession` performs and the seven the
 * daemon's wire format names, so adding an eighth means adding it in the
 * lanes, the daemon core and here.
 */

import type {
  ConnectionInfo,
  PromptDescriptor,
  PromptResult,
  ResourceDescriptor,
  ResourceResult,
  ToolDescriptor,
  ToolResult,
} from "../cli/server-session.js";

export type Operation =
  | { kind: "info" }
  | { kind: "listTools" }
  | { kind: "callTool"; name: string; args: Record<string, unknown> }
  | { kind: "listResources" }
  | { kind: "readResource"; uri: string }
  | { kind: "listPrompts" }
  | { kind: "getPrompt"; name: string; args: Record<string, string> };

export type OperationKind = Operation["kind"];

/** The result each kind resolves to, so `execute` is typed by its operation. */
export type ResultOf<O extends Operation> = O extends { kind: "info" }
  ? ConnectionInfo
  : O extends { kind: "listTools" }
    ? ToolDescriptor[]
    : O extends { kind: "callTool" }
      ? ToolResult
      : O extends { kind: "listResources" }
        ? ResourceDescriptor[] | null
        : O extends { kind: "readResource" }
          ? ResourceResult
          : O extends { kind: "listPrompts" }
            ? PromptDescriptor[] | null
            : O extends { kind: "getPrompt" }
              ? PromptResult
              : never;

/**
 * The kinds that read and never write, by the protocol's own definition. A
 * prompt is a template the server renders; reading a resource is a read. Only
 * `callTool` can write, and whether one call does is answered by the policy
 * module from the tool's annotations and the roster.
 */
export const BUILT_IN_READS: ReadonlySet<OperationKind> = new Set([
  "info",
  "listTools",
  "listResources",
  "readResource",
  "listPrompts",
  "getPrompt",
]);

/**
 * The target an operation names within its server: the tool, the resource
 * URI, the prompt, or nothing. Used to key structural circuits and to label
 * events, never to decide policy.
 */
export function targetOf(op: Operation): string | undefined {
  switch (op.kind) {
    case "callTool":
    case "getPrompt":
      return op.name;
    case "readResource":
      return op.uri;
    default:
      return undefined;
  }
}

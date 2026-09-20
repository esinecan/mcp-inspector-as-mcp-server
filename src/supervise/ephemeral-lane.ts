/**
 * The lane that launches the server here.
 *
 * A session opened for one operation stays open for the rest of this
 * process, so a `call` that lists the tools and then calls one launches the
 * server once, as it always has. The executor invalidates a session it
 * decided is dead, and closes every session when the command ends. Nothing
 * survives the process: this is the behaviour a run has with no daemon.
 */

import type { Fleet } from "../cli/fleet.js";
import { openSession, type OpenSession } from "../cli/server-session.js";
import type { CredentialStore } from "../auth/store.js";
import type { Lane, AttemptContext } from "./lane.js";
import type { Operation } from "./operation.js";

export class EphemeralLane implements Lane {
  readonly name = "ephemeral";
  private readonly sessions = new Map<string, Promise<OpenSession>>();

  constructor(
    private readonly fleet: Fleet,
    private readonly env: NodeJS.ProcessEnv = process.env,
    /** Where OAuth credentials are read from; absent means no OAuth on this lane. */
    private readonly authStore?: CredentialStore,
  ) {}

  async perform(server: string, op: Operation, ctx: AttemptContext): Promise<unknown> {
    const session = await this.session(server, ctx.budgetMs);
    return session.perform(op, ctx.budgetMs);
  }

  private session(server: string, timeoutMs?: number): Promise<OpenSession> {
    let pending = this.sessions.get(server);
    if (!pending) {
      pending = openSession(this.fleet, server, {
        timeoutMs,
        env: this.env,
        authStore: this.authStore,
      });
      this.sessions.set(server, pending);
      // A connect that fails leaves no session behind, so the next attempt
      // connects again rather than re-awaiting the same rejection.
      pending.catch(() => {
        if (this.sessions.get(server) === pending) this.sessions.delete(server);
      });
    }
    return pending;
  }

  async invalidate(server: string): Promise<void> {
    const pending = this.sessions.get(server);
    this.sessions.delete(server);
    if (!pending) return;
    try {
      await (await pending).close();
    } catch {
      // A session that never opened has nothing to close.
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((server) => this.invalidate(server)));
  }
}

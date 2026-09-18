/**
 * The lane a test drives: a script says what each perform does.
 *
 * A step is a value to return, an error to throw, or a function that decides
 * on the spot and may wait. Steps are consumed in order per server, and a
 * server with no step left answers with the lane's default. Every perform is
 * recorded, so a test asserts on the sequence of attempts the executor made,
 * which is the deep interface's whole observable behaviour.
 */

import type { AttemptContext, Lane } from "./lane.js";
import type { Operation } from "./operation.js";

export type Step =
  | { value: unknown }
  | { throws: unknown }
  | { run: (op: Operation, ctx: AttemptContext) => Promise<unknown> | unknown };

export interface PerformRecord {
  server: string;
  op: Operation;
  ctx: AttemptContext;
  at: number;
}

export class ScriptedLane implements Lane {
  readonly performs: PerformRecord[] = [];
  readonly invalidated: string[] = [];
  closed = false;
  private readonly steps = new Map<string, Step[]>();

  constructor(
    readonly name: string = "scripted",
    private readonly fallbackStep: Step = { value: null },
    private readonly now: () => number = Date.now,
  ) {}

  /** Queue steps for one server, in the order they will be consumed. */
  script(server: string, ...steps: Step[]): this {
    this.steps.set(server, [...(this.steps.get(server) ?? []), ...steps]);
    return this;
  }

  async perform(server: string, op: Operation, ctx: AttemptContext): Promise<unknown> {
    this.performs.push({ server, op, ctx, at: this.now() });
    const queue = this.steps.get(server) ?? [];
    const step = queue.length > 0 ? (queue.shift() as Step) : this.fallbackStep;
    if ("throws" in step) throw step.throws;
    if ("run" in step) return step.run(op, ctx);
    return step.value;
  }

  async invalidate(server: string): Promise<void> {
    this.invalidated.push(server);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

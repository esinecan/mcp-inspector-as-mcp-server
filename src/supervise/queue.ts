/**
 * One gate per server: a bounded FIFO in front of a small number of active
 * slots.
 *
 * The gate never spawns a timer of its own. A waiter names its deadline, and
 * the gate checks it when the waiter's turn comes; a waiter whose deadline
 * passed while queued is refused then, in order, so a slot is never handed to
 * a caller that has already given up. The executor counts that refusal
 * against the caller's deadline, which is the rule that queue wait is part of
 * the budget rather than in addition to it.
 */

export class QueueFull extends Error {
  constructor(
    readonly active: number,
    readonly queued: number,
  ) {
    super(`queue full: ${active} active, ${queued} queued`);
  }
}

export class QueueTimeout extends Error {
  constructor(readonly waitedMs: number) {
    super(`deadline passed after ${waitedMs}ms in the queue`);
  }
}

interface Waiter {
  deadlineAt?: number;
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  enqueuedAt: number;
}

export interface GateDepth {
  active: number;
  queued: number;
}

export class Gate {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    readonly concurrency: number,
    readonly maxQueued: number,
    private readonly now: () => number = Date.now,
  ) {}

  depth(): GateDepth {
    return { active: this.active, queued: this.waiters.length };
  }

  /**
   * Wait for a slot. Resolves with the function that gives it back. Rejects
   * at once with `QueueFull` when the queue is at its bound, and with
   * `QueueTimeout` when the deadline passes before a slot is free.
   */
  acquire(deadlineAt?: number): Promise<() => void> {
    if (this.active < this.concurrency && this.waiters.length === 0) {
      this.active += 1;
      return Promise.resolve(this.releaser());
    }
    if (this.waiters.length >= this.maxQueued) {
      return Promise.reject(new QueueFull(this.active, this.waiters.length));
    }
    if (deadlineAt !== undefined && this.now() >= deadlineAt) {
      return Promise.reject(new QueueTimeout(0));
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { deadlineAt, resolve, reject, enqueuedAt: this.now() };
      this.waiters.push(waiter);
      if (deadlineAt !== undefined) {
        const timer = setTimeout(() => this.expire(waiter), Math.max(0, deadlineAt - this.now()));
        if (typeof timer === "object" && "unref" in timer) timer.unref();
        const original = waiter.resolve;
        waiter.resolve = (release) => {
          clearTimeout(timer);
          original(release);
        };
      }
    });
  }

  private expire(waiter: Waiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index === -1) return;
    this.waiters.splice(index, 1);
    waiter.reject(new QueueTimeout(this.now() - waiter.enqueuedAt));
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.admit();
    };
  }

  /** Hand free slots to waiters in order, skipping the ones whose deadline passed. */
  private admit(): void {
    while (this.active < this.concurrency && this.waiters.length > 0) {
      const next = this.waiters.shift() as Waiter;
      if (next.deadlineAt !== undefined && this.now() >= next.deadlineAt) {
        next.reject(new QueueTimeout(this.now() - next.enqueuedAt));
        continue;
      }
      this.active += 1;
      next.resolve(this.releaser());
    }
  }
}

/** Gates keyed by server, built on first use with the limits the caller names. */
export class Gates {
  private readonly gates = new Map<string, Gate>();

  constructor(
    private readonly limits: (server: string) => { concurrency: number; queueLength: number },
    private readonly now: () => number = Date.now,
  ) {}

  for(server: string): Gate {
    let gate = this.gates.get(server);
    if (!gate) {
      const { concurrency, queueLength } = this.limits(server);
      gate = new Gate(concurrency, queueLength, this.now);
      this.gates.set(server, gate);
    }
    return gate;
  }

  depths(): Record<string, GateDepth> {
    const out: Record<string, GateDepth> = {};
    for (const [server, gate] of this.gates) {
      const depth = gate.depth();
      if (depth.active > 0 || depth.queued > 0) out[server] = depth;
    }
    return out;
  }
}

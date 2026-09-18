import { describe, it, expect } from "vitest";
import { Gate, Gates, QueueFull, QueueTimeout } from "./queue.js";

describe("Gate", () => {
  it("hands out slots up to its concurrency and queues the rest in order", async () => {
    const gate = new Gate(2, 4);
    const a = await gate.acquire();
    const b = await gate.acquire();
    expect(gate.depth()).toEqual({ active: 2, queued: 0 });
    const order: string[] = [];
    const c = gate.acquire().then((release) => {
      order.push("c");
      return release;
    });
    const d = gate.acquire().then((release) => {
      order.push("d");
      return release;
    });
    expect(gate.depth()).toEqual({ active: 2, queued: 2 });
    a();
    a(); // a second release of the same slot is ignored
    const releaseC = await c;
    expect(order).toEqual(["c"]);
    b();
    const releaseD = await d;
    expect(order).toEqual(["c", "d"]);
    releaseC();
    releaseD();
    expect(gate.depth()).toEqual({ active: 0, queued: 0 });
  });

  it("refuses the request past the queue bound at once", async () => {
    const gate = new Gate(1, 1);
    const release = await gate.acquire();
    const waiting = gate.acquire();
    await expect(gate.acquire()).rejects.toBeInstanceOf(QueueFull);
    release();
    (await waiting)();
  });

  it("refuses a waiter whose deadline passes while it waits, and one whose deadline already passed", async () => {
    const gate = new Gate(1, 4);
    const release = await gate.acquire();
    await expect(gate.acquire(Date.now() - 1)).rejects.toBeInstanceOf(QueueTimeout);
    const late = gate.acquire(Date.now() + 30);
    await expect(late).rejects.toBeInstanceOf(QueueTimeout);
    release();
    expect(gate.depth()).toEqual({ active: 0, queued: 0 });
  });

  it("skips an expired waiter when a slot frees, so the slot goes to the next live one", async () => {
    let t = 1000;
    const gate = new Gate(1, 4, () => t);
    const release = await gate.acquire();
    const expired = gate.acquire(1500);
    const live = gate.acquire(5000);
    t = 2000;
    release();
    await expect(expired).rejects.toBeInstanceOf(QueueTimeout);
    (await live)();
  });
});

describe("Gates", () => {
  it("builds one gate per server with the limits named for it, and reports only busy ones", async () => {
    const gates = new Gates((server) =>
      server === "one" ? { concurrency: 1, queueLength: 1 } : { concurrency: 3, queueLength: 3 },
    );
    expect(gates.for("one")).toBe(gates.for("one"));
    expect(gates.for("one").concurrency).toBe(1);
    expect(gates.for("two").concurrency).toBe(3);
    expect(gates.depths()).toEqual({});
    const release = await gates.for("one").acquire();
    expect(gates.depths()).toEqual({ one: { active: 1, queued: 0 } });
    release();
  });
});

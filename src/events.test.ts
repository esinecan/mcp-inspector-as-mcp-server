import { describe, it, expect, beforeEach } from "vitest";
import { EventBuffer } from "./events.js";
import type { EventType } from "./events.js";

describe("EventBuffer", () => {
  let buffer: EventBuffer;

  beforeEach(() => {
    buffer = new EventBuffer(5);
  });

  it("starts empty", () => {
    expect(buffer.size()).toBe(0);
    const result = buffer.read();
    expect(result.events).toEqual([]);
    expect(result.bufferSize).toBe(0);
    expect(result.oldestEvent).toBeNull();
    expect(result.newestEvent).toBeNull();
  });

  it("pushes and reads events", () => {
    buffer.push({ type: "notification", data: { msg: "hello" }, timestamp: 1000 });
    buffer.push({ type: "error", data: { msg: "oops" }, timestamp: 2000 });

    expect(buffer.size()).toBe(2);
    const result = buffer.read();
    expect(result.events).toHaveLength(2);
    expect(result.events[0].type).toBe("notification");
    expect(result.events[1].type).toBe("error");
    expect(result.oldestEvent).toBe(1000);
    expect(result.newestEvent).toBe(2000);
  });

  it("auto-assigns timestamp when not provided", () => {
    const before = Date.now();
    buffer.push({ type: "traffic_in", data: null });
    const after = Date.now();

    const result = buffer.read();
    expect(result.events[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(result.events[0].timestamp).toBeLessThanOrEqual(after);
  });

  it("drops oldest events when full (ring buffer behavior)", () => {
    for (let i = 0; i < 7; i++) {
      buffer.push({ type: "notification", data: i, timestamp: i * 100 });
    }

    // maxSize is 5, so events 0 and 1 should be dropped
    expect(buffer.size()).toBe(5);
    const result = buffer.read();
    expect(result.events[0].data).toBe(2);
    expect(result.events[4].data).toBe(6);
    expect(result.oldestEvent).toBe(200);
    expect(result.newestEvent).toBe(600);
  });

  it("filters by since timestamp", () => {
    buffer.push({ type: "notification", data: "a", timestamp: 1000 });
    buffer.push({ type: "notification", data: "b", timestamp: 2000 });
    buffer.push({ type: "notification", data: "c", timestamp: 3000 });

    const result = buffer.read({ since: 1500 });
    expect(result.events).toHaveLength(2);
    expect(result.events[0].data).toBe("b");
    expect(result.events[1].data).toBe("c");
    // bufferSize reflects total, not filtered
    expect(result.bufferSize).toBe(3);
  });

  it("filters by event type", () => {
    buffer.push({ type: "notification", data: 1, timestamp: 100 });
    buffer.push({ type: "error", data: 2, timestamp: 200 });
    buffer.push({ type: "traffic_in", data: 3, timestamp: 300 });
    buffer.push({ type: "traffic_out", data: 4, timestamp: 400 });
    buffer.push({ type: "steering", data: 5, timestamp: 500 });

    const result = buffer.read({ types: ["error", "steering"] });
    expect(result.events).toHaveLength(2);
    expect(result.events[0].type).toBe("error");
    expect(result.events[1].type).toBe("steering");
  });

  it("applies limit (takes most recent)", () => {
    buffer.push({ type: "notification", data: "a", timestamp: 100 });
    buffer.push({ type: "notification", data: "b", timestamp: 200 });
    buffer.push({ type: "notification", data: "c", timestamp: 300 });

    const result = buffer.read({ limit: 2 });
    expect(result.events).toHaveLength(2);
    expect(result.events[0].data).toBe("b");
    expect(result.events[1].data).toBe("c");
  });

  it("combines since + types + limit filters", () => {
    buffer.push({ type: "notification", data: 1, timestamp: 100 });
    buffer.push({ type: "error", data: 2, timestamp: 200 });
    buffer.push({ type: "error", data: 3, timestamp: 300 });
    buffer.push({ type: "notification", data: 4, timestamp: 400 });
    buffer.push({ type: "error", data: 5, timestamp: 500 });

    const result = buffer.read({ since: 150, types: ["error"], limit: 1 });
    expect(result.events).toHaveLength(1);
    expect(result.events[0].data).toBe(5);
  });

  it("clears all events", () => {
    buffer.push({ type: "notification", data: "a", timestamp: 100 });
    buffer.push({ type: "notification", data: "b", timestamp: 200 });
    expect(buffer.size()).toBe(2);

    buffer.clear();
    expect(buffer.size()).toBe(0);
    expect(buffer.read().events).toEqual([]);
  });

  it("uses default maxSize of 1000", () => {
    const defaultBuffer = new EventBuffer();
    for (let i = 0; i < 1001; i++) {
      defaultBuffer.push({ type: "notification", data: i, timestamp: i });
    }
    expect(defaultBuffer.size()).toBe(1000);
    // First event (0) should have been dropped
    const result = defaultBuffer.read({ limit: 1 });
    expect(result.events[0].data).toBe(1000);
  });

  it("handles all EventType values", () => {
    const types: EventType[] = ["notification", "traffic_in", "traffic_out", "error", "steering"];
    types.forEach((type, i) => {
      buffer.push({ type, data: null, timestamp: i });
    });
    expect(buffer.size()).toBe(5);
    const result = buffer.read();
    result.events.forEach((event, i) => {
      expect(event.type).toBe(types[i]);
    });
  });
});

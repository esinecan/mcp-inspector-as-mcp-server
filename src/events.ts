/**
 * Event buffering for MCP Inspector sessions
 * Captures notifications, traffic, and errors in a ring buffer
 */

export type EventType = "notification" | "traffic_in" | "traffic_out" | "error" | "steering";

export interface BufferedEvent {
  timestamp: number;
  type: EventType;
  data: unknown;
}

export interface ReadEventsOptions {
  since?: number; // Epoch ms - return events after this time
  types?: EventType[]; // Filter by event types
  limit?: number; // Max events to return
}

export interface ReadEventsResult {
  events: BufferedEvent[];
  bufferSize: number;
  oldestEvent: number | null;
  newestEvent: number | null;
}

/**
 * Ring buffer for capturing events per session
 * When full, oldest events are dropped to make room for new ones
 */
export class EventBuffer {
  private buffer: BufferedEvent[] = [];
  private maxSize: number;

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }

  /**
   * Add an event to the buffer
   * If buffer is full, drops the oldest event
   */
  push(event: Omit<BufferedEvent, "timestamp"> & { timestamp?: number }): void {
    const fullEvent: BufferedEvent = {
      timestamp: event.timestamp ?? Date.now(),
      type: event.type,
      data: event.data,
    };

    if (this.buffer.length >= this.maxSize) {
      this.buffer.shift(); // Remove oldest
    }
    this.buffer.push(fullEvent);
  }

  /**
   * Read events from the buffer with optional filtering
   */
  read(options: ReadEventsOptions = {}): ReadEventsResult {
    const { since, types, limit } = options;

    let events = this.buffer;

    // Filter by timestamp
    if (since !== undefined) {
      events = events.filter((e) => e.timestamp > since);
    }

    // Filter by type
    if (types && types.length > 0) {
      events = events.filter((e) => types.includes(e.type));
    }

    // Apply limit (take most recent)
    if (limit !== undefined && events.length > limit) {
      events = events.slice(-limit);
    }

    return {
      events,
      bufferSize: this.buffer.length,
      oldestEvent: this.buffer.length > 0 ? this.buffer[0].timestamp : null,
      newestEvent: this.buffer.length > 0 ? this.buffer[this.buffer.length - 1].timestamp : null,
    };
  }

  /**
   * Clear all events from the buffer
   */
  clear(): void {
    this.buffer = [];
  }

  /**
   * Get current buffer size
   */
  size(): number {
    return this.buffer.length;
  }
}

/**
 * Session management for persistent MCP connections
 * Handles connection pooling, lifecycle, and garbage collection
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createTracingTransport, TransportConfig } from "./transport.js";
import { EventBuffer } from "./events.js";
import { randomBytes } from "crypto";

export interface SessionContext {
  id: string;
  client: Client;
  transport: Transport;
  config: TransportConfig;
  createdAt: number;
  lastActive: number;
  eventBuffer: EventBuffer;
  steeringQueue: string[]; // FIFO queue for human steering messages
  serverInfo?: {
    name?: string;
    version?: string;
  };
  capabilities?: Record<string, unknown>;
}

export interface SessionInfo {
  sessionId: string;
  config: TransportConfig;
  createdAt: number;
  lastActive: number;
  idleSeconds: number;
  serverInfo?: {
    name?: string;
    version?: string;
  };
}

export interface ConnectResult {
  sessionId: string;
  serverInfo?: {
    name?: string;
    version?: string;
  };
  capabilities?: Record<string, unknown>;
}

// Configuration
const GC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const EVENT_BUFFER_SIZE = 1000;

/**
 * Generate a short, readable session ID
 */
function generateSessionId(): string {
  return `sess_${randomBytes(6).toString("hex")}`;
}

/**
 * Singleton session registry
 * Manages persistent MCP connections with automatic garbage collection
 */
class SessionRegistry {
  private sessions: Map<string, SessionContext> = new Map();
  private gcInterval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;

  constructor() {
    this.startGarbageCollector();
    this.setupShutdownHandlers();
  }

  /**
   * Start the garbage collector interval
   */
  private startGarbageCollector(): void {
    this.gcInterval = setInterval(() => {
      this.collectGarbage();
    }, GC_INTERVAL_MS);

    // Don't block process exit
    this.gcInterval.unref();
  }

  /**
   * Setup handlers for clean shutdown
   */
  private setupShutdownHandlers(): void {
    const cleanup = async () => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;

      console.error("[SessionRegistry] Shutting down, closing all sessions...");

      if (this.gcInterval) {
        clearInterval(this.gcInterval);
        this.gcInterval = null;
      }

      const closePromises = Array.from(this.sessions.keys()).map((id) =>
        this.disconnect(id).catch((err) =>
          console.error(`[SessionRegistry] Error closing session ${id}:`, err),
        ),
      );

      await Promise.all(closePromises);
      console.error("[SessionRegistry] All sessions closed.");
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
    process.on("exit", () => {
      // Synchronous cleanup - just log
      if (this.sessions.size > 0) {
        console.error(
          `[SessionRegistry] Warning: ${this.sessions.size} sessions not properly closed.`,
        );
      }
    });
  }

  /**
   * Garbage collect idle sessions
   */
  private collectGarbage(): void {
    const now = Date.now();
    const expiredIds: string[] = [];

    for (const [id, session] of this.sessions) {
      const idleTime = now - session.lastActive;
      if (idleTime > SESSION_TTL_MS) {
        expiredIds.push(id);
      }
    }

    for (const id of expiredIds) {
      console.error(`[SessionRegistry] GC: Closing idle session ${id}`);
      this.disconnect(id).catch((err) =>
        console.error(`[SessionRegistry] GC error closing ${id}:`, err),
      );
    }

    if (expiredIds.length > 0) {
      console.error(`[SessionRegistry] GC: Collected ${expiredIds.length} idle sessions`);
    }
  }

  /**
   * Establish a persistent connection to an MCP server
   */
  async connect(config: TransportConfig): Promise<ConnectResult> {
    const id = generateSessionId();
    const eventBuffer = new EventBuffer(EVENT_BUFFER_SIZE);

    // Create tracing transport to capture raw traffic
    const transport = createTracingTransport(config, eventBuffer);

    // Create client
    const client = new Client({ name: "mcp-inspector", version: "2.1.0" });

    // Set fallback notification handler to capture all notifications
    client.fallbackNotificationHandler = async (notification) => {
      eventBuffer.push({
        type: "notification",
        data: notification,
      });
    };

    // Connect to the server
    await client.connect(transport);
    // Get server info from the connection
    const serverInfo = client.getServerVersion();
    const capabilities = client.getServerCapabilities();

    const session: SessionContext = {
      id,
      client,
      transport,
      config,
      createdAt: Date.now(),
      lastActive: Date.now(),
      eventBuffer,
      steeringQueue: [],
      serverInfo: serverInfo
        ? {
            name: serverInfo.name,
            version: serverInfo.version,
          }
        : undefined,
      capabilities: capabilities as Record<string, unknown> | undefined,
    };

    this.sessions.set(id, session);

    return {
      sessionId: id,
      serverInfo: session.serverInfo,
      capabilities: session.capabilities,
    };
  }

  /**
   * Close and remove a session
   */
  async disconnect(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    this.sessions.delete(sessionId);

    try {
      await session.transport.close();
    } catch {
      // Ignore close errors
    }
  }

  /**
   * Get a session by ID
   */
  get(sessionId: string): SessionContext | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Update the lastActive timestamp for a session
   */
  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActive = Date.now();
    }
  }

  /**
   * List all active sessions
   */
  list(): SessionInfo[] {
    const now = Date.now();
    return Array.from(this.sessions.values()).map((session) => ({
      sessionId: session.id,
      config: session.config,
      createdAt: session.createdAt,
      lastActive: session.lastActive,
      idleSeconds: Math.floor((now - session.lastActive) / 1000),
      serverInfo: session.serverInfo,
    }));
  }

  /**
   * Check if a session exists
   */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Inject a steering message into a session's queue
   */
  injectSteering(sessionId: string, message: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    session.steeringQueue.push(message);

    // Also log to event buffer for observability
    session.eventBuffer.push({
      type: "steering" as const,
      data: { message },
    });
  }

  /**
   * Drain all pending steering messages from a session
   * Returns the messages and clears the queue
   */
  drainSteering(sessionId: string): string[] {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return [];
    }
    const messages = [...session.steeringQueue];
    session.steeringQueue = [];
    return messages;
  }

  /**
   * Get the most recently active session ID
   * Used for targeting when no explicit session_id is provided
   */
  getMostRecentSessionId(): string | undefined {
    let mostRecent: SessionContext | undefined;
    for (const session of this.sessions.values()) {
      if (!mostRecent || session.lastActive > mostRecent.lastActive) {
        mostRecent = session;
      }
    }
    return mostRecent?.id;
  }
}

// Export singleton instance
export const sessionRegistry = new SessionRegistry();

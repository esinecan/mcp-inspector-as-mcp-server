#!/usr/bin/env node

/**
 * mcp-steer - CLI tool for injecting steering messages into MCP Inspector sessions
 *
 * Usage:
 *   mcp-steer "your message here"
 *   mcp-steer --session sess_abc123 "your message"
 *   mcp-steer --list
 */

const STEERING_URL = "http://127.0.0.1:9847";

async function main() {
  const args = process.argv.slice(2);

  // Show help
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
mcp-steer - Inject steering messages into MCP Inspector sessions

Usage:
  mcp-steer <message>              Send steering to most recent session
  mcp-steer -s <session_id> <msg>  Send steering to specific session
  mcp-steer --list                 List active sessions
  mcp-steer --help                 Show this help

Examples:
  mcp-steer "focus on error handling"
  mcp-steer --session sess_abc123 "pause after this test"
  mcp-steer -s sess_abc123 "check the logs"
`);
    process.exit(0);
  }

  // List sessions
  if (args.includes("--list") || args.includes("-l")) {
    try {
      const res = await fetch(`${STEERING_URL}/api/sessions`);
      const data = await res.json();

      if (data.count === 0) {
        console.log("No active sessions");
      } else {
        console.log(`Active sessions (${data.count}):\n`);
        for (const session of data.sessions) {
          const idle =
            session.idleSeconds < 60
              ? `${session.idleSeconds}s`
              : `${Math.floor(session.idleSeconds / 60)}m`;
          console.log(`  ${session.sessionId}`);
          console.log(`    Server: ${session.serverInfo?.name || "unknown"}`);
          console.log(`    Idle: ${idle}`);
          console.log();
        }
      }
    } catch (error) {
      console.error("Error: Could not connect to MCP Inspector");
      console.error("Make sure the inspector is running with an active session.");
      process.exit(1);
    }
    return;
  }

  // Parse session ID and message
  let sessionId = undefined;
  let message = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--session" || args[i] === "-s") {
      sessionId = args[i + 1];
      i++; // skip next arg
    } else if (!args[i].startsWith("-")) {
      message = args.slice(i).join(" ");
      break;
    }
  }

  if (!message) {
    console.error("Error: No message provided");
    process.exit(1);
  }

  // Send steering
  try {
    const res = await fetch(`${STEERING_URL}/api/steer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, message }),
    });

    const data = await res.json();

    if (res.ok) {
      console.log(`✓ Steering sent to ${data.session_id}`);
      console.log(`  Message: "${message}"`);
    } else {
      console.error(`Error: ${data.error}`);
      process.exit(1);
    }
  } catch (error) {
    console.error("Error: Could not connect to MCP Inspector");
    console.error("Make sure the inspector is running with an active session.");
    process.exit(1);
  }
}

main();

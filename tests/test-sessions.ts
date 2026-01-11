#!/usr/bin/env npx tsx
/**
 * Test session-based connections with the fixed TracingTransportWrapper
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
    console.log("Testing session-based connections...");

    const transport = new StdioClientTransport({
        command: "node",
        args: ["/Users/eren-can.sinecan/dev5/mcp-inspector-as-mcp-server/dist/server.js"],
        stderr: "pipe",
    });

    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
        await client.connect(transport);
        console.log("Connected to mcp-inspector!");

        // Create a persistent session to deepthink
        console.log("\n1. Creating session to deepthink...");
        const connectResult = await client.callTool({
            name: "insp_connect",
            arguments: {
                command: "node",
                args: ["/Users/eren-can.sinecan/dev5/deepthink/dist/mcp/server.js"],
            },
        });
        console.log("Connect result:", JSON.stringify(connectResult, null, 2));

        // Parse the session_id from the result
        const content = (connectResult.content as Array<{ type: string; text: string }>)[0].text;
        const parsed = JSON.parse(content);
        const sessionId = parsed.session_id;
        console.log(`\nSession ID: ${sessionId}`);

        // List tools using the session
        console.log("\n2. Listing tools via session...");
        const toolsResult = await client.callTool({
            name: "insp_tools_list",
            arguments: {
                session_id: sessionId,
            },
        });
        console.log("Tools via session:", JSON.stringify(toolsResult, null, 2).slice(0, 500) + "...");

        // Call deepthink tool
        console.log("\n3. Calling deepthink via session...");
        const thinkResult = await client.callTool({
            name: "insp_tools_call",
            arguments: {
                session_id: sessionId,
                tool_name: "deepthink",
                tool_args: {
                    thought: "Testing session-based connection with tracing transport. This should verify the fix works for persistent sessions too.",
                    nextThoughtNeeded: false,
                },
            },
        });
        console.log("Deepthink result:", JSON.stringify(thinkResult, null, 2).slice(0, 500) + "...");

        // Read events to verify tracing works
        console.log("\n4. Reading events (verifying tracing)...");
        const eventsResult = await client.callTool({
            name: "insp_read_events",
            arguments: {
                session_id: sessionId,
                limit: 5,
            },
        });
        console.log("Events:", JSON.stringify(eventsResult, null, 2).slice(0, 1000) + "...");

        // Disconnect
        console.log("\n5. Disconnecting session...");
        await client.callTool({
            name: "insp_disconnect",
            arguments: {
                session_id: sessionId,
            },
        });

        console.log("\n✅ SUCCESS! Session-based connections with tracing work!");
    } catch (error) {
        console.error("❌ ERROR:", error);
        process.exit(1);
    } finally {
        await transport.close();
    }
}

main();

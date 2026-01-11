#!/usr/bin/env node

/**
 * Integration test for MCP Inspector session management
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "child_process";

async function main() {
    console.log("=== MCP Inspector Session Management Test ===\n");

    // Spawn the inspector server
    const serverProcess = spawn("node", ["dist/server.js"], {
        stdio: ["pipe", "pipe", "pipe"],
    });

    const transport = new StdioClientTransport({
        command: "node",
        args: ["dist/server.js"],
    });

    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
        await client.connect(transport);
        console.log("✓ Connected to inspector server\n");

        // Test 1: List tools
        console.log("Test 1: List tools");
        const tools = await client.listTools();
        const toolNames = tools.tools.map(t => t.name);
        console.log("  Tools:", toolNames.join(", "));

        const hasSessionTools =
            toolNames.includes("insp_connect") &&
            toolNames.includes("insp_disconnect") &&
            toolNames.includes("insp_list_sessions") &&
            toolNames.includes("insp_read_events");
        console.log("  Session tools present:", hasSessionTools ? "✓" : "✗");

        // Test 2: List sessions (should be empty)
        console.log("\nTest 2: List sessions (expect empty)");
        const listResult1 = await client.callTool({
            name: "insp_list_sessions",
            arguments: {},
        });
        console.log("  Result:", JSON.stringify(listResult1, null, 2));

        // Test 3: Create a session to the inspector itself (recursive, just to test connectivity)
        console.log("\nTest 3: Create session to inspector itself");
        const connectResult = await client.callTool({
            name: "insp_connect",
            arguments: {
                command: "node",
                args: ["dist/server.js"],
            },
        });
        console.log("  Result:", JSON.stringify(connectResult, null, 2));

        // Extract session_id from result
        const connectData = JSON.parse((connectResult as any).content[0].text);
        const sessionId = connectData.session_id;
        console.log("  Session ID:", sessionId);

        if (sessionId) {
            // Test 4: List sessions (should have 1)
            console.log("\nTest 4: List sessions (expect 1)");
            const listResult2 = await client.callTool({
                name: "insp_list_sessions",
                arguments: {},
            });
            console.log("  Result:", JSON.stringify(listResult2, null, 2));

            // Test 5: Use session to list tools
            console.log("\nTest 5: List tools using session");
            const toolsResult = await client.callTool({
                name: "insp_tools_list",
                arguments: { session_id: sessionId },
            });
            console.log("  Result:", JSON.stringify(toolsResult, null, 2));

            // Test 6: Read events (should have traffic from the tools list call)
            console.log("\nTest 6: Read all events from session");
            const eventsResult = await client.callTool({
                name: "insp_read_events",
                arguments: { session_id: sessionId },
            });
            const eventsData = JSON.parse((eventsResult as any).content[0].text);
            console.log("  Buffer size:", eventsData.buffer_size);
            console.log("  Event types:", eventsData.events.map((e: any) => e.type).join(", "));
            console.log("  Has traffic_out:", eventsData.events.some((e: any) => e.type === 'traffic_out'));
            console.log("  Has traffic_in:", eventsData.events.some((e: any) => e.type === 'traffic_in'));

            // Test 6b: Filter events by type
            console.log("\nTest 6b: Read only traffic_out events");
            const trafficResult = await client.callTool({
                name: "insp_read_events",
                arguments: { session_id: sessionId, types: ["traffic_out"], limit: 3 },
            });
            console.log("  Result:", JSON.stringify(trafficResult, null, 2));


            // Test 7: Disconnect session
            console.log("\nTest 7: Disconnect session");
            const disconnectResult = await client.callTool({
                name: "insp_disconnect",
                arguments: { session_id: sessionId },
            });
            console.log("  Result:", JSON.stringify(disconnectResult, null, 2));

            // Test 8: List sessions (should be empty again)
            console.log("\nTest 8: List sessions (expect empty)");
            const listResult3 = await client.callTool({
                name: "insp_list_sessions",
                arguments: {},
            });
            console.log("  Result:", JSON.stringify(listResult3, null, 2));
        }

        console.log("\n=== All tests completed ===");
    } catch (error) {
        console.error("Error:", error);
    } finally {
        await transport.close();
        serverProcess.kill();
    }
}

main();

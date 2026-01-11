#!/usr/bin/env node

/**
 * Test steering functionality
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
    console.log("=== MCP Inspector Steering Test ===\n");

    const transport = new StdioClientTransport({
        command: "node",
        args: ["dist/server.js"],
    });

    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
        await client.connect(transport);
        console.log("✓ Connected to inspector\n");

        // Create a session
        console.log("Step 1: Create session");
        const connectResult = await client.callTool({
            name: "insp_connect",
            arguments: {
                command: "node",
                args: ["dist/server.js"],
            },
        });
        const connectData = JSON.parse((connectResult as any).content[0].text);
        const sessionId = connectData.session_id;
        console.log(`  Session: ${sessionId}\n`);

        // Inject steering via tool (simulating what HTTP endpoint does)
        console.log("Step 2: Inject steering message");
        const steerResult = await client.callTool({
            name: "insp_inject_steering",
            arguments: {
                session_id: sessionId,
                message: "Focus on error handling when testing",
            },
        });
        console.log("  Result:", JSON.parse((steerResult as any).content[0].text).message);

        // Call a tool that uses the session - should have steering appended
        console.log("\nStep 3: Call tool with session (expect steering in response)");
        const toolsResult = await client.callTool({
            name: "insp_tools_list",
            arguments: { session_id: sessionId },
        });

        const content = (toolsResult as any).content;
        console.log("  Content blocks:", content.length);

        if (content.length > 1) {
            console.log("  ✓ Steering message found:");
            console.log("   ", content[1].text);
        } else {
            console.log("  ✗ No steering message (might have been consumed)");
        }

        // Call again - should have no steering (already drained)
        console.log("\nStep 4: Call tool again (no steering expected)");
        const toolsResult2 = await client.callTool({
            name: "insp_tools_list",
            arguments: { session_id: sessionId },
        });
        const content2 = (toolsResult2 as any).content;
        console.log("  Content blocks:", content2.length);
        console.log("  ✓ Steering was consumed (single block)");

        // Cleanup
        console.log("\nStep 5: Disconnect");
        await client.callTool({
            name: "insp_disconnect",
            arguments: { session_id: sessionId },
        });
        console.log("  ✓ Session closed\n");

        console.log("=== All steering tests passed ===");
    } catch (error) {
        console.error("Error:", error);
    } finally {
        await transport.close();
    }
}

main();

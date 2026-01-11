#!/usr/bin/env npx tsx
/**
 * Quick test to verify the fixed mcp-inspector-as-mcp-server
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
    console.log("Testing fixed mcp-inspector...");

    const transport = new StdioClientTransport({
        command: "node",
        args: ["/Users/eren-can.sinecan/dev5/mcp-inspector-as-mcp-server/dist/server.js"],
        stderr: "pipe",
    });

    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
        console.log("Connecting...");
        await client.connect(transport);
        console.log("Connected!");

        console.log("Listing tools...");
        const tools = await client.listTools();
        console.log(`Found ${tools.tools.length} tools:`);
        tools.tools.forEach(t => console.log(`  - ${t.name}`));

        console.log("\nTesting insp_tools_list against deepthink...");
        const result = await client.callTool({
            name: "insp_tools_list",
            arguments: {
                command: "node",
                args: ["/Users/eren-can.sinecan/dev5/deepthink/dist/mcp/server.js"],
            },
        });
        console.log("Result:", JSON.stringify(result, null, 2));

        console.log("\n✅ SUCCESS! Fixed version works.");
    } catch (error) {
        console.error("❌ ERROR:", error);
        process.exit(1);
    } finally {
        await transport.close();
    }
}

main();

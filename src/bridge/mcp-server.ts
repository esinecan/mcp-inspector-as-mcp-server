/**
 * The MCP adapter: a stdio server with one tool, `host_exec`.
 *
 * It is a peer of the HTTP adapter, not a layer over it. Both call
 * `execBridged` directly, so the two surfaces cannot drift apart. The tool
 * arguments are passed on unchecked, because `execBridged` is the single place
 * that checks them.
 *
 * A non-zero exit is an ordinary result, not a tool error. `isError` is set
 * only when the bridge could not start the command at all. An agent that reads
 * a failed build's exit code should not also have to unwrap an error envelope.
 */

import { Server, type Tool } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { execBridged, bridgeErrorMessage, type ExecOptions } from "./exec.js";

export const HOST_EXEC = "host_exec";

/** The tool definition, built here so the path contract is stated once. */
export function hostExecTool(containerRoot: string, hostRoot: string): Tool {
  return {
    name: HOST_EXEC,
    description:
      `Run a command in a cmd.exe shell on the Windows host and return {exit, stdout, stderr}. ` +
      `Use container paths: ${containerRoot} is the same folder as ${hostRoot} on the host, and the bridge ` +
      `rewrites that prefix in the command, in cwd, and back again in the output. ` +
      `There is no allowlist and no command filtering; narrowing is done by the mcp-cli profile blocklist. ` +
      `A non-zero exit is a normal result. Exit 124 means the timeout ran out.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        cmd: {
          type: "string" as const,
          description: `The command line, written with ${containerRoot} paths.`,
        },
        cwd: {
          type: "string" as const,
          description: `Working directory, written with ${containerRoot} paths. Defaults to ${containerRoot}.`,
        },
        stdin: {
          type: "string" as const,
          description: "Text written to the command's standard input.",
        },
        timeout: {
          type: "number" as const,
          description: "Budget in seconds. Exceeding it returns exit 124 with the partial stdout.",
        },
      },
      required: ["cmd"],
    },
  };
}

export interface BridgeMcpOptions extends ExecOptions {
  name?: string;
  version?: string;
}

/** Build the server. The caller connects it to a transport. */
export function createBridgeMcpServer(options: BridgeMcpOptions): Server {
  const server = new Server(
    { name: options.name ?? "host-bridge", version: options.version ?? "1.0.0" },
    { capabilities: { tools: {} } },
  );

  const tool = hostExecTool(options.pathMap.containerRoot, options.pathMap.hostRoot);

  server.setRequestHandler("tools/list", async () => ({ tools: [tool] }));

  server.setRequestHandler("tools/call", async (request) => {
    const { name, arguments: args } = request.params;
    if (name !== HOST_EXEC) {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ error: `unknown tool ${name}` }) },
        ],
        isError: true,
      };
    }
    try {
      const result = await execBridged(args ?? {}, options);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const message = bridgeErrorMessage(err);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  });

  return server;
}

/** Serve `host_exec` over stdio until the client disconnects. */
export async function serveBridgeMcp(options: BridgeMcpOptions): Promise<void> {
  const server = createBridgeMcpServer(options);
  await server.connect(new StdioServerTransport());
}

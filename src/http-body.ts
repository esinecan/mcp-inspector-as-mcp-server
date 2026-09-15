/**
 * Reading a request body off a socket, for the two loopback HTTP surfaces this
 * repo serves: the host bridge and the mcp-cli warm daemon.
 *
 * Both need the same three endings handled the same way. The body ends, the
 * body is larger than the cap, or the client disconnects part way through. All
 * three funnel through one callback, so a caller writes one response path and a
 * disconnect can never take the server down with an unhandled stream error.
 */

/**
 * Collect a body and hand it over once. `null` means the body was over `max`
 * bytes, or the client went away before it finished.
 */
export function readBody(
  stream: NodeJS.ReadableStream,
  max: number,
  onDone: (body: string | null) => void,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let ended = false;
  const done = (body: string | null): void => {
    if (ended) return;
    ended = true;
    onDone(body);
  };
  stream.on("data", (c: Buffer) => {
    size += c.length;
    if (size > max) {
      done(null);
      return;
    }
    chunks.push(c);
  });
  stream.on("error", () => done(null));
  stream.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
}

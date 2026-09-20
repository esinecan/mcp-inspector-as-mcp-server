/**
 * Hand a URL to the user's browser, detached, so the login command keeps
 * running while the page opens. The URL is the only argument and carries no
 * secret: the PKCE challenge is public by design and the state is checked
 * on the way back.
 */

import { spawn } from "child_process";

export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): boolean {
  const [command, args] =
    platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {
      // The caller already printed the URL; a browser that cannot start is not a failure.
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

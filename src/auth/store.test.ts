import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CredentialReadError,
  PLAIN_CIPHER,
  canonicalServerUrl,
  credentialStore,
  entropyFor,
  type CredentialCipher,
  type CredentialRecord,
} from "./store.js";
import { DpapiError, dpapiCipher, type PowerShellRunner } from "./dpapi.js";

const record: CredentialRecord = {
  version: 1,
  serverUrl: "https://MCP.Example.com/mcp/",
  issuer: "https://mcp.example.com/",
  client: { client_id: "abc", issuer: "https://mcp.example.com/" },
  tokens: {
    access_token: "ACCESS-TOKEN-SECRET-VALUE-0123456789",
    refresh_token: "REFRESH-TOKEN-SECRET-VALUE-0123456789",
    token_type: "bearer",
    scope: "files:read",
    issuer: "https://mcp.example.com/",
  },
  obtainedAt: 1000,
  expiresAt: 4000,
  redirectPort: 8792,
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-cli-auth-store-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("canonicalServerUrl", () => {
  it("lowercases scheme and host, drops the trailing slash and the fragment", () => {
    expect(canonicalServerUrl("HTTPS://MCP.Example.com/mcp/#x")).toBe(
      "https://mcp.example.com/mcp",
    );
    expect(canonicalServerUrl("https://a.b/")).toBe("https://a.b");
    expect(canonicalServerUrl("https://a.b:8443/x?y=1")).toBe("https://a.b:8443/x?y=1");
  });

  it("binds the entropy to the canonical URL", () => {
    expect(entropyFor("https://A.b/mcp/")).toEqual(entropyFor("https://a.b/mcp"));
    expect(entropyFor("https://a.b/mcp")).not.toEqual(entropyFor("https://a.b/other"));
  });
});

describe("file backend", () => {
  it("round-trips a record and canonicalises the URL", async () => {
    let clock = 5000;
    const store = credentialStore(join(dir, "auth"), PLAIN_CIPHER, () => clock);
    await store.save("mock", record);
    const back = await store.load("mock");
    expect(back?.tokens?.access_token).toBe(record.tokens?.access_token);
    expect(back?.serverUrl).toBe("https://mcp.example.com/mcp");
    expect(store.stamp("mock")).toBe("5000");
    clock = 6000;
    await store.save("mock", record);
    expect(store.stamp("mock")).toBe("6000");
  });

  it("writes a sidecar with no secret in it", async () => {
    const store = credentialStore(join(dir, "auth"));
    await store.save("mock", record);
    const meta = readFileSync(join(dir, "auth", "mock.meta.json"), "utf8");
    expect(meta).not.toContain("ACCESS-TOKEN");
    expect(meta).not.toContain("REFRESH-TOKEN");
    expect(meta).not.toContain("access_token");
    const parsed = store.meta("mock");
    expect(parsed).toMatchObject({
      server: "mock",
      backend: "file",
      issuer: "https://mcp.example.com/",
      clientId: "abc",
      scope: "files:read",
      expiresAt: 4000,
      hasAccessToken: true,
      refreshable: true,
      redirectPort: 8792,
    });
    expect(store.list().map((m) => m.server)).toEqual(["mock"]);
  });

  it("restricts the files to the owner where the platform honours modes", async () => {
    const store = credentialStore(join(dir, "auth"));
    await store.save("mock", record);
    if (process.platform === "win32") return;
    expect(statSync(join(dir, "auth", "mock.cred")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "auth")).mode & 0o777).toBe(0o700);
  });

  it("answers undefined for a server it has never seen, and an empty stamp", async () => {
    const store = credentialStore(join(dir, "auth"));
    expect(await store.load("nobody")).toBeUndefined();
    expect(store.stamp("nobody")).toBe("");
    expect(store.meta("nobody")).toBeUndefined();
    expect(store.list()).toEqual([]);
    expect(await store.delete("nobody")).toBe(false);
  });

  it("deletes both files", async () => {
    const store = credentialStore(join(dir, "auth"));
    await store.save("mock", record);
    expect(await store.delete("mock")).toBe(true);
    expect(existsSync(join(dir, "auth", "mock.cred"))).toBe(false);
    expect(existsSync(join(dir, "auth", "mock.meta.json"))).toBe(false);
    expect(await store.load("mock")).toBeUndefined();
  });

  it("reports a damaged blob as a typed error naming the remedy", async () => {
    const store = credentialStore(join(dir, "auth"));
    await store.save("mock", record);
    writeFileSync(join(dir, "auth", "mock.cred"), "not json at all");
    await expect(store.load("mock")).rejects.toBeInstanceOf(CredentialReadError);
    await expect(store.load("mock")).rejects.toThrow(/auth logout mock && mcp-cli auth login mock/);
  });

  it("reports a blob whose sidecar is gone", async () => {
    const store = credentialStore(join(dir, "auth"));
    await store.save("mock", record);
    rmSync(join(dir, "auth", "mock.meta.json"));
    await expect(store.load("mock")).rejects.toThrow(/sidecar is missing/);
  });

  it("encodes a server name that is not a safe file name", async () => {
    const store = credentialStore(join(dir, "auth"));
    await store.save("my server/x", record);
    expect(store.list().map((m) => m.server)).toEqual(["my server/x"]);
    expect(await store.load("my server/x")).toBeDefined();
  });
});

describe("dpapi cipher through a fake runner", () => {
  /** XOR with the entropy: enough to prove what crosses the seam and back. */
  const fake: PowerShellRunner = async (script, stdin) => {
    const mode = /\$mode = '(\w+)'/.exec(script)?.[1];
    const [entropyB64, dataB64] = stdin.split(".");
    const entropy = Buffer.from(entropyB64, "base64");
    const data = Buffer.from(dataB64, "base64");
    const out = Buffer.from(data.map((byte, i) => byte ^ entropy[i % entropy.length]));
    if (mode !== "protect" && mode !== "unprotect")
      return { code: 1, stdout: "", stderr: "bad mode" };
    return { code: 0, stdout: out.toString("base64"), stderr: "" };
  };

  it("keeps the data off the command line and off the disk in the clear", async () => {
    const seen: string[] = [];
    const spy: PowerShellRunner = (script, stdin) => {
      seen.push(script);
      return fake(script, stdin);
    };
    const store = credentialStore(join(dir, "auth"), dpapiCipher(spy));
    await store.save("mock", record);
    for (const script of seen) expect(script).not.toContain("ACCESS-TOKEN");
    const onDisk = readFileSync(join(dir, "auth", "mock.cred"), "utf8");
    expect(onDisk).not.toContain("ACCESS-TOKEN");
    expect(store.backend).toBe("dpapi");
    expect(store.meta("mock")?.backend).toBe("dpapi");
    expect((await store.load("mock"))?.tokens?.refresh_token).toBe(record.tokens?.refresh_token);
  });

  it("does not open a blob copied under another server URL", async () => {
    const store = credentialStore(join(dir, "auth"), dpapiCipher(fake));
    await store.save("mock", record);
    const meta = JSON.parse(readFileSync(join(dir, "auth", "mock.meta.json"), "utf8"));
    meta.serverUrl = "https://other.example.com/mcp";
    writeFileSync(join(dir, "auth", "mock.meta.json"), JSON.stringify(meta));
    await expect(store.load("mock")).rejects.toBeInstanceOf(CredentialReadError);
  });

  it("turns a PowerShell failure into a DpapiError with the first stderr line", async () => {
    const failing: PowerShellRunner = async () => ({
      code: 1,
      stdout: "",
      stderr: "\nException calling Unprotect: Key not valid for use in specified state.\n",
    });
    const cipher = dpapiCipher(failing);
    await expect(cipher.unprotect(Buffer.from("x"), Buffer.from("e"))).rejects.toThrow(DpapiError);
    await expect(cipher.unprotect(Buffer.from("x"), Buffer.from("e"))).rejects.toThrow(
      /Key not valid/,
    );
  });

  it("turns a missing powershell.exe into a DpapiError", async () => {
    const missing: PowerShellRunner = async () => {
      throw new Error("spawn powershell.exe ENOENT");
    };
    await expect(dpapiCipher(missing).protect(Buffer.from("x"), Buffer.from("e"))).rejects.toThrow(
      /could not be started/,
    );
  });
});

describe.skipIf(process.platform !== "win32")("dpapi cipher on Windows", () => {
  it("round-trips through the real DPAPI and refuses foreign entropy", async () => {
    const cipher: CredentialCipher = dpapiCipher();
    const plain = Buffer.from("probe-" + Date.now(), "utf8");
    const entropy = entropyFor("https://a.b/mcp");
    const blob = await cipher.protect(plain, entropy);
    expect(blob.equals(plain)).toBe(false);
    expect((await cipher.unprotect(blob, entropy)).toString("utf8")).toBe(plain.toString("utf8"));
    await expect(cipher.unprotect(blob, entropyFor("https://a.b/other"))).rejects.toThrow(
      DpapiError,
    );
  }, 30_000);
});

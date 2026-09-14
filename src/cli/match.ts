/**
 * Fuzzy resolution of a `server.tool` address against the addresses a server
 * actually exposes.
 *
 * The order is exact, then case-insensitive exact, then substring. A substring
 * round only wins when it leaves exactly one candidate; anything else is an
 * ambiguity the caller must resolve.
 */

export type MatchResult =
  | { kind: "exact"; address: string }
  | { kind: "fuzzy"; address: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "none" };

/** Resolve one query against a list of full `server.tool` addresses. */
export function resolveAddress(query: string, addresses: string[]): MatchResult {
  if (addresses.includes(query)) {
    return { kind: "exact", address: query };
  }

  const lower = query.toLowerCase();

  const caseHits = addresses.filter((a) => a.toLowerCase() === lower);
  if (caseHits.length === 1) return { kind: "fuzzy", address: caseHits[0] };
  if (caseHits.length > 1) return { kind: "ambiguous", candidates: caseHits };

  const substringHits = addresses.filter((a) => a.toLowerCase().includes(lower));
  if (substringHits.length === 1) return { kind: "fuzzy", address: substringHits[0] };
  if (substringHits.length > 1) return { kind: "ambiguous", candidates: substringHits };

  return { kind: "none" };
}

/**
 * Split an address into its server part and its tool part. The server name is
 * everything before the first dot, because a tool name may itself contain one.
 */
export function splitAddress(address: string): { server: string; tool: string } | null {
  const dot = address.indexOf(".");
  if (dot <= 0 || dot === address.length - 1) return null;
  return { server: address.slice(0, dot), tool: address.slice(dot + 1) };
}

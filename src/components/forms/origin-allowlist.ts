// ----------------------------------------------------------------------------
// origin-allowlist — per-form host-allowlist matching helper.
//
// This is the TypeScript mirror of the algorithm implemented in
// `routes/form-embed.js`. The two implementations MUST stay in sync — any
// change here should be mirrored in the BE, and vice-versa.
//
// Matching semantics (consistent across BE + this helper):
//   - The input `requestOrigin` is normalised to its `host` form via the
//     URL constructor when possible. This means scheme is NOT part of the
//     identity. Port IS part of the identity.
//   - Each entry in `allowedOrigins` is stripped of its scheme prefix and
//     compared on host[+port]. Entries were already normalised by the BE
//     validator (bare hostnames are prefixed with `https://`).
//   - An entry WITHOUT "*." requires an EXACT match.
//   - An entry WITH "*." matches any subdomain strictly deeper than the
//     suffix — "*.example.com" matches "a.example.com" and
//     "a.b.example.com", but NOT "example.com" (the apex). The "." anchor
//     in the comparison prevents "evilexample.com" from matching
//     "*.example.com".
//   - An empty allowlist means "no restriction" and the caller is
//     expected to short-circuit BEFORE calling this function.
//
// The function is pure and side-effect-free; safe to call from React
// effects and from admin-side tooling.
// ----------------------------------------------------------------------------

export function isOriginAllowed(
  requestOrigin: string | null | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (typeof requestOrigin !== "string" || requestOrigin.length === 0) {
    return false;
  }
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
    return true;
  }

  const hasScheme = /^https?:\/\//i.test(requestOrigin);
  const urlish = hasScheme ? requestOrigin : `http://${requestOrigin}`;
  let req: string;
  try {
    const u = new URL(urlish);
    req = u.host.toLowerCase();
  } catch {
    req = requestOrigin
      .replace(/\/$/, "")
      .replace(/^https?:\/\//i, "")
      .toLowerCase();
  }

  for (const raw of allowedOrigins) {
    if (typeof raw !== "string") continue;
    const e = raw.replace(/\/$/, "").toLowerCase();
    const entryHasScheme = /^https?:\/\//i.test(e);
    const eUrlish = entryHasScheme ? e : `http://${e}`;
    let entryHost: string;
    try {
      const eu = new URL(eUrlish);
      entryHost = eu.host.toLowerCase();
    } catch {
      entryHost = e.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    }
    if (entryHost === req) return true;
    if (e.includes("*.")) {
      const starIdx = e.indexOf("*.");
      const suffix = e.slice(starIdx + 2);
      const suffixHost = suffix.replace(/^https?:\/\//i, "").split(":")[0];
      const reqHost = req.split(":")[0];
      if (reqHost === suffixHost) continue; // apex — wildcard does NOT match
      if (reqHost.length <= suffixHost.length) continue;
      if (reqHost.endsWith("." + suffixHost)) {
        return true;
      }
    }
  }
  return false;
}

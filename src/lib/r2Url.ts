// SSRF allowlist guard for stored media URLs. A share's imageUrl/fileUrl is stored verbatim from
// the POST body, so without validation a caller could store an internal/localhost/cloud-metadata URL
// and later have /api/share/download fetch it server-side (the server acts as an SSRF proxy).
//
// Returns true ONLY when the URL is https AND its origin equals the R2 public base URL's origin.
// Used at BOTH intake (/api/share POST — reject before storing) and sink (/api/share/download GET —
// re-validate before fetch, covering shares created before the guard existed).
//
// Fail-closed: when R2_PUBLIC_URL is unset we reject. Production sets it, and both /api/presign and
// /api/share build stored URLs from it (shares/… and drops/… prefixes), so every legitimate stored
// URL shares that origin — real shares (incl. binary shares pointing at a drop's R2 URL) pass.
export function isAllowedR2Url(url: string | undefined | null): boolean {
  const base = process.env.R2_PUBLIC_URL;
  if (!base || typeof url !== 'string' || url.length === 0) return false;

  let parsed: URL;
  let baseUrl: URL;
  try {
    parsed = new URL(url);
    baseUrl = new URL(base);
  } catch {
    return false; // malformed URL (new URL throws) → reject
  }

  if (parsed.protocol !== 'https:') return false; // explicit https requirement
  return parsed.origin === baseUrl.origin; // origin already encodes protocol+host(+port)
}

/**
 * Favicon proxy for generated integration entries. Serves the provider
 * domain's favicon (via Google's public favicon service) so thousands of
 * generated entries get real logos without storing any assets, falling back
 * to a neutral globe when the domain is invalid or the upstream fails.
 */

const DOMAIN_PATTERN = /^[a-z0-9][a-z0-9.-]{0,251}\.[a-z]{2,}$/;

const FALLBACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="#8f8f8f" stroke-width="1.5"/><path d="M3 12h18M12 3a13.5 13.5 0 0 1 0 18M12 3a13.5 13.5 0 0 0 0 18" stroke="#8f8f8f" stroke-width="1.5"/></svg>`;

const fallbackResponse = () =>
  new Response(FALLBACK_SVG, {
    headers: {
      "content-type": "image/svg+xml",
      "cache-control": "public, max-age=86400, s-maxage=604800",
    },
  });

export async function GET(_request: Request, { params }: { params: Promise<{ domain: string }> }) {
  const { domain } = await params;
  const normalized = decodeURIComponent(domain).toLowerCase();
  if (!DOMAIN_PATTERN.test(normalized)) {
    return fallbackResponse();
  }
  try {
    const upstream = await fetch(
      `https://www.google.com/s2/favicons?domain=${encodeURIComponent(normalized)}&sz=64`,
      { next: { revalidate: 86400 } },
    );
    if (!upstream.ok) {
      return fallbackResponse();
    }
    return new Response(await upstream.arrayBuffer(), {
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "image/png",
        "cache-control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800",
      },
    });
  } catch {
    return fallbackResponse();
  }
}

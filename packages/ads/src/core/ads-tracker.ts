export function trackAdEvent(
  url: string | undefined,
  event: 'impression' | 'complete' | 'skip' | 'click',
  extra?: Record<string, unknown>
): void {
  if (!url) return;

  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, ...extra }),
    keepalive: true,
  }).catch(() => {});
}

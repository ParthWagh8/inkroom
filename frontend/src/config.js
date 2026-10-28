// Public server configuration. Provider keys stay on the server.
export async function loadServerConfig(signal) {
  const response = await fetch('/api/config', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw new Error('The review service is not reachable.');
  const data = await response.json();
  if (!data || typeof data.ready !== 'boolean') {
    throw new Error('The review service returned an invalid response.');
  }
  return {
    mode: data.demo ? 'demo' : 'live',
    ready: Boolean(data.ready),
    models: data.models && typeof data.models === 'object' ? data.models : {},
    limits: data.limits && typeof data.limits === 'object' ? data.limits : {},
  };
}

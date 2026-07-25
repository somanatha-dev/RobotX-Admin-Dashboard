import { requestJson } from './httpClient.js';

export async function createLocation(payload) {
  const data = await requestJson('/api/locations', { method: 'POST', body: payload });
  return data?.location || null;
}

export async function listLocations({ type, parentId } = {}) {
  const params = new URLSearchParams();
  if (type) params.set('type', String(type));
  if (typeof parentId === 'string') params.set('parentId', parentId);

  const qs = params.toString();
  const data = await requestJson(qs ? `/api/locations?${qs}` : '/api/locations');
  return data?.locations || [];
}

export async function listCampuses() {
  const data = await requestJson('/api/campuses');
  return data?.campuses || [];
}

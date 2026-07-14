async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.detail || data.error || 'Požadavek se nepodařilo dokončit.')
  }
  return data
}

export const api = {
  health: () => request('/api/health'),
  audiences: () => request('/api/audiences'),
  campaigns: () => request('/api/campaigns'),
  contacts: (listId) => request(`/api/audiences/${encodeURIComponent(listId)}/contacts`),
  importContacts: (listId, payload) => request(`/api/audiences/${encodeURIComponent(listId)}/contacts/import`, {
    method: 'POST', body: JSON.stringify(payload),
  }),
  sendTest: (payload) => request('/api/campaigns/test', { method: 'POST', body: JSON.stringify(payload) }),
  send: (payload) => request('/api/campaigns/send', { method: 'POST', body: JSON.stringify(payload) }),
}

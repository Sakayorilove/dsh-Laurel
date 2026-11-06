import { normalizePresentationValue } from '../presentation-model.js'
// Small pure collection helpers; no polling, model calls, or module instantiation.
export const normalizeLibraryPreferences = normalizePresentationValue
export function libraryNeedsAttention(row) {
  return !['ready', 'loading'].includes(row.state) || row.fiberPhase === 'failed' || (row.enabled === true && row.fiberPhase === 'pending')
}
export function functionalLibraryRows(rows) {
  return rows.filter(row => row.uiSection !== 'appearance')
}
export function filterLibraryRows(rows, { query = '', category = 'all', status = 'all', section = 'library', sort = 'default', preferences = {}, nameOf = r => r.title?.zh ?? r.label ?? r.id, descOf = r => r.desc?.zh ?? '' } = {}) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const favorites = new Set(preferences.favorites ?? [])
  const recent = new Map((preferences.recent ?? []).map((id, i) => [id, i]))
  const filtered = rows.filter(row => {
    if (section === 'favorites' && !favorites.has(row.id)) return false
    if (section === 'recent' && !recent.has(row.id)) return false
    if ((section === 'attention' || status === 'attention') && !libraryNeedsAttention(row)) return false
    if (category !== 'all' && (row.category ?? 'other') !== category) return false
    if (status === 'enabled' && row.enabled !== true) return false
    if (status === 'disabled' && !(row.state === 'ready' && row.enabled === false)) return false
    const haystack = [row.id, nameOf(row), descOf(row), row.summary?.zh, row.summary?.en, ...(row.keywords ?? [])].join(' ').toLocaleLowerCase()
    return terms.every(term => haystack.includes(term))
  })
  return filtered.sort((a, b) => {
    if (section === 'recent' || sort === 'recent') return (recent.get(a.id) ?? 9999) - (recent.get(b.id) ?? 9999)
    if (sort === 'name') return nameOf(a).localeCompare(nameOf(b))
    if (sort === 'default') return Number(favorites.has(b.id)) - Number(favorites.has(a.id)) || (a.order ?? 999) - (b.order ?? 999)
    return 0
  })
}

/** Persist only presentation choices, through the host's authenticated admission. */
export function createPresentationClient({ fetcher = (...args) => fetch(...args), storage = () => globalThis.localStorage } = {}) {
  const key = 'laurel-center.presentation.v1'
  let initial = {}
  try { initial = JSON.parse(storage()?.getItem(key) ?? '{}') } catch {}
  let state = { ...normalizeLibraryPreferences(initial), loading: true, saving: false, saved: false, error: null }
  const listeners = new Set(), dirty = new Set()
  let stopped = false, generation = 0, queue = Promise.resolve()
  const set = patch => { state = { ...state, ...patch }; if (!stopped) for (const fn of listeners) fn(state) }
  const cache = () => { try { storage()?.setItem(key, JSON.stringify(normalizeLibraryPreferences(state))) } catch {} }
  const request = async (method, patch) => {
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 5000)
    try {
      const response = await fetcher('/api/laurel-center/presentation', { method, credentials: 'same-origin', headers: { 'x-laurel-ui': '1', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(patch) } : {}), signal: ac.signal })
      const body = await response.json()
      if (!response.ok || body.ok !== true) throw new Error(body.error ?? 'presentation-unavailable')
      return normalizeLibraryPreferences(body.value)
    } finally { clearTimeout(timer) }
  }
  return {
    getSnapshot: () => state,
    subscribe(fn) { stopped = false; listeners.add(fn); return () => listeners.delete(fn) },
    async load() {
      try {
        const loaded = await request('GET')
        const merged = { ...loaded }
        for (const k of dirty) merged[k] = state[k]
        set({ ...merged, loading: false, saved: dirty.size === 0 ? true : state.saved, error: dirty.size === 0 ? null : state.error }); cache()
      } catch (error) { set({ loading: false, saved: false, error: String(error.message) }) }
    },
    preview(patch) { for (const k of Object.keys(patch)) dirty.add(k); set({ ...normalizeLibraryPreferences({ ...state, ...patch }), saved: false }); cache() },
    update(patch) {
      const version = ++generation
      for (const k of Object.keys(patch)) dirty.add(k)
      set({ ...normalizeLibraryPreferences({ ...state, ...patch }), saving: true, saved: false, error: null }); cache()
      queue = queue.then(async () => {
        try {
          await request('POST', patch)
          if (version === generation) set({ saving: false, saved: true, error: null })
          return { saved: true }
        } catch (error) { if (version === generation) set({ saving: false, saved: false, error: String(error.message) }); return { saved: false, error: String(error.message) } }
      })
      return queue
    },
    stop() { stopped = true; listeners.clear() },
  }
}

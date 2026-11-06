/** Shared host/client presentation schema. Theme revisions do not change plugin IDs. */
export const PRESENTATION_THEMES = Object.freeze(['endfield', 'wuling', 'endfield-v02', 'wuling-v02', 'particle-v03', 'wuling-particle-v03'])

/** Images are content addressed local assets, never arbitrary URLs or paths. */
export function normalizeWallpaper(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  const slot = v => ({ fit:['cover','fill','contain','tile'].includes(v?.fit)?v.fit:'cover', image: typeof v?.image === 'string' && /^[a-f0-9]{64}\.webp$/.test(v.image) ? v.image : '', blur: Number.isFinite(v?.blur) ? Math.max(0,Math.min(40,v.blur)) : 0, opacity: Number.isFinite(v?.opacity) ? Math.max(0,Math.min(100,v.opacity)) : 24 })
  return { enabled:source.enabled === true, mode:source.mode === 'separate' ? 'separate' : 'global', global:slot(source.global), sidebar:slot(source.sidebar), conversation:slot(source.conversation) }
}
export function normalizeShadows(value = {}) {
  const slot = v => ({ strength:Number.isFinite(v?.strength) ? Math.max(0,Math.min(60,v.strength)) : 0, distance:Number.isFinite(v?.distance) ? Math.max(0,Math.min(32,v.distance)) : 8 })
  return { sidebar:{...slot(value?.sidebar),direction:value?.sidebar?.direction==='right'?'right':'left'}, header:slot(value?.header), composer:slot(value?.composer) }
}

export const PRESENTATION_DEFAULTS = Object.freeze({ theme: 'endfield', view: 'grid', motion: true, followSystemMotion: false, siTheme: 'si-paper-v01', siEnabled: true, hover: false, colorMode: 'auto', sound: true, soundEffects: true, experienceRevision: 0, music: true, volume: .3, rewardVolume: .8, areaVolume: .7, musicVolume: .15, navMode: 'tree', workspaceMarkers: {}, wallpaper: normalizeWallpaper(), shadows: normalizeShadows(), favorites: [], recent: [] })
export function normalizeWorkspaceMarkers(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const entries = []
  for (const [id, marker] of Object.entries(value).slice(0, 100)) {
    if (!id || id.length > 180 || /[\0-\x1f]/.test(id) || ['__proto__','constructor','prototype'].includes(id) || !marker || typeof marker !== 'object') continue
    const color = /^#[0-9a-f]{6}$/i.test(marker.color || '') ? marker.color : '#b9d6b5'
    if (marker.type === 'image' && typeof marker.image === 'string' && marker.image.length <= 100000 && /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(marker.image)) entries.push([id, { type: 'image', color, image: marker.image, text: '' }])
    else if (['letter','emoji'].includes(marker.type) && typeof marker.text === 'string' && marker.text.length > 0 && marker.text.length <= 32 && !/[\0-\x1f<>]/.test(marker.text)) entries.push([id, { type: marker.type, color, text: marker.text }])
  }
  return Object.fromEntries(entries)
}
export function normalizePresentationValue(value = {}) {
  const ids = list => Array.isArray(list) ? [...new Set(list.filter(x => typeof x === 'string' && /^[a-zA-Z0-9._-]{1,100}$/.test(x)))].slice(0, 200) : []
  const gain = (key, fallback) => Number.isFinite(value[key]) ? Math.max(0, Math.min(1, value[key])) : fallback
  return { wallpaper:normalizeWallpaper(value.wallpaper), shadows:normalizeShadows(value.shadows), theme: PRESENTATION_THEMES.includes(value.theme) ? value.theme : 'endfield', view: value.view === 'list' ? 'list' : 'grid', motion: value.motion !== false, followSystemMotion: value.followSystemMotion === true, siTheme: value.siTheme === 'si-flow-v03' ? 'si-flow-v03' : 'si-paper-v01', siEnabled: value.siEnabled !== false, hover: value.hover === true, colorMode: ['light','dark'].includes(value.colorMode) ? value.colorMode : 'auto', sound: value.sound !== false, soundEffects: value.soundEffects !== false, experienceRevision: value.experienceRevision === 5 ? 5 : 0, music: value.music !== false, volume: gain('volume',.3), rewardVolume: gain('rewardVolume',.8), areaVolume: gain('areaVolume',.7), musicVolume: gain('musicVolume',.15), navMode: value.navMode === 'baker' ? 'baker' : 'tree', workspaceMarkers: normalizeWorkspaceMarkers(value.workspaceMarkers), favorites: ids(value.favorites), recent: ids(value.recent).slice(0,30) }
}

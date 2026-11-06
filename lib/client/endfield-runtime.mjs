// Original game sources. No Wwise Motion/haptic output is routed to speakers.
export const ENDFIELD_AUDIO = Object.freeze({ bgm: 'recruitment-bgm', aicArea: 'aic-area', select: 'region-select', reward: 'reward-open', common: 'common-click', confirm: 'confirm', pageOpen: 'page-open', pageClose: 'page-close', slider: 'slider', switchOn: 'switch-on', switchOff: 'switch-off', dropdownOpen: 'dropdown-open', dropdownClose: 'dropdown-close' })
export function nativeControlAudio({ type, role, checked, ariaChecked, tab = false }) {
  if (type === 'range') return null
  if (type === 'checkbox') return checked ? 'switchOn' : 'switchOff'
  if (role === 'switch') return ariaChecked === 'true' ? 'switchOff' : 'switchOn'
  return tab ? 'select' : 'common'
}
export class EndfieldAudio {
  constructor() { this.prefs = {}; this.ctx = null; this.buffers = new Map(); this.voices = new Set(); this.ducks = new Set(); this.generation = 0; this.areaGeneration = 0; this.musicGeneration = 0; this.active = false; this.unlocked = false; this.dead = false; this.last = new Map(); this.fadeFrame = 0 }
  configure(prefs) { const effectsOff=this.prefs.soundEffects!==false&&prefs.soundEffects===false;this.prefs = prefs;if(effectsOff){this.generation++;for(const v of this.voices){try{v.stop()}catch{}}this.ducks.clear()} if (this.master) { this.master.gain.value = prefs.volume; this.reward.gain.value = prefs.rewardVolume; this.area.gain.value = prefs.areaVolume ?? .7 } if (!prefs.sound) this.stop(); else void this.musicSync() }
  state(value) { if (typeof document !== 'undefined' && document.body) { document.body.dataset.laurelBgm = value; if(typeof window !== 'undefined' && typeof CustomEvent === 'function')window.dispatchEvent(new CustomEvent('laurel:audio-state', {detail:{state:value}})) } }
  cancelFade() { if (this.fadeFrame) cancelAnimationFrame(this.fadeFrame); this.fadeFrame = 0 }
  fadeMusic(target, duration, done) {
    this.cancelFade(); const music = this.music; if (!music) { done?.(); return }
    const from = music.volume, start = performance.now()
    if (!(duration > 0) || Math.abs(from - target) < .001 || typeof requestAnimationFrame !== 'function') { music.volume = target; done?.(); return }
    const step = now => {
      if (this.dead || this.music !== music) { this.fadeFrame = 0; return }
      const progress = Math.max(0, Math.min(1, (now - start) / duration)), eased = progress * progress * (3 - 2 * progress)
      music.volume = from + (target - from) * eased
      if (progress < 1) this.fadeFrame = requestAnimationFrame(step)
      else { this.fadeFrame = 0; done?.() }
    }
    this.fadeFrame = requestAnimationFrame(step)
  }
  targetMusicVolume() { return (this.prefs.musicVolume ?? .15) * (this.ducks.size ? .45 : 1) }
  setActive(value, { announce = true } = {}) {
    value = value === true; if (value === this.active) return
    this.active = value; this.musicGeneration++
    if (value) { this.pendingArea = announce; void this.musicSync(); if (this.unlocked && this.pendingArea) { this.pendingArea = false; void this.play('aicArea') } }
    else { this.pendingArea = false; this.cancelArea(); this.state('fading-out'); this.fadeMusic(0, 380, () => { this.music?.pause(); this.state('paused') }) }
  }
  unlock() { if (this.dead) return; const first = !this.unlocked; this.unlocked = true; if (first) void this.musicSync(); if (this.active && this.pendingArea) { this.pendingArea = false; void this.play('aicArea') } }
  async musicSync() {
    if (this.dead || !this.active || !this.unlocked || !this.prefs.sound || !this.prefs.music || document.hidden) {
      if (this.music && !this.music.paused) { this.state('fading-out'); this.fadeMusic(0, 280, () => { this.music?.pause(); this.state('paused') }) } else this.state('paused')
      return
    }
    if (!this.music) { this.music = new Audio('/laurel-center/materials/158844af202f3d6d82bad30685663e0e2cae3869b6d9ff2019797a0950a24aa5.mp3'); this.music.loop = true; this.music.preload = 'none'; this.music.volume = 0 }
    const music = this.music, ticket = this.musicGeneration
    if (!music.paused) { this.fadeMusic(this.targetMusicVolume(), 180); return }
    if (this.startingMusic === ticket) return
    this.startingMusic = ticket; music.volume = 0
    try {
      await music.play()
      if (this.music !== music || this.dead || ticket !== this.musicGeneration || !this.active || !this.prefs.sound || !this.prefs.music || document.hidden) { if (!this.active || this.dead || document.hidden || !this.prefs.sound || !this.prefs.music) music.pause(); return }
      this.state('fading-in'); this.fadeMusic(this.targetMusicVolume(), 650, () => this.state('playing'))
    } catch { this.state('awaiting-gesture') }
    finally { if (this.startingMusic === ticket) this.startingMusic = null }
  }
  async ready() {
    if (!this.ctx) { const C = window.AudioContext || window.webkitAudioContext; if (!C) throw Error('audio-unavailable'); this.ctx = new C({ latencyHint: 'interactive' }); this.master = this.ctx.createGain(); this.reward = this.ctx.createGain(); this.area = this.ctx.createGain(); for (const bus of [this.master, this.reward, this.area]) bus.connect(this.ctx.destination) }
    if (this.sleeping) await this.sleeping
    if (this.ctx.state !== 'running') await this.ctx.resume()
    this.master.gain.value = this.prefs.volume; this.reward.gain.value = this.prefs.rewardVolume; this.area.gain.value = this.prefs.areaVolume ?? .7
  }
  cancelArea() { this.areaGeneration++; for (const v of this.voices) if (v.laurelKey === 'aicArea') { try { v.stop() } catch {} this.ducks.delete(v) } }
  async play(key, { announce = false } = {}) {
    if (this.dead || !this.unlocked || !this.prefs.sound || this.prefs.soundEffects === false || document.hidden || !ENDFIELD_AUDIO[key] || key === 'bgm' || (key === 'aicArea' && !this.active && !announce)) return
    const now = Date.now(); if (key === 'slider' && now - (this.last.get(key) || 0) < 65) return; this.last.set(key, now)
    if (key === 'aicArea') this.cancelArea()
    if (key === 'reward') { this.generation++; for (const v of this.voices) { try { v.stop() } catch {} } this.ducks.clear() }
    const generation = this.generation, areaGeneration = this.areaGeneration
    const stale = () => this.dead || generation !== this.generation || !this.prefs.sound || this.prefs.soundEffects === false || document.hidden || (key === 'aicArea' && ((!this.active && !announce) || areaGeneration !== this.areaGeneration))
    try {
      await this.ready()
      if (!this.buffers.has(key)) { const pending = fetch('/laurel-center/art/audio/' + ENDFIELD_AUDIO[key] + '.mp3').then(r => { if (!r.ok) throw Error('audio-unavailable'); return r.arrayBuffer() }).then(b => this.ctx.decodeAudioData(b)); this.buffers.set(key, pending); pending.catch(() => { if (this.buffers.get(key) === pending) this.buffers.delete(key) }) }
      const buffer = await this.buffers.get(key)
      if (stale()) return this.idle()
      if (this.ctx.state !== 'running') await this.ready()
      if (stale()) return this.idle()
      while (this.voices.size >= 4) { const first = this.voices.values().next().value; try { first.stop() } catch {} this.ducks.delete(first); this.voices.delete(first) }
      const voice = this.ctx.createBufferSource(); voice.buffer = buffer; voice.laurelKey = key; voice.connect(key === 'reward' ? this.reward : key === 'aicArea' ? this.area : this.master); this.voices.add(voice)
      if (key === 'reward' || key === 'aicArea') { this.ducks.add(voice); if (this.active) this.fadeMusic(this.targetMusicVolume(), 90) }
      voice.onended = () => { voice.disconnect(); this.voices.delete(voice); this.ducks.delete(voice); if (this.active && !this.dead && this.prefs.sound && this.prefs.music && !document.hidden) this.fadeMusic(this.targetMusicVolume(), 180); this.idle() }; voice.start()
    } catch { this.state('asset-unavailable'); this.idle() }
  }
  idle() { if (!this.voices.size && this.ctx?.state === 'running') this.sleeping = this.ctx.suspend().catch(() => {}).finally(() => { this.sleeping = null }) }
  stop() { this.generation++; this.musicGeneration++; this.cancelFade(); this.music?.pause(); if (this.music) this.music.volume = 0; this.state('paused'); for (const v of this.voices) { try { v.stop() } catch {} } this.voices.clear(); this.ducks.clear(); this.idle() }
  dispose() { this.dead = true; this.active = false; this.stop(); this.buffers.clear(); if (this.music) { this.music.removeAttribute('src'); this.music.load(); this.music = null } const previous = this.ctx; this.ctx = null; this.master = null; this.reward = null; this.area = null; void previous?.close().catch(() => {}) }
}

/** A projection of category membership; the registry owns all modules and categories. */
export function EndfieldTree({ React, rows, active, catName, nameOf }) {
  const h = React.createElement, parts = []
  const cats = [...new Set(rows.map(r => r.category || 'other'))]
  const path = (d, className, key) => h('path', { d, className, key })
  cats.forEach((cat, ci) => {
    const group = rows.filter(r => (r.category || 'other') === cat), y = 50 + ci * 92
    const shown = group.length <= 4 ? group.map(r => [r]) : [...group.slice(0, 3).map(r => [r]), group.slice(3)]
    const selected = group.some(r => r.id === active)
    parts.push(h('g', { key: 'level:' + cat, className: 'tree-level' + (selected ? ' selected' : '') },
      path(`m40 ${y} 160 34 160-34v8l-160 34L40 ${y + 8}Z`, 'tree-plane-side'), path(`m40 ${y} 160-34 160 34-160 34Z`, 'tree-plane'),
      h('text', { x: 42, y: y + 51, className: 'tree-category' }, String(ci + 1).padStart(2, '0') + ' / ' + catName(cat)), h('text', { x: 358, y: y + 51, textAnchor: 'end', className: 'tree-category-count' }, group.length)))
    const slots = { 1: [[200, y]], 2: [[165, y - 2], [235, y + 2]], 3: [[200, y - 12], [150, y + 1], [245, y + 8]], 4: [[200, y - 12], [250, y], [150, y], [200, y + 12]] }[shown.length]
    shown.forEach((members, i) => {
      const [x, ny] = slots[i], on = members.some(r => r.id === active), key = members[0].id
      if (on) parts.push(path(`M200 ${cats.length * 92 + 35} 32 ${cats.length * 92}V${y}L${x} ${ny}`, 'tree-route selected', 'route:' + key))
      parts.push(h('g', { key, className: 'tree-node' + (on ? ' selected' : ''), 'data-members': members.map(r => r.id).join(' ') },
        h('g', { className: 'tree-lift' }, path(`m${x - 26} ${ny - 16} 26 11v16l-26-11Z`, 'tree-side-left'), path(`m${x} ${ny - 5} 26-11v16l-26 11Z`, 'tree-side-right'), path(`m${x - 26} ${ny - 16} 26-11 26 11-26 11Z`, 'tree-top'), h('text', { x, y: ny - 12, textAnchor: 'middle', className: 'tree-node-number' }, members.length > 1 ? '+' + members.length : String(rows.indexOf(members[0]) + 1).padStart(2, '0')))))
    })
  })
  const row = rows.find(r => r.id === active)
  return h('div', { className: 'lc-tree' }, h('svg', { viewBox: `0 0 400 ${cats.length * 92 + 65}`, fill: 'none', 'aria-hidden': true }, parts), h('p', { className: 'lc-tree-caption' }, row ? nameOf(row) : '模块树 / 右侧悬停联动', h('small', null, row ? catName(row.category) : '按功能分层 · 选中节点抬起')))
}

export function EndfieldReceipt({ React, receipt, close }) {
  const h = React.createElement, ref = React.useRef(null), focus = React.useRef(null)
  React.useEffect(() => { if (!receipt) return; focus.current = document.activeElement; ref.current?.showModal(); return () => { ref.current?.close(); if (focus.current?.isConnected) focus.current.focus({ preventScroll: true }) } }, [receipt])
  if (!receipt) return null
  return h('dialog', { ref, className: 'lc-receipt', 'aria-label': receipt.title, onClick: close, onCancel: e => { e.preventDefault(); close() }, onKeyDown: e => { if (['Enter', ' '].includes(e.key)) { e.preventDefault(); close() } } },
    h('div', { className: 'lc-receipt-body' }, h('div', { className: 'lc-receipt-heading' }, h('span', null, '◇'), h('h2', null, receipt.title)),
      h('div', { className: 'lc-receipt-items' }, receipt.items.map((item, i) => h('div', { key: item.id, className: 'lc-receipt-item', style: { '--lc-receipt-delay': Math.min(i, 10) * 48 + 'ms' } }, h('small', null, String(i + 1).padStart(2, '0'), ' / LAUREL'), h('b', null, item.name), h('span', null, item.message)))),
      h('button', { type: 'button', autoFocus: true }, '✓　点击任意位置继续')))
}

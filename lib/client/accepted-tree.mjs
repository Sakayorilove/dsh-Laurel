/** Exact projection from approved module-tree.py. Only registry membership is dynamic. */
export function acceptedTreeMarkup(modules, isw, active) {
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll(String.fromCharCode(34), '&quot;').replaceAll(String.fromCharCode(39), '&#39;')
  const names = { continuity: '记忆与上下文', execution: '执行与协作', experience: '通知与交互' }, keys = [...new Set(['continuity', 'execution', 'experience', ...modules.map(r => r.category || 'other')])]
  const cats = keys.map((cat, i) => [cat, names[cat] || cat, 56 + i * 92])
  const parts = [`<div class="tree-stage"><svg class="module-tree" viewBox="0 0 400 ${cats.length * 92 + 54}" fill="none" aria-hidden="true"><path class="tree-spine" d="M32 48v${cats.length * 92 - 48}l168 41M368 48v${cats.length * 92 - 48}l-168 41"/><path class="tree-ground" d="m18 ${cats.length * 92 + 8} 182 39 182-39m-364 7 182 39 182-39"/>`]
  const routes = []
  for (const [ci, [cat, label, y]] of cats.entries()) {
    const group = modules.filter(m => (m.category || 'other') === cat), shown = group.length <= 4 ? group.map(m => [[m], false]) : [...group.slice(0, 3).map(m => [[m], false]), [group.slice(3), true]]
    const slots = { 1: [[200, y]], 2: [[167, y - 2], [233, y + 2]], 3: [[200, y - 12], [150, y + 1], [240, y + 8]], 4: [[200, y - 12], [250, y], [150, y], [200, y + 12]] }[Math.max(1, shown.length)]
    const selected = group.some(m => m.id === active) ? ' selected' : '', ids = escape(group.map(m => m.id).join(' '))
    const pattern = !isw ? `<path class="tree-etch" d="m104 ${y} 96 21 96-21m-148-11 96 21m-96 0 96-21"/>` : `<path class="tree-etch" d="M103 ${y}q50-22 97 0t97 0m-171 10q37-12 74 0t74 0"/>`
    parts.push(`<g class="tree-level${selected}" data-members="${ids}"><path class="tree-plane-side" d="m40 ${y} 160 34 160-34v8l-160 34L40 ${y + 8}Z"/><path class="tree-plane" d="m40 ${y} 160-34 160 34-160 34Z"/>${pattern}<path class="tree-plane-rim" d="m40 ${y} 160 34 160-34"/><text class="tree-category" x="42" y="${y + 50}">${String(ci + 1).padStart(2, '0')} / ${escape(label)}</text><text class="tree-category-count" x="358" y="${y + 50}" text-anchor="end">${String(group.length).padStart(2, '0')}</text></g>`)
    for (const [i, [members, aggregate]] of shown.entries()) {
      const [x, ny] = slots[i], key = escape(members[0].id), memberids = escape(members.map(m => m.id).join(' ')), selected = members.some(m => m.id === active) ? ' selected' : '', num = aggregate ? '+' + members.length : String(modules.indexOf(members[0]) + 1).padStart(2, '0')
      routes.push(`<path class="tree-route${selected}" data-port="${key}" data-members="${memberids}" pathLength="1" d="M200 ${cats.length * 92 + 41} 32 ${cats.length * 92}V${y}l${Math.max(0, x - 54)} ${-Math.trunc((x - 32) * .21)}L${x} ${ny - 8}"/>`)
      parts.push(`<g class="tree-node${selected}" data-port="${key}" data-members="${memberids}"><path class="tree-socket" d="m${x - 27} ${ny + 3} 27-11 27 11-27 11Z"/><path class="tree-tether" d="M${x} ${ny + 4}v-32"/><g class="tree-lift"><path class="tree-side-left" d="m${x - 26} ${ny - 16} 26 11v16l-26-11Z"/><path class="tree-side-right" d="m${x} ${ny - 5} 26-11v16l-26 11Z"/><path class="tree-top" d="m${x - 26} ${ny - 16} 26-11 26 11-26 11Z"/><path class="tree-node-notch" d="m${x - 20} ${ny - 16} 20-8m20 8-20 8"/><text class="tree-node-number" text-anchor="middle" x="${x}" y="${ny - 12}">${num}</text><path class="tree-node-marker" d="m${x - 4} ${ny - 40} 4-4 4 4-4 4Z"/></g></g>`)
    }
  }
  parts.push(...routes, `<g class="tree-root"><path d="m200 ${cats.length * 92 + 31} 16 8-16 8-16-8Z"/><path class="tree-root-core" d="m200 ${cats.length * 92 + 26} 8 4-8 4-8-4Z"/></g></svg></div>`)
  return parts.join('')
}

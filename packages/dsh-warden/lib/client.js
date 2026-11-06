/**
 * dsh-warden · 客户端半边（由 scripts/build-client.mjs 生成，不要直接改这个文件）
 *
 * 改源码请改：
 *   - lib/client-kit.js
 *   - lib/client/index.mjs
 * 然后跑 `npm run build`。
 */

window.__ModuleLoader__.load({
  id: "dsh-warden",
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const CLIENT_BUNDLE_VERSION = "0.3.1"

    /* ===== 以下为内联源码。kit 与插件代码共享同一个作用域， ===== */
    /* ===== 所以 kit 导出的符号在插件代码里可以直接用。      ===== */

    /* ---------- lib/client-kit.js ---------- */






























    const CLIENT_KIT_VERSION = 1














    async function requestJSON(api, path, options = {}) {
      const method = options.method ?? 'GET'
      const init = { method, headers: {} }
      if (options.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(options.body)
      }

      const controller = typeof AbortController === 'function' ? new AbortController() : null
      if (controller) init.signal = controller.signal
      const timer = controller
        ? setTimeout(() => controller.abort(), options.timeoutMs ?? 8000)
        : null
      try {
        const response = await fetch(`${api}${path}`, init)
        const payload = await response.json().catch(() => null)
        if (!payload || payload.ok !== true) {
          throw new Error(payload?.error ? String(payload.error) : `HTTP ${response.status}`)
        }
        return payload.data
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
    }





    async function loadConfig(api, log) {
      try {
        const data = await requestJSON(api, '/config')
        return data?.config ?? null
      } catch (error) {
        log?.('config-load-failed', error?.message ?? String(error))
        return null
      }
    }





    async function reportEvent(api, event, log) {
      try {
        await requestJSON(api, '/event', { method: 'POST', body: event })
        return true
      } catch (error) {
        log?.('event-report-failed', error?.message ?? String(error))
        return false
      }
    }









    function probeEnvironment(NotificationCtor) {
      const origin = (() => {
        try { return typeof location !== 'undefined' ? String(location.origin) : null } catch { return null }
      })()
      const supported = typeof NotificationCtor === 'function'
      let permission = null
      try { permission = supported ? String(NotificationCtor.permission) : null } catch {  }
      let visibility = null
      let focused = null
      try {
        if (typeof document !== 'undefined') {
          visibility = String(document.visibilityState ?? '')
          focused = typeof document.hasFocus === 'function' ? document.hasFocus() : null
        }
      } catch {  }
      return { origin, supported, permission, visibility, focused }
    }






    async function ensurePermission(NotificationCtor) {
      try {
        if (typeof NotificationCtor !== 'function') return 'unsupported'
        if (NotificationCtor.permission === 'granted') return 'granted'
        if (typeof NotificationCtor.requestPermission !== 'function') return NotificationCtor.permission
        return String(await NotificationCtor.requestPermission())
      } catch {
        return 'error'
      }
    }















    function createThrottle(now, throttleSeconds, globalFloorMs = 2000) {
      const lastPerKey = new Map()
      let lastAny = -Infinity
      return {




        check(key) {
          const t = now()
          const since = t - lastAny
          if (since < globalFloorMs) {
            return { allowed: false, reason: 'global', retryInMs: globalFloorMs - since }
          }
          const prev = lastPerKey.get(key)
          const gap = (throttleSeconds > 0 ? throttleSeconds : 0) * 1000
          if (prev !== undefined && t - prev < gap) {
            return { allowed: false, reason: 'per-key', retryInMs: gap - (t - prev) }
          }
          return { allowed: true }
        },

        mark(key) {
          const t = now()
          lastPerKey.set(key, t)
          lastAny = t
        },
        reset() {
          lastPerKey.clear()
          lastAny = -Infinity
        },
      }
    }












    function pickText(table, language) {
      if (language === 'zh') return table.zh
      if (language === 'en') return table.en
      let langs = []
      try {
        langs = [navigator.language, ...(navigator.languages ?? [])]
      } catch {  }
      const isZh = langs.some((tag) => typeof tag === 'string' && tag.toLowerCase().startsWith('zh'))
      return isZh ? table.zh : table.en
    }





    function truncateBody(text, maxChars) {
      const s = typeof text === 'string' ? text : ''
      const max = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 140
      if (s.length <= max) return s
      if (max <= 1) return s.slice(0, max)
      return `${s.slice(0, max - 1)}…`
    }
























    function toMap(value) {
      if (value === null || value === undefined) return new Map()


      if (typeof value.get === 'function' && typeof value.forEach === 'function' && typeof value.size === 'number') {
        return value
      }

      if (typeof value === 'object') return new Map(Object.entries(value))
      return new Map()
    }










































    function registerSettingsSection(ctx, options) {
      const { id, order = 50, label, component, slots, slot, children } = options
      if (!slots?.inject || !slots?.register) {
        throw new Error(`laurel-kit: 拿不到 slots 服务，无法注册设置页（${id}）`)
      }


      const GROUP = 'laurel-center.module'
      const extra = children === undefined ? {} : { children }
      const put = (name) => slots.register({ name, id, order, label, ...extra }, component)


      if (slot !== undefined) {
        return ctx.effect(() => slots.inject(slot, () => put(slot)), `${id}.settings-section`)
      }


      return ctx.effect(() => {
        let grouped = null
        let standalone = null

        const offGroup = slots.inject(GROUP, () => {
          if (grouped) return () => {}
          if (standalone) { standalone(); standalone = null }
          grouped = put(GROUP)
          return () => { grouped?.(); grouped = null }
        })

        const offStandalone = slots.inject('settings.section', () => {
          if (grouped) return () => {}
          if (standalone) return () => {}
          standalone = put('settings.section')
          return () => { standalone?.(); standalone = null }
        })



        return () => { offGroup?.(); offStandalone?.() }
      }, `${id}.settings-section`)
    }


    /* ---------- lib/client/index.mjs ---------- */























    const API = '/warden'
    const inject = ['slots', 'uiSession']





    const FALLBACK = {
      enabled: true, preset: 'balanced',
      waitCapMs: 60000, waitTools: ['wait_agent'],
      starTopology: true, resultsToFile: true,
      reworkNudge: true, reworkThreshold: 3, rereadNudge: true, rereadThreshold: 3,
      waterLevelNudge: false, waterLevelStep: 50000, waterLevelRatio: 0.5,
      costNudge: true, budgetGate: false, costBudgetUsd: 0, costWarnRatio: 0.8, archiveExcludeTools: [],
      compactionFallbackRatio: 0.3, reportEnabled: true,
      microCompact: false, microCompactKeep: 6,
      archiveToolResults: true, archiveThresholdChars: 8192, archiveKeepChars: 1200,
      unknownToolHint: true, editMissHint: true,
      lockGuard: true, lockTtlMs: 120000, evidenceLedger: true,
      progressWatch: true, progressMode: 'observe', progressFailureThreshold: 3,
      stageContract: true, capabilityPrecheck: true,
      idleLimitMs: 30000, idleAction: 'notify',
      taskBudgetMs: 600000, taskBudgetReplies: 30,
      pathIgnore: [],
    }


    const TIER_TEXT = {
      gentle: ['温和', 'Gentle', '只提醒，几乎不拦。适合你本来就打算自己盯着的时候。', 'Nudge only, almost never blocks.'],
      balanced: ['均衡', 'Balanced', '默认档。该拦的拦、该提醒的提醒。', 'Default. Blocks and nudges where it matters.'],
      strict: ['严格', 'Strict', '等待压到 30 秒、重复 2 次就提醒、无进展直接 enforce。证据归档反而更积极 —— 无人值守时事后能核对比省几 KB 重要。', '30s waits, nudge on the 2nd repeat, no-progress enforcement on. Archiving gets more aggressive, not less.'],
      custom: ['自定义', 'Custom', '以你在下面逐项设的值准（改任何一项会自动切到这里）。', 'Whatever you set below wins.'],
    }


    const CAP_STATE_TEXT = {
      unknown: ['未探测', 'unknown', '还没走到这一步，无从判断'],
      supported: ['宿主支持', 'supported', '宿主有这个扩展点，但本轮还没挂上或还没命中'],
      mounted: ['已挂载', 'mounted', '钩子确实挂上了，但还没观察到真实命中'],
      observed: ['已命中', 'observed', '挂载后真的生效过 —— 这才是"在工作"的证据'],
      degraded: ['已降级', 'degraded', '挂了但坏了；护栏会放行宿主，但不假装自己成功'],
      unsupported: ['不支持', 'unsupported', '宿主没有这个能力，或这件事本来就不归 warden 管'],
      standby: ['待命', 'standby', '能力可用，但套件里另一个模块是执行者，本模块不重复介入'],
    }

    function apply(ctx) {
      const React = require('react')
      const h = React.createElement
      const source = ctx.uiSession?.adapter?.current
      const emptySnapshot = { key: undefined }
      const getBinding = source?.getSnapshot ?? (() => emptySnapshot)
      const subscribeBinding = source?.subscribe ?? (() => () => {})

      const state = {
        config: { ...FALLBACK }, ready: false, busy: false, problem: '', notice: '',
        tab: 'tier',
        presets: [], locks: [], evidence: { total: 0, artifacts: 0 }, evidenceRows: [],
        events: [], stats: [], paths: null,
        capabilities: [], governance: [], stages: [], progress: [], usage: [],
        report: null,
        lockStats: {}, stageStats: { total: 0, byStatus: {} },
        persistence: { persisted: null, reason: '' },
        persistedCheck: { exists: false, matches: false, reason: '' },
        draftIgnore: '',
      }
      ctx.effect(() => { const locate = event => { if(event.detail?.id === 'warden' && ['tier','subagent','context','diag'].includes(event.detail.tab)){state.tab=event.detail.tab;update()} }; window.addEventListener('laurel:locate-setting',locate);return()=>window.removeEventListener('laurel:locate-setting',locate) })
      let bump = () => {}
      const update = () => bump((n) => n + 1)

      const isEn = () => /^en\b/i.test(typeof navigator === 'undefined' ? '' : navigator.language)
      const t = (zh, en) => (isEn() ? en : zh)
      const secs = (ms) => Math.round(Number(ms) / 1000) + 's'
      const tail = (path) => String(path ?? '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || '—'
      const stamp = (iso) => {
        try { return new Date(iso).toLocaleTimeString() } catch { return String(iso ?? '') }
      }
      const ttl = (expiresAt) => {
        const ms = Number(expiresAt) - Date.now()
        if (!Number.isFinite(ms) || ms <= 0) return t('即将过期', 'expiring')
        const s = Math.round(ms / 1000)
        return s < 60 ? t(s + ' 秒后过期', 'in ' + s + 's') : t(Math.round(s / 60) + ' 分钟后过期', 'in ' + Math.round(s / 60) + 'm')
      }


      const hintStyle = { fontSize: 12, lineHeight: 1.6, marginTop: 5 }
      const rowStyle = { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }
      const inputStyle = { font: 'inherit', padding: '7px 9px', boxSizing: 'border-box', minWidth: 0, maxWidth: '100%' }
      const border = '1px solid rgba(128,128,128,.3)'
      const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }


      const refresh = async () => {
        const status = await requestJSON(API, '/status')
        state.config = { ...FALLBACK, ...status.config }
        state.presets = status.presets ?? []
        state.locks = status.locks ?? []
        state.lockStats = status.lockStats ?? {}
        state.evidence = status.evidence ?? { total: 0, artifacts: 0 }
        state.evidenceRows = status.evidenceRows ?? []
        state.events = status.events ?? []
        state.stats = status.stats ?? []
        state.paths = status.paths ?? null
        state.capabilities = status.capabilities ?? []
        state.governance = status.governance ?? []
        state.stages = status.stages ?? []
        state.stageStats = status.stageStats ?? { total: 0, byStatus: {} }
        state.progress = status.progress ?? []
        state.usage = status.usage ?? []
        state.persistence = status.persistence ?? { persisted: null, reason: '' }
        state.persistedCheck = status.persistedCheck ?? { exists: false, matches: false, reason: '' }
        try {

          state.report = await requestJSON(API, '/report?since=today')
        } catch (error) {
          state.report = { known: false, reason: error?.message ?? String(error) }
        }
        state.ready = true
      }

      const run = async (fn, message = '') => {
        if (state.busy) return
        state.busy = true; state.problem = ''; state.notice = ''; update()
        try { await fn(); if (message) state.notice = message }
        catch (error) { state.problem = error?.message ?? String(error) }
        finally {
          if (state.refreshPending) {
            state.refreshPending = false
            try { await refresh() } catch (error) { state.problem = error.message }
          }
          state.busy = false; update()
        }
      }








      const applyConfigResult = (result, okMessage) => {
        state.config = { ...FALLBACK, ...result.config }
        if (result.persisted === false) {

          throw new Error(t('配置已在内存生效，但写盘失败（重启会丢）：', 'Applied in memory but NOT persisted (lost on restart): ') + (result.reason ?? ''))
        }
        return okMessage
      }








      const save = (patch) => run(async () => {
        const body = { config: { preset: 'custom', ...patch } }
        const result = await requestJSON(API, '/config', { method: 'POST', body })
        const message = applyConfigResult(result, t('已保存并落盘，立即生效。', 'Saved to disk and applied.'))
        await refresh()
        if (state.persistedCheck.matches !== true) throw new Error(t('配置回读未匹配：', 'Configuration readback mismatch: ') + (state.persistedCheck.reason || t('未确认落盘', 'persistence unconfirmed')))
        state.notice = message
        try { window.dispatchEvent(new CustomEvent('laurel:configuration-saved', { detail: { id: 'warden', persisted: true } })) } catch {}
      }, '')

      const applyPreset = (id) => run(async () => {
        const result = await requestJSON(API, '/preset', { method: 'POST', body: { preset: id } })
        const message = applyConfigResult(result, t('档位已切换并落盘。', 'Tier switched and saved to disk.'))
        await refresh()
        if (state.persistedCheck.matches !== true) throw new Error(t('配置回读未匹配：', 'Configuration readback mismatch: ') + (state.persistedCheck.reason || t('未确认落盘', 'persistence unconfirmed')))
        state.notice = message
        try { window.dispatchEvent(new CustomEvent('laurel:configuration-saved', { detail: { id: 'warden', persisted: true } })) } catch {}
      }, '')

      const releaseLock = (name, resource) => run(async () => {
        await requestJSON(API, '/lock/release', { method: 'POST', body: { name, resource, force: true } })
        await refresh()
      }, t('锁已释放（fence 已推进，原持有者无法再续租）。', 'Lock released (fence advanced; the old holder can no longer renew).'))


      const Col = (children) => h('div', null, children)

      const Button = (label, onClick, disabled = false, extra = {}) => h('button', {
        type: 'button', onClick, disabled: state.busy || disabled,
        style: { ...inputStyle, cursor: 'pointer', ...extra.style }, ...extra,
      }, label)

      const Section = (title, children, hint) => h('section', { style: { marginTop: 20 } },
        h('h3', { style: { fontSize: 14, margin: '0 0 10px' } }, title),
        hint ? h('p', { style: hintStyle }, hint) : null,
        children)

      const Toggle = (label, value, onChange, hint, disabled = false) => h('div', { className: 'lc-setting-row', style: { margin: '10px 0' } },
        h('label', { style: { ...rowStyle, cursor: 'pointer' } },
          h('input', {
            type: 'checkbox', role: 'switch', className: 'lc-toggle-input', 'aria-label': label, checked: !!value,
            disabled: state.busy || !state.ready || disabled,
            onChange: (e) => onChange(e.target.checked),
          }), h('span', null, label)),
        hint ? h('div', { className: 'lc-setting-hint', style: { ...hintStyle, paddingLeft: 24 } }, hint) : null)

      const SettingToggle = (key, ...args) => h('div', { 'data-setting-key': key }, Toggle(...args))

      const NumberField = (label, name, min, max, step = 1) => h('label', { 'data-setting-key': name, style: { ...rowStyle, margin: '12px 0' } },
        h('span', { style: { flex: '1 1 230px' } }, label),
        h('input', {
          type: 'number', 'aria-label': label, defaultValue: state.config[name],
          key: name + ':' + state.config[name], min, max, step,
          disabled: state.busy || !state.ready, style: { ...inputStyle, width: 116 },
          onBlur: (e) => {
            if (e.target.value !== '' && Number(e.target.value) !== state.config[name]) save({ [name]: Number(e.target.value) })
          },
          onKeyDown: (e) => { if (e.key === 'Enter') e.target.blur() },
        }))

      const Note = (text) => h('p', { style: hintStyle }, text)


      const SelectField = (label, name, options, hint) => h('div', { 'data-setting-key': name, style: { margin: '12px 0' } },
        h('label', { style: rowStyle },
          h('span', { style: { flex: '1 1 230px' } }, label),
          h('select', {
            'aria-label': label, value: String(state.config[name] ?? options[0][0]),
            disabled: state.busy || !state.ready, style: { ...inputStyle, width: 160 },
            onChange: (e) => save({ [name]: e.target.value }),
          }, options.map((o) => h('option', { key: o[0], value: o[0] }, o[1])))),
        hint ? h('div', { style: { ...hintStyle, paddingLeft: 2 } }, hint) : null)


      const summaryRows = () => {
        const c = state.config
        return [
          [t('子代理等待上限', 'Subagent wait cap'), c.waitCapMs > 0 ? secs(c.waitCapMs) : t('不干预', 'off')],
          [t('子代理只对主控汇报', 'Star topology'), c.starTopology ? t('开（禁止私自串聊，放行经调度的协调）', 'on (blocks unscheduled cross-talk)') : t('关', 'off')],
          [t('子代理结论写文件', 'Results to file'), c.resultsToFile ? t('开', 'on') : t('关', 'off')],
          [t('返工提醒', 'Rework nudge'), c.reworkNudge ? t('同一文件第 ' + c.reworkThreshold + ' 次起', 'from edit #' + c.reworkThreshold) : t('关', 'off')],
          [t('重复读提醒', 'Re-read nudge'), c.rereadNudge ? t('同一区间第 ' + c.rereadThreshold + ' 次起（读不同区间不算）', 'from re-read #' + c.rereadThreshold + ' (distinct ranges exempt)') : t('关', 'off')],
          [t('上下文水位提醒', 'Context watermark'), c.waterLevelNudge ? t('每长 ' + Math.round(c.waterLevelStep / 1000) + 'k token', 'every ' + Math.round(c.waterLevelStep / 1000) + 'k tokens') : t('关', 'off')],
          [t('大输出归档', 'Large-output archiving'), c.archiveToolResults ? t('≥' + c.archiveThresholdChars + ' 字符先落盘，只留首尾 ' + c.archiveKeepChars, 'offload at ' + c.archiveThresholdChars + ' chars, keep ' + c.archiveKeepChars) : t('关', 'off')],
          [t('历史压缩', 'History compaction'), t('warden 不做（官方 Basic 独占）', 'not warden (official Basic owns it)')],
          [t('无进展识别', 'No-progress watch'), c.progressWatch ? c.progressMode + t('（同一失败 ' + c.progressFailureThreshold + ' 次起）', ' (after ' + c.progressFailureThreshold + ' identical failures)') : t('关', 'off')],
          [t('共享资源执行权', 'Resource execution rights'), c.lockGuard ? t('开（' + secs(c.lockTtlMs) + ' 过期，可续租）', 'on (' + secs(c.lockTtlMs) + ' TTL, renewable)') : t('关', 'off')],
          [t('读数指纹台账', 'Evidence ledger'), c.evidenceLedger ? t('开（字节级 sha256 v2）', 'on (byte-level sha256 v2)') : t('关', 'off')],
          [t('阶段预算', 'Stage budget'), Math.round(c.taskBudgetMs / 60000) + t(' 分钟 / ', ' min / ') + c.taskBudgetReplies + t(' 次回复 → 复盘', ' replies → review')],
          [t('无活动时限', 'Idle limit'), secs(c.idleLimitMs) + ' → ' + c.idleAction],
        ]
      }


      function TierTab() {
        const c = state.config

        const tierCard = id => {
          const active = c.preset === id
          const label = TIER_TEXT[id]
          const detail = id === 'gentle' ? t('以观察与提醒为主', 'Observe and nudge')
            : id === 'balanced' ? t('兼顾干预与工作连续性', 'Balanced intervention')
              : t('更积极地执行护栏策略', 'More active safeguards')
          return h('button', { key: id, type: 'button', disabled: state.busy || !state.ready, 'aria-pressed': active, onClick: () => applyPreset(id) },
            h('span', { 'data-lc-radio': '', 'aria-hidden': true }),
            h('span', { className: 'lc-preset-copy' }, h('strong', null, t(label[0], label[1])), h('small', null, detail)))
        }
        const summaryLine = (row, index) => h('div', { key: row[0], style: { ...rowStyle, justifyContent: 'space-between', padding: '10px 0', borderTop: index ? border : 'none' } }, h('span', null, row[0]), h('span', { style: { opacity: .85 } }, row[1]))
        return Col([
          h('p', { className: 'lc-guard-info' }, t('启用状态与实际生效情况分开记录，可在「运行状态」查看。', 'Activation and observed effects are tracked separately on the Runtime tab.')),
          Section(t('选择护栏档位', 'Choose a safeguard tier'),
            h('div', null,
              h('div', { 'data-lc-presets': '' }, ['gentle', 'balanced', 'strict'].map(tierCard)),
              h('p', { style: hintStyle }, c.preset === 'custom' ? t('当前为自定义；选择档位会替换整套参数。', 'Custom settings active; choosing a tier replaces all parameters.') : t('切换档位会替换整套参数，请先检查自定义项。', 'Changing tiers replaces the complete parameter set. Review custom settings first.')))),
          Section(t('当前策略', 'Current safeguards'), Col([
            h('div', { 'data-common-setting': 'waitCapMs' }, h('label', { style: rowStyle }, h('span', { style: { flex: 1 } }, t('子代理等待上限', 'Subagent wait cap')), h('span', { className: 'lc-setting-unit' }, c.waitCapMs ? secs(c.waitCapMs) : t('不干预', 'Off')), h('input', { type: 'number', min: 0, max: 3600000, step: 5000, defaultValue: c.waitCapMs, key: 'cap:' + c.waitCapMs, 'aria-label': t('子代理等待上限（毫秒）', 'Subagent wait cap (ms)'), disabled: state.busy || !state.ready, style: { ...inputStyle, width: 110 }, onBlur: e => { if (e.target.value !== '' && Number(e.target.value) !== c.waitCapMs) save({ waitCapMs: Number(e.target.value) }) }, onKeyDown: e => { if (e.key === 'Enter') e.target.blur() } }))),
            h('div', { 'data-common-setting': 'archiveToolResults' }, SettingToggle('archiveToolResults', t('工具结果归档', 'Archive tool results'), c.archiveToolResults, v => save({ archiveToolResults: v }), t('较大结果先归档，按需回读原文。', 'Archive larger results; read the original in bounded ranges.'))),
            h('div', { 'data-common-setting': 'progressWatch' }, SettingToggle('progressWatch', t('无进展提醒', 'No-progress watch'), c.progressWatch, v => save({ progressWatch: v }), t('连续没有新证据时提醒复盘；具体执行方式见上下文设置。', 'Review repeated attempts without new evidence. Configure enforcement on the Context tab.'))),
            h('div', { 'data-common-setting': 'lockGuard' }, SettingToggle('lockGuard', t('共享目录保护', 'Shared-directory protection'), c.lockGuard, v => save({ lockGuard: v }), t('减少多个任务同时修改同一资源的冲突。', 'Reduce conflicts between tasks modifying the same resource.'))),
          ])),
          h('details', null, h('summary', null, t('高级参数与完整策略', 'Advanced parameters and full policy')),
            h('div', null, summaryRows().map(summaryLine)),
            SettingToggle('enabled', t('启用护栏行为', 'Enable guard behavior'), c.enabled, v => save({ enabled: v }), t('控制本模块内部的护栏行为；模块加载开关在页面右上方。', 'Controls behavior inside the module. The module load switch is at the top of this page.')),
            Note(t('等待、子代理纪律和资源锁在「子代理」调整；归档、水位、返工与无进展参数在「上下文」调整。', 'Configure wait caps, discipline and resource locks on Subagents; archiving, watermarks, rework and no-progress parameters on Context.'))),
        ])
      }


      const CommonRef = (label, key) => h('div', { style: rowStyle, 'data-setting-reference': key },
        h('span', null, label + ' · ' + (typeof state.config[key] === 'boolean'
          ? (state.config[key] ? t('已开启', 'On') : t('已关闭', 'Off')) : secs(state.config[key]))),
        Button(t('前往常用设置', 'Edit common settings'), (event) => {
          const root = event.currentTarget.getRootNode()
          state.tab = 'tier'; update()
          requestAnimationFrame(() => {
            const target = root.querySelector('[data-common-setting="' + key + '"]')
            target?.scrollIntoView({ block: 'center', behavior: 'instant' })
            target?.querySelector('input')?.focus({ preventScroll: true })
          })
        }))


      function SubagentTab() {
        const c = state.config

        const lockRow = (l) => h('div', {
          key: l.id || l.name,
          style: { ...rowStyle, justifyContent: 'space-between', borderTop: border, padding: '10px 0' },
        },
        h('span', { style: { minWidth: 0, overflowWrap: 'anywhere' } },
          h('strong', null, l.name),
          h('span', { style: { ...hintStyle, display: 'block' } },
            (l.resourceId || l.path || t('（命名资源）', '(named resource)'))
              + ' · ' + t('持有者', 'owner') + ' ' + l.owner
              + ' · fence ' + l.fence
              + ' · ' + ttl(l.expiresAt)),
          l.note ? h('span', { style: { ...hintStyle, display: 'block' } }, t('备注', 'note') + '：' + l.note) : null),
        Button(t('强制释放', 'Force release'), () => releaseLock(l.name, l.resourceId)))

        return Col([
          Section(t('等待上限', 'Wait cap'),
            Col([
              CommonRef(t('子代理等待上限', 'Subagent wait cap'), 'waitCapMs'),
              Note(t('宿主的 wait_agent 没有硬超时：等多久是模型每次自己填的，上限一小时。实测一个会话里它被调 41 次，486 步的会话跨度 6 小时、真正在算的只有 73 分钟。这里给它套一个顶。',
                'The host puts no hard timeout on wait_agent: the model picks the duration each time, up to an hour. One measured session called it 41 times; a 486-step session spanned 6 hours with only 73 minutes of actual work. This caps it.')),
            ])),

          Section(t('子代理纪律', 'Subagent discipline'),
            Col([
              SettingToggle('starTopology', t('子代理只对主控汇报（星型拓扑）', 'Star topology (workers report to the lead only)'), c.starTopology, (v) => save({ starTopology: v }),
                t('实测一个会话里 98 条 team message 全是子代理互相"更正（请以这条为准）"，读数互相污染。这条写成系统提示词里的常驻规则，压缩之后也还在。',
                  'One measured session had 98 team messages of subagents correcting each other; readings got polluted. This is a resident prompt rule that survives compaction.')),
              SettingToggle('resultsToFile', t('子代理结论写文件', 'Subagent results go to files'), c.resultsToFile, (v) => save({ resultsToFile: v }),
                t('只把「文件路径 + 一行摘要」回给主控，别把大段结论贴进对话 —— 那会让主控上下文迅速膨胀，而且每次转述都会失真。',
                  'Return a path plus a one-line summary instead of pasting the whole result — pasting inflates the lead context and loses fidelity on every relay.')),
            ])),

          Section(t('共享资源锁', 'Shared-resource locks'),
            Col([
              CommonRef(t('共享目录保护', 'Shared-directory protection'), 'lockGuard'),
              Note(t('只拦写入，不拦读取；可以用独立目录或分支减少争用。', 'Blocks writes only. Separate directories or branches reduce contention.')),
              NumberField(t('锁自动过期（毫秒）', 'Lock TTL (ms)'), 'lockTtlMs', 10000, 3600000, 10000),
              Note(t('锁必须有过期时间，否则进程一崩就是死锁。', 'A TTL is mandatory; without it a crashed process leaves a deadlock.')),
              h('h4', { style: { fontSize: 13, margin: '16px 0 6px' } }, t('当前持有', 'Currently held') + '（' + state.locks.length + '）'),
              state.locks.length === 0
                ? Note(t('没有任何共享锁。', 'No locks held.'))
                : Col(state.locks.map(lockRow)),
            ])),
        ])
      }


      function ContextTab() {
        const c = state.config
        return Col([
          Section(t('上下文水位提醒（默认关）', 'Context watermark (off by default)'),
            Col([
              SettingToggle('waterLevelNudge', t('增长式提醒', 'Growth-based nudge'), c.waterLevelNudge, (v) => save({ waterLevelNudge: v }),
                t('默认关闭。它只在上下文增长时发送提醒，不执行压缩；提醒本身也占上下文。需要临时观察增长时再开启，历史压缩状态请查看「上下文压缩」。',
                  'Off by default. It only sends growth nudges, not compaction, and nudges also consume context. Enable temporarily to observe growth; check Context compression for history-compaction status.')),
              NumberField(t('每长大多少 token 提醒一次', 'Nudge after this much growth'), 'waterLevelStep', 2000, 500000, 5000),
              Note(t('水位数取自宿主上报的用量；拿不到就不提醒 —— 本插件自己的估算只用于显示，不拿来记账。',
                'The watermark comes from host-reported usage; if the host reports nothing, no nudge is sent.')),
            ])),

          Section(t('可选：工具结果归档', 'Optional: tool-result archiving'),
            Col([
              Note(t('这是护栏自己的工具结果归档，与上下文模块的原文外置能力相邻。它不负责压缩历史对话；历史压缩状态请查看控制中心的「上下文压缩」。',
                'This is the guard’s tool-result archive, adjacent to context externalization. It does not compact conversation history. Check Context compression for history-compaction status.')),
              CommonRef(t('工具结果归档', 'Archive tool results'), 'archiveToolResults'),
              Note(t('原文完整写到本地文件，上下文保留有界摘要及文件引用。', 'The original is saved locally; context retains a bounded summary and file reference.')),
              NumberField(t('超过多少字符就归档', 'Archive above this many chars'), 'archiveThresholdChars', 1024, 4000000, 1024),
              NumberField(t('摘要里保留首尾共多少字符', 'Chars kept inline (head + tail)'), 'archiveKeepChars', 200, 200000, 200),
              Note(t('三条底线：① 归档写失败就保留原结果，宁可上下文大也不丢数据；② 失败结果一律不归档、不改写 —— 错误信息本身就是证据；③ 图片/文件等非文本块原样保留。',
                'Three hard rules: (1) if offloading fails, the original result is kept — better a big context than lost data; (2) failed results are never archived or rewritten, the error is the evidence; (3) image/file blocks are preserved as-is.')),
              Note(t('摘要里明确写了「不要重新执行那个工具」：写入、部署、网络请求重跑一次就有副作用，找回原文的正确方式是读归档文件。',
                'The summary explicitly says "do not re-run that tool": writes, deployments and network calls are not replayable. Reading the archive file is the correct way back.')),
            ])),

          Section(t('花费与预算', 'Cost & budget'),
            Col([
              SettingToggle('costNudge', t('统计本会话花费', 'Track per-session cost'), c.costNudge, (v) => save({ costNudge: v }),
                t('把已有的四桶用量（未缓存输入 / 缓存读 / 缓存写 / 输出）按官方价目折算成金额。只统计与显示，不发任何网络请求、不读余额。',
                  'Prices the four existing usage buckets (uncached input / cache read / cache write / output) with the official price list. Statistics only — no network calls, no balance reads.')),
              SettingToggle('budgetGate', t('到预算线时提醒一次', 'Nudge once when the budget line is hit'), c.budgetGate, (v) => save({ budgetGate: v }),
                t('注意：**它不会阻断任何请求**。到线只注入一条提醒，告诉你该先落盘结论、再决定要不要继续 —— 护栏不该替人做停止决定。',
                  'Note: it never blocks a request. Crossing the line only injects one reminder to persist conclusions and then decide. A guard should not decide to stop on your behalf.')),
              NumberField(t('本会话预算（美元，0 = 不设）', 'Per-session budget (USD, 0 = none)'), 'costBudgetUsd', 0, 100000, 0.01),
              Note(t('价目来源：DeepSeek 官方价目页（2026-10-17 抓取）。峰时是谷时的 2 倍（UTC 01:00–04:00 与 06:00–10:00，工作日）。认不出模型名时按 flash 价估算，界面与提醒里都会标明"估算"。',
                'Price source: the official DeepSeek pricing page (captured 2026-10-17). Peak is 2× off-peak (UTC 01:00–04:00 and 06:00–10:00 on weekdays). Unrecognized model names fall back to the flash price and are labelled "estimated".')),
              Note(t('金额是**估算**，不是账单。真要核对账目请用 provider 的官方余额接口；这里的作用是"在烧钱的时候早点知道"，而不是替代计费。',
                'These amounts are estimates, not a bill. Reconcile against the provider balance API; this exists to tell you early, not to replace billing.')),
            ])),

          Section(t('提醒方式与报表（0.3.0）', 'Nudges & report (0.3.0)'),
            Col([
              SettingToggle('nudgeOnceOnly', t('同一原因只提醒一次', 'Nudge each cause only once per session'), c.nudgeOnceOnly, (v) => save({ nudgeOnceOnly: v }),
                t('默认开。理由是实测出来的：每条注入都会被之后**每一步**重发一次，所以"周期性播报"的成本是线性的，收益却不是。关掉会回到旧行为（首次踩线 → 计数翻倍 → 硬动作 → 上限）。',
                  'On by default. Measured reason: every injected message is re-sent on every later step, so periodic reporting costs linearly while its benefit does not. Turning it off restores the old ladder (first hit → doubling → hard action → cap).')),
              NumberField(t('压缩兜底：压力到窗口的百分之多少提醒', 'Compaction fallback: remind at this share of the window'), 'compactionFallbackRatio', 0, 0.95, 0.01),
              Note(t('官方压缩要窗口到 80% 才动手（1M 窗口 = 80 万 token），很多会话到不了。这里的兜底：压力超过这个比例、且本会话**从未观察到压缩发生过**时，提醒一次，之后不再提。0 = 关。',
                'Official compaction only fires near 80% of the window (800k on 1M), which many sessions never reach. Fallback: when pressure passes this ratio and this session has never been observed compacting, remind once and then stay silent. 0 = off.')),
              SettingToggle('reportEnabled', t('收益自报表', 'Self-report'), c.reportEnabled, (v) => save({ reportEnabled: v }),
                t('「诊断」页会多一块：今天归档省下多少字符 / 约多少 token、各类提醒各发了多少条、花了多少钱（拿得到时）。模型也能用 `warden_report` 工具查。**省下的 token 是估算**，按"若归档则后续每步重发"推的。',
                  'Adds a block to Diagnostics: chars/≈tokens saved by archiving today, how many nudges of each kind fired, and cost when known. The model can also call `warden_report`. Tokens saved are an estimate — projected from "would be re-sent every later step".')),
              Note(t('按工具分级归档（`archiveThresholdByTool` / `archiveKeepByTool`）只在配置文件里设，不进设置页 —— 它是给"某个工具的输出特别啰嗦"这种个案用的，不是日常开关。',
                'Per-tool archiving limits (archiveThresholdByTool / archiveKeepByTool) are config-file only, not exposed here — they are for the case "this one tool is verbose", not an everyday switch.')),
            ])),

          Section(t('历史压缩：warden 不做', 'History compaction: not warden'),
            Col([
              Note(t('旧版在这一层裁"历史工具结果"，但实读宿主 agent-loop：pre-step 拿到的是 inbox 待追加的新批次，完整历史要到 buildRequest 才从 session surface 构建 —— 那一层根本没有旧工具结果可裁。',
                'The old version pruned "historical tool results" here, but the host agent-loop shows pre-step receives the pending inbox batch; full history is only built later from the session surface. There was nothing to prune.')),
              Note(t('本插件不承担历史压缩。实际处理者由宿主与模块配置决定；安装本套件时，请以「上下文压缩」页显示的处理者和运行状态为准。',
                'This plugin does not own history compaction. The host and module configuration determine the actual owner; check Context compression for the current owner and runtime state.')),
              Note(t('旧版批次裁剪：仅兼容旧配置，当前不执行。历史压缩的处理者与运行状态请查看「上下文压缩」。', 'Legacy batch pruning: old configuration is accepted, but no pruning runs. See Context compression for its owner and runtime state.')),
            ])),

          Section(t('无进展识别', 'No-progress watch'),
            Col([
              CommonRef(t('无进展提醒', 'No-progress watch'), 'progressWatch'),
              Note(t('新内容指纹、新区间、结果变化或新读数都算进展；仅时间戳变化不算。', 'New content, ranges, results or readings count as progress; timestamps alone do not.')),
              SelectField(t('模式', 'Mode'), 'progressMode',
                [['observe', t('observe（只记录，不发消息）', 'observe (record only)')], ['enforce', t('enforce（发提醒）', 'enforce (send notices)')]],
                t('默认 observe：先观察误判率，确认不会误伤正常开发再切 enforce。',
                  'Defaults to observe: measure the false-positive rate before enforcing.')),
              NumberField(t('同一失败重复几次算无进展', 'Identical failures before flagging'), 'progressFailureThreshold', 2, 20, 1),
              Note(t('分段读取一个大文件不算重复；编辑后验证、外部修改、压缩后的必要回读也不算。提醒有冷却（2 分钟）和单阶段预算（6 条），不会逐条永久累积。',
                'Reading distinct ranges of one file is not repetition; neither is verifying after an edit, external changes, or a necessary re-read after compaction. Notices are cooled down (2 min) and budgeted per stage (6), so they never accumulate forever.')),
            ])),

          Section(t('阶段预算与无活动时限', 'Stage budget and idle limit'),
            Col([
              NumberField(t('阶段预算（毫秒）—— 到点触发复盘', 'Stage budget (ms) — triggers a review'), 'taskBudgetMs', 60000, 86400000, 60000),
              NumberField(t('阶段预算（模型回复次数）', 'Stage budget (model replies)'), 'taskBudgetReplies', 5, 2000, 1),
              Note(t('**到点只是复盘提醒，不是自动成功、也不是自动放弃。** 提醒只要求回三件事：新证据、剩余必需项、下一个方法。复杂任务可以写明理由后扩大预算。',
                'Hitting the budget only triggers a review — it never marks success or gives up. The notice asks for exactly three things: new evidence, remaining required items, next approach. Complex tasks may extend the budget with a stated reason.')),
              NumberField(t('多久没有新活动算"疑似无响应"（毫秒）', 'Idle threshold (ms)'), 'idleLimitMs', 5000, 3600000, 1000),
              SelectField(t('到点怎么做', 'What to do when reached'), 'idleAction',
                [['observe', t('observe（只在状态里显示）', 'observe (status only)')], ['notify', t('notify（提示一次）', 'notify (one notice)')]],
                t('**无消息不等于无进程活动** —— 后台构建、长测试都在跑。所以这里只提示、不自动停；要自动停请显式改成更严格的策略并自己承担误杀风险。',
                  'No message does not mean no process activity — background builds and long tests are still running. So this only notifies; it never auto-stops.')),
              SettingToggle('stageContract', t('最小阶段合同（warden_stage）', 'Minimal stage contract (warden_stage)'), c.stageContract, (v) => save({ stageContract: v }),
                t('记录目标 / 验收项 / 源码与部署身份 / 当前假设 / 新证据 / 下一步 / 资源占用 / 剩余必需项。**缺必需项时不能写 complete**，只能落到 conditional-complete、blocked 或 failed —— 三者可区分。',
                  'Records goal, acceptance items, source/deploy identity, current hypothesis, new evidence, next step, resource claims and remaining required items. complete is refused while required items are missing; use conditional-complete, blocked or failed instead.')),
              SettingToggle('capabilityPrecheck', t('工具失败分型', 'Tool-failure classification'), c.capabilityPrecheck, (v) => save({ capabilityPrecheck: v }),
                t('把失败分成能力不支持 / 认证缺失 / 路径环境 / 契约 / 瞬时 / 资源冲突 / 业务失败，各给不同的下一步 —— 而不是一律"再试一次"。能力不支持这一类会单独记下来，避免各会话反复撞同一堵墙。',
                  'Classifies failures into capability / auth / path-env / contract / transient / resource-conflict / business, each with a different next step instead of "just retry". Capability gaps are recorded so sessions stop re-hitting the same wall.')),
            ])),

          Section(t('返工与重复读', 'Rework and re-reads'),
            Col([
              SettingToggle('reworkNudge', t('返工提醒', 'Rework nudge'), c.reworkNudge, (v) => save({ reworkNudge: v }),
                t('按"同一个文件"计数。宿主自带的提醒是按"同一次调用"算的 —— 两次内容不同的 edit 不算重复，而实测最烧时间的返工恰恰是"同一个文件改了 31 次"，每次内容都不一样。这条正好补上那个洞。',
                  'Counts per file. The built-in reminder keys on the exact call, so two different edits of the same file never count as a repeat — yet the measured worst case was 31 edits to one file. This fills that hole.')),
              NumberField(t('同一文件改到第几次提醒', 'Nudge at edit #'), 'reworkThreshold', 2, 50, 1),
              SettingToggle('rereadNudge', t('重复读提醒', 'Re-read nudge'), c.rereadNudge, (v) => save({ rereadNudge: v }),
                t('实测同一个文件被读了 60 次。读没变的东西等于白烧 token。',
                  'One file was measured being read 60 times. Re-reading an unchanged file just burns tokens.')),
              NumberField(t('同一文件读到第几次提醒', 'Nudge at read #'), 'rereadThreshold', 2, 50, 1),
            ])),
        ])
      }











      function RuntimeTab() {
        const c = state.config
        const capOf = (name) => state.capabilities.find((x) => x.name === name) ?? null
        const capState = (name) => {
          const cap = capOf(name)
          if (!cap) return [t('未登记', 'unregistered'), '']
          const text = CAP_STATE_TEXT[cap.state] ?? [cap.state, cap.state, '']
          return [t(text[0], text[1]), cap.reason || text[2] || '']
        }


        const capRow = (label, configured, capName) => {
          const [stateText, reason] = capState(capName)
          return h('div', {
            key: capName,
            style: { ...rowStyle, justifyContent: 'space-between', borderTop: border, padding: '8px 0', gap: 8 },
          },
          h('span', { style: { flex: '1 1 200px' } }, label),
          h('span', { style: { opacity: .7, whiteSpace: 'nowrap' } },
            t('配置', 'cfg') + '：' + (configured ? t('开', 'on') : t('关', 'off'))),
          h('span', { style: { whiteSpace: 'nowrap', fontWeight: 600 } }, stateText),
          reason ? h('span', { style: { ...hintStyle, flex: '1 1 100%' } }, reason) : null)
        }

        const govRow = (g) => h('div', {
          key: g.capability,
          style: { ...rowStyle, justifyContent: 'space-between', borderTop: border, padding: '8px 0' },
        },
        h('span', null, g.label || g.capability),
        h('span', { style: { opacity: .85 } },
          g.active
            ? t('dsh-warden 执行', 'executed by dsh-warden')
            : (g.owner ? t('由 ', 'by ') + g.owner + t(' 执行，本模块待命', ' — this module stands by') : t('无人声明', 'unclaimed'))))

        const latestStage = state.stages[0] ?? null
        const idleLimit = Number(c.idleLimitMs) || 0
        const progressRows = state.progress.slice(0, 8)


        const progressRow = (p) => {
          const idleSecs = Math.round((p.idleMs ?? 0) / 1000)
          const stalled = idleLimit > 0 && (p.idleMs ?? 0) >= idleLimit
          return h('div', { key: p.sessionId, style: { borderTop: border, padding: '9px 0' } },
            h('div', { style: { ...rowStyle, justifyContent: 'space-between' } },
              h('span', { style: mono }, String(p.sessionId).slice(0, 18)),
              h('span', { style: { fontWeight: stalled ? 700 : 400 } },
                stalled
                  ? t('疑似无响应 ' + idleSecs + ' 秒（策略：' + c.idleAction + '）', 'idle ' + idleSecs + 's (policy: ' + c.idleAction + ')')
                  : t('最后进展 ' + idleSecs + ' 秒前', 'last progress ' + idleSecs + 's ago'))),
            h('div', { style: hintStyle },
              t('阶段', 'stage') + ' ' + (p.stageId ?? '—')
              + ' · ' + t('回复', 'replies') + ' ' + (p.replies ?? 0)
              + ' · ' + t('新读数', 'readings') + ' ' + (p.evidenceMarks ?? 0)
              + ' · ' + t('被否定的假设', 'negated hypotheses') + ' ' + (p.hypothesesNegated ?? 0)),
            h('div', { style: hintStyle }, t('最后有效进展：', 'Last real progress: ') + (p.lastProgressReason || t('未知', 'unknown'))))
        }

        const statusLabel = (status) => ({
          'in-progress': t('进行中', 'in progress'),
          'conditional-complete': t('有条件完成', 'conditionally complete'),
          blocked: t('阻塞（等人）', 'blocked (needs a human)'),
          failed: t('失败', 'failed'),
          complete: t('完成', 'complete'),
        })[status] ?? status

        return Col([
          Section(t('现在在干什么', 'What is happening now'),
            Col([
              latestStage
                ? Col([
                  h('div', { style: { ...rowStyle, justifyContent: 'space-between' } },
                    h('strong', null, t('当前阶段', 'Current stage') + '：' + (latestStage.stageId || 'default')),
                    h('span', null, statusLabel(latestStage.status))),
                  h('div', { style: hintStyle }, t('目标', 'Goal') + '：' + (latestStage.goal || t('未填', 'not set'))),
                  latestStage.hypothesis ? h('div', { style: hintStyle }, t('当前假设', 'Hypothesis') + '：' + latestStage.hypothesis) : null,
                  latestStage.newEvidence ? h('div', { style: hintStyle }, t('最近新证据', 'Latest evidence') + '：' + latestStage.newEvidence) : null,
                  latestStage.nextStep ? h('div', { style: hintStyle }, t('下一步', 'Next step') + '：' + latestStage.nextStep) : null,
                  h('div', { style: hintStyle },
                    t('验收项', 'Acceptance') + '：'
                    + (latestStage.acceptance ?? []).filter((a) => a.verified).length + '/' + (latestStage.acceptance ?? []).length
                    + t(' 已有依据', ' with evidence')),
                  (latestStage.requiredRemaining ?? []).length > 0
                    ? h('div', { style: hintStyle }, t('剩余必需项', 'Required remaining') + '：' + latestStage.requiredRemaining.join('、'))
                    : null,
                  latestStage.sourceIdentity ? h('div', { style: { ...hintStyle, ...mono } }, t('源码身份', 'Source') + '：' + latestStage.sourceIdentity) : null,
                ])
                : Note(t('还没有阶段记录。模型调 warden_stage 之后这里会显示目标、验收项、当前假设、剩余必需项和下一步。',
                  'No stage recorded yet. Once the model calls warden_stage, this shows the goal, acceptance items, current hypothesis, remaining required items and next step.')),
              Note(t('阶段预算到点只会触发一次复盘提醒，**不会**自动判成功、也**不会**自动放弃。缺必需项时 complete 会被拒。',
                'Reaching the stage budget only triggers a review — it never auto-completes or auto-abandons. complete is refused while required items are missing.')),
            ])),

          Section(t('各会话进展与无活动', 'Per-session progress and idleness'),
            Col([
              Note(t('当前预算：', 'Current budget: ') + Math.round((Number(c.taskBudgetMs) || 0) / 60000) + t(' 分钟或 ', ' min or ')
                + (Number(c.taskBudgetReplies) || 0) + t(' 次模型回复，先到者触发复盘。无活动超过 ', ' replies, whichever first. Idle beyond ')
                + secs(idleLimit) + t(' 会按「' + c.idleAction + '」处理。', ' is handled per "' + c.idleAction + '".')),
              Note(t('⚠ 无消息不等于无进程活动：后台构建、长测试都还在跑。所以默认只提示，不自动停。',
                'No message does not mean no process activity — background builds and long tests keep running. So the default only notifies; it never auto-stops.')),
              progressRows.length === 0
                ? Note(t('还没有观察到任何会话活动。', 'No session activity observed yet.'))
                : Col(progressRows.map(progressRow)),
            ])),

          Section(t('资源执行权（谁占着什么）', 'Resource execution rights (who holds what)'),
            Col([
              state.locks.length === 0
                ? Note(t('当前没有任何资源被占用。', 'No resource is currently held.'))
                : Col(state.locks.map((l) => h('div', { key: l.id || l.name, style: { borderTop: border, padding: '9px 0' } },
                  h('div', { style: { ...rowStyle, justifyContent: 'space-between' } },
                    h('strong', null, l.resourceId || l.name),
                    Button(t('强制释放', 'Force release'), () => releaseLock(l.name, l.resourceId))),
                  h('div', { style: hintStyle },
                    t('持有者', 'owner') + ' ' + l.owner + ' · fence ' + l.fence + ' · ' + ttl(l.expiresAt)
                    + (l.note ? ' · ' + l.note : '')),
                  h('div', { style: hintStyle },
                    t('被拦时你能做的独立工作：不依赖这个资源的部分照做，或改用自己的隔离目录/部署目标。',
                      'If blocked: keep doing work that does not need this resource, or switch to your own isolated directory/deploy target.')))))  ,
              Note(t('统计', 'Stats') + '：' + JSON.stringify(state.lockStats ?? {})),
              Note(t('覆盖边界：护栏只拦得住**认得出资源身份**的写入。任意 shell 命令里看不出来的写入不在覆盖范围内 —— 那部分会记进「覆盖缺口」，不假装全面强制。',
                'Coverage boundary: only writes whose resource identity can be resolved are blocked. Writes hidden inside arbitrary shell commands are out of scope and are recorded as a coverage gap — never claimed as globally enforced.')),
            ])),

          Section(t('护栏到底生效了没有（R7）', 'Is the guard actually working (R7)'),
            Col([
              Note(t('"配置开"只说明你打开了开关；"已挂载"说明钩子真的挂上了；**"已命中"才证明它生效过**。三者分开显示，不再用一个"已启用"糊过去。',
                '"Configured on" only means the switch is on; "mounted" means the hook is really attached; only "observed" proves it has fired. All three are shown separately.')),
              h('div', { style: { border, borderRadius: 6, padding: '2px 12px 8px' } }, [
                capRow(t('子代理等待上限', 'Subagent wait cap'), c.waitCapMs > 0, 'waitCap'),
                capRow(t('共享资源执行权', 'Resource execution rights'), c.lockGuard, 'sharedLock'),
                capRow(t('用量采样', 'Usage sampling'), true, 'usageSampling'),
                capRow(t('当前上下文压力', 'Context pressure'), c.waterLevelNudge, 'contextPressure'),
                capRow(t('水位提醒', 'Watermark nudge'), c.waterLevelNudge, 'waterLevelNudge'),
                capRow(t('系统提示词规则段', 'System-prompt rules section'), c.starTopology || c.resultsToFile, 'rulesSection'),
                capRow(t('规则消息兜底', 'Rules message fallback'), true, 'rulesFallback'),
                capRow(t('大输出归档', 'Large-output archiving'), c.archiveToolResults, 'archiveToolResults'),
                capRow(t('无进展识别', 'No-progress watch'), c.progressWatch, 'progressWatch'),
                capRow(t('工具失败分型', 'Failure classification'), c.capabilityPrecheck, 'capabilityPrecheck'),
                capRow(t('读数指纹台账', 'Evidence ledger'), c.evidenceLedger, 'evidenceLedger'),
                capRow(t('阶段合同', 'Stage contract'), c.stageContract, 'stageContract'),
                capRow(t('设置持久化', 'Settings persistence'), true, 'settingsPersistence'),
                capRow(t('设置页数据面', 'Settings data plane'), true, 'httpRoutes'),
                capRow(t('历史压缩（不归 warden）', 'History compaction (not warden)'), false, 'historyPruning'),
              ]),
            ])),

          Section(t('跨模块治理 owner', 'Cross-module governance owner'),
            Col([
              Note(t('等待上限与水位提醒在套件里有两个实现（warden 与 strata）。谁执行由一条**活着的治理声明**决定 —— 判据是"谁真的挂上了钩子并持续心跳"，**不是**"对方的目录在不在"。两个同时开时只有一个执行，所以你不会收到两份重复提醒。',
                'The wait cap and watermark nudge exist in two modules (warden and strata). A live governance claim decides who executes — based on who actually mounted the hook and keeps heartbeating, not on whether the other package directory exists. Only one runs when both are enabled, so you never get duplicate nudges.')),
              state.governance.length === 0
                ? Note(t('没有需要仲裁的治理能力。', 'No governed capabilities.'))
                : Col(state.governance.map(govRow)),
              Note(t('交接期最坏有一个心跳（2 秒）的窗口两边都在执行，这一点是明确记录的，不假装原子。被抢占的一方在下一次心跳自动待命。',
                'Handover has a worst-case one-heartbeat (2s) window where both may run; this is documented, not pretended to be atomic. The preempted module stands by at its next heartbeat.')),
            ])),

          Section(t('配置有没有真的存下来', 'Was the config actually saved'),
            Col([
              Note(t('持久化状态：', 'Persistence: ')
                + (state.persistence.persisted === true ? t('已落盘', 'written to disk')
                  : state.persistence.persisted === false ? t('**写盘失败** —— 内存里生效，重启会丢', '**write failed** — in memory only, lost on restart')
                    : t('尚未写过', 'never written'))
                + (state.persistence.reason ? '（' + state.persistence.reason + '）' : '')),
              Note(t('回读校验：', 'Read-back check: ')
                + (state.persistedCheck.matches ? t('内存与盘上一致', 'memory matches disk')
                  : t('不一致或盘上没有', 'mismatch or missing') )
                + (state.persistedCheck.reason ? '（' + state.persistedCheck.reason + '）' : '')),
              Note(t('保存失败时这一页**不会**显示"已保存" —— 顶部状态条会直接给出失败原因。',
                'On a failed save this page never shows "Saved" — the status line at the top gives the failure reason instead.')),
            ])),
        ])
      }


      function DiagTab() {
        const c = state.config

        const addIgnore = () => {
          const value = state.draftIgnore.trim()
          if (!value) return
          const next = [...(c.pathIgnore ?? []), value].slice(0, 16)
          state.draftIgnore = ''
          save({ pathIgnore: next })
        }

        const evidenceRow = (r) => h('div', { key: r.id, style: { borderTop: border, padding: '10px 0' } },
          h('div', null, h('strong', null, r.label), ' = ', r.reading),
          h('div', { style: { ...hintStyle, overflowWrap: 'anywhere' } },
            stamp(r.at)
              + (r.artifactHash ? ' · sha256:' + r.artifactHash.slice(0, 12) + ' (v' + (r.hashVersion ?? 1) + ')' : ' · ' + t('无指纹 → unverified', 'no hash → unverified'))
              + (r.artifact ? ' · ' + tail(r.artifact) : '')))

        const ignoreRow = (p) => h('div', {
          key: p,
          style: { ...rowStyle, justifyContent: 'space-between', borderTop: border, padding: '8px 0' },
        },
        h('span', { style: { ...mono, overflowWrap: 'anywhere' } }, p),
        Button(t('移除', 'Remove'), () => save({ pathIgnore: (c.pathIgnore ?? []).filter((x) => x !== p) })))

        const eventRow = (e, i) => h('div', {
          key: e.at + '-' + i,
          style: { ...mono, padding: '3px 0', overflowWrap: 'anywhere', opacity: .9 },
        }, stamp(e.at) + ' · ' + (e.kind ?? '—') + (e.detail ? ' · ' + e.detail : ''))

        const statLine = state.stats.length === 0
          ? t('还没有统计（护栏可能没挂上，或这一轮还没发生任何事）。', 'No stats yet — hooks may be unmounted, or nothing happened yet.')
          : state.stats.map((s) => s.name + ': ' + JSON.stringify(s.stats ?? {})).join('　')








        const reportBlock = () => {
          const r = state.report
          if (r === null) {
            return Section(t('收益自报表（今日）', 'Self-report (today)'), Note(t('正在读取…', 'Loading…')))
          }

          if (r.disabled === true) return null
          if (r.known !== true) {
            return Section(t('收益自报表（今日）', 'Self-report (today)'), Col([
              Note(t('暂时没有可统计的数据：', 'Nothing to report yet: ') + (r.reason ?? '')),
            ]))
          }
          const d = r.data ?? {}
          const archives = d.archives ?? { count: 0, savedChars: 0, savedTokensEst: 0 }
          const notices = d.notices ?? { byKind: {}, total: 0 }
          const evidence = d.evidence ?? { known: false, count: null }
          const fmt = (n) => Number(n ?? 0).toLocaleString('en-US')
          const parts = []
          Object.keys(notices.byKind ?? {}).forEach((kind) => {
            parts.push(kind + ' ' + fmt(notices.byKind[kind]))
          })
          const archiveLine = archives.count === 0
            ? t('今日没有归档发生。', 'No archiving today.')
            : t('归档 ' + fmt(archives.count) + ' 次，省下 ' + fmt(archives.savedChars) + ' 字符。',
              fmt(archives.count) + ' archives saved ' + fmt(archives.savedChars) + ' characters.')
          const costLine = d.cost
            ? t('花费约 $' + Number(d.cost.usd).toFixed(4) + '（' + fmt(d.cost.sessions) + ' 个会话 / '
              + fmt(d.cost.requests) + ' 次请求' + (d.cost.estimated ? '，按官方价目估算' : '') + '）。',
            'About $' + Number(d.cost.usd).toFixed(4) + ' across ' + fmt(d.cost.sessions) + ' sessions / '
              + fmt(d.cost.requests) + ' requests' + (d.cost.estimated ? ' (estimated from official prices)' : '') + '.')
            : t('花费：未统计（内存账本里没有可用金额，warden 不会把"拿不到"写成 $0）。',
              'Cost: not available (no priced usage in the in-memory ledger; warden never reports "unknown" as $0).')
          const sinceText = new Date(d.from ?? 0).toLocaleString()
          const toText = new Date(d.to ?? 0).toLocaleString()
          return Section(t('收益自报表（今日）', 'Self-report (today)'), Col([
            Note(archiveLine),
            Note(t('约 ' + fmt(archives.savedTokensEst) + ' token —— **估算**：按"归档后这段原文不再在后续每一步重发"'
              + '折算（2.5 字符/token），不是实测 usage，也不是账单。',
            'About ' + fmt(archives.savedTokensEst) + ' tokens — an ESTIMATE: archived text is not re-sent on every later step, '
              + 'converted at 2.5 chars/token. Not measured usage and not a bill.')),
            Note(t('提醒：', 'Nudges: ') + (parts.length === 0 ? t('今日没有发过提醒。', 'none today.')
              : parts.join('　')) + t('（合计 ' + fmt(notices.total) + ' 条）', ' (total ' + fmt(notices.total) + ')')),
            Note(evidence.known === true
              ? t('读数台账：今日新增 ' + fmt(evidence.count) + ' 条。', 'Evidence ledger: ' + fmt(evidence.count) + ' new rows today.')
              : t('读数台账：未统计。', 'Evidence ledger: not available.')),
            Note(costLine),
            Note(t('统计范围：' + sinceText + ' → ' + toText + '（本地时区）。刷新页面重新统计。',
              'Range: ' + sinceText + ' → ' + toText + ' (local time). Reload to recompute.')),
          ]))
        }

        return Col([
          reportBlock(),
          Section(t('失败时的提示', 'Hints on failure'),
            Col([
              SettingToggle('editMissHint', t('改文件没匹配上时提示"先重读"', 'Hint to re-read first on edit misses'), c.editMissHint, (v) => save({ editMissHint: v }),
                t('实测 8 次 old_string was not found。纯文本匹配本来就脆（文件被上一轮改过、全角括号、换行差异都会失配），提示模型先重读比让它原地重试有效得多。',
                  '8 measured edit-miss failures. Text matching is brittle; telling the model to re-read beats retrying in place.')),
              SettingToggle('unknownToolHint', t('未知工具时附上真实工具清单', 'Attach the real tool list on unknown tools'), c.unknownToolHint, (v) => save({ unknownToolHint: v }),
                t('实测 4 次 unknown tool。宿主只报一句错，模型看不到"到底有哪些工具"，于是继续凭记忆拼名字。这里把当前 agent 的真实清单附上。',
                  '4 measured unknown-tool calls. The host just errors; the model keeps guessing names. This attaches the actual schema list.')),
              Note(t('这两条只在**调用已经失败**时才触发，所以不可能误伤正常调用。',
                'Both fire only after a call has already failed, so they can never break a working call.')),
            ])),

          Section(t('读数指纹台账', 'Evidence ledger'),
            Col([
              SettingToggle('evidenceLedger', t('启用台账', 'Enable the ledger'), c.evidenceLedger, (v) => save({ evidenceLedger: v }),
                t('记读数时把当时产物的 sha256 一起写下；复核时先比指纹，对不上就直接判这条读数作废 —— 治的是"验收期间部署反复变化，读数无法归属"。',
                  'Records the artifact sha256 alongside each reading; on check, a mismatch invalidates it. Targets "the deployment kept changing and readings could not be attributed".')),
              Note(t('累计', 'Total') + ' ' + state.evidence.total + ' ' + t('条，涉及', 'rows across') + ' ' + state.evidence.artifacts + ' ' + t('个不同产物指纹', 'distinct artifact hashes')
                + ' · ' + t('已绑指纹', 'bound') + ' ' + (state.evidence.bound ?? 0)
                + ' · ' + t('未绑', 'unbound') + ' ' + (state.evidence.unbound ?? 0)
                + ' · ' + t('旧算法', 'legacy hash') + ' ' + (state.evidence.legacyHashVersion ?? 0)),
              Note(t('复核有四种状态，**绝不把"不知道"显示成"有效"**：verified（指纹逐字节一致）/ stale（产物已漂移，读数作废）/ unverified（没绑产物、环境未知或旧算法指纹）/ error（算不出当前指纹）。verified 只证明产物身份没变，不证明测试通过、也不证明实验环境没被污染。',
                'Checks return four states and never show "unknown" as "valid": verified (byte-identical hash) / stale (artifact drifted, reading void) / unverified (unbound, unknown environment, or a legacy hash) / error. verified only proves artifact identity — not that tests passed or the environment was clean.')),
              Note(t('指纹是**字节级** sha256。旧版先把 Buffer 转成字符串再 hash，导致 0x80 与 0x81 两个不同文件撞成同一个指纹，exe/dll/图片全部失真；v1 的旧记录会被判 unverified，必须重记，不会静默沿用。',
                'Hashes are byte-level sha256. The old version stringified the Buffer first, so 0x80 and 0x81 collided into one hash and every exe/dll/image fingerprint was wrong. v1 records are reported as unverified and must be re-recorded — never silently inherited.')),
              state.evidenceRows.length === 0
                ? Note(t('台账还是空的。让模型用 evidence_record 记一条试试。', 'Empty so far. Ask the model to call evidence_record.'))
                : Col(state.evidenceRows.slice(0, 12).map(evidenceRow)),
            ])),

          Section(t('忽略名单', 'Ignore list'),
            Col([
              Note(t('本插件对这些路径完全不介入（不查锁、不发提醒、不记账）。适合 node_modules/、.git/、构建产物目录这类"本来就会反复读写、提醒只会变成噪声"的地方。',
                'The plugin stays completely out of these paths — no lock checks, no nudges, no records. Good for node_modules/, .git/, build output.')),
              Note(t('这不是"给沙箱放行"的开关。插件层没有权限绕过文件系统级的 cannot read / cannot modify —— 那是系统层的事，见 README。',
                'This is not a sandbox bypass. The plugin cannot override filesystem-level read/write denials — see the README.')),
              (c.pathIgnore ?? []).length === 0
                ? Note(t('名单是空的。', 'The list is empty.'))
                : Col((c.pathIgnore ?? []).map(ignoreRow)),
              h('label', { style: { ...rowStyle, marginTop: 10 } },
                h('input', {
                  type: 'text', 'data-setting-key': 'pathIgnore', 'aria-label': t('新增忽略路径', 'Add ignored path'), value: state.draftIgnore,
                  placeholder: t('例如 D:/build', 'e.g. D:/build'),
                  style: { ...inputStyle, flex: '1 1 260px' },
                  disabled: state.busy || !state.ready,
                  onChange: (e) => { state.draftIgnore = e.target.value; update() },
                  onKeyDown: (e) => { if (e.key === 'Enter') addIgnore() },
                }),
                Button(t('加入', 'Add'), addIgnore, !state.draftIgnore.trim())),
            ])),

          Section(t('运行时统计与事件', 'Runtime stats and events'),
            Col([
              Note(statLine),
              Note(t('数据目录', 'Data dir') + '：' + (state.paths?.dir ?? '—')),
              state.events.length === 0
                ? Note(t('还没有事件。', 'No events yet.'))
                : h('div', { style: { maxHeight: 260, overflowY: 'auto', border, borderRadius: 6, padding: '6px 10px' } },
                    state.events.slice(0, 40).map(eventRow)),
            ])),
        ])
      }


      function Settings() {
        const [, setTick] = React.useState(0)
        bump = setTick
        const binding = React.useSyncExternalStore(subscribeBinding, getBinding, getBinding)
        const selectedSession = binding?.key

        React.useEffect(() => {
          if (state.busy) { state.refreshPending = true; return }
          run(async () => { await refresh() })
        }, [selectedSession])

        const tabs = [
          ['tier', t('档位', 'Tier')],
          ['runtime', t('运行状态', 'Runtime')],
          ['subagent', t('子代理', 'Subagents')],
          ['context', t('执行与预算', 'Execution & budget')],
          ['diag', t('诊断', 'Diagnostics')],
        ]

        const tabButton = (item) => h('button', {
          key: item[0], type: 'button', 'aria-pressed': state.tab === item[0],
          onClick: () => { state.tab = item[0]; update() },
          style: {
            ...inputStyle, fontWeight: state.tab === item[0] ? 700 : 400,
            textDecoration: state.tab === item[0] ? 'underline' : 'none',
          },
        }, item[1])

        const body = state.tab === 'tier' ? TierTab()
          : state.tab === 'runtime' ? RuntimeTab()
            : state.tab === 'subagent' ? SubagentTab()
              : state.tab === 'context' ? ContextTab()
                : DiagTab()

        const statusLine = state.problem
          ? t('操作未完成：', 'Action failed: ') + state.problem
          : state.busy
            ? t('正在保存或读取…', 'Saving or loading…')
            : state.persistence && state.persistence.persisted === false

              ? t('配置未落盘（重启会丢）：', 'Config NOT persisted (lost on restart): ') + (state.persistence.reason ?? '')
              : state.notice || (state.ready ? t('已连接宿主', 'Connected') : t('正在连接宿主…', 'Connecting…'))

        return h('div', { 'data-laurel-module': '', style: { padding: '4px 2px 28px', fontSize: 13, lineHeight: 1.5, maxWidth: 780, color: 'inherit' } },
          h('h2', { className: 'lc-embedded-heading', style: { fontSize: 18, margin: '0 0 6px' } }, t('内耗护栏', 'Friction guard')),
          h('p', { className: 'lc-embedded-description', style: { margin: '0 0 14px' } },
            t('治的不是"模型不聪明"，而是几件事凑一起的内耗：子代理干等、互相串扰、同一个文件反复返工、上下文只涨不降、共享目录互踩。',
              'Not about making the model smarter — it targets friction: subagents idling, cross-talk, repeated rework on one file, context that only grows, and shared directories being trampled.')),

          h('div', {
            role: state.problem ? 'alert' : 'status', 'aria-live': 'polite',
            className: state.ready && !state.problem && !state.busy && !state.notice && state.persistence?.persisted !== false ? 'lc-idle-status' : undefined,
            style: { minHeight: 24, marginBottom: 8 },
          }, statusLine),

          h('nav', {
            'aria-label': t('护栏设置菜单', 'Guard settings menu'),
            style: { ...rowStyle, gap: 6, margin: '12px 0 8px', borderBottom: border, paddingBottom: 10 },
          }, tabs.map(tabButton)),

          body,

          h('details', { style: { marginTop: 24 } },
            h('summary', { style: { cursor: 'pointer' } }, t('这个插件拦了什么、提醒了什么', 'What this plugin blocked and nudged')),
            Note(t('上面「诊断」页的最近事件就是全部流水。',
              'The event stream on the Diagnostics tab is the full record.')),
            Note(t('护栏坏掉时会**放行宿主和业务工具**（所有 IO 与钩子都吞异常，宁可不管、不可误伤），但它**不会伪造自己成功** —— 每一次降级都会写进「运行状态」页的能力台账并限频记一条本地事件。所以"已启用"和"真的在生效"永远分开显示。',
              'If the guard breaks it lets the host and business tools through (every hook swallows its own errors — never interfere), but it never fakes its own success: each degradation is written to the capability table on the Runtime tab and rate-limited into the local event log. So "enabled" and "actually working" are always shown separately.'))))
      }

      registerSettingsSection(ctx, {
        id: 'warden',
        order: 58,
        label: () => t('内耗护栏', 'Friction guard'),
        component: Settings,
        slots: ctx.slots,
      })
    }


    module.exports.apply = apply
    if (typeof inject !== 'undefined') module.exports.inject = inject
    return module.exports
  },
})

window.__ModuleLoader__.load({
  id: 'laurel',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement

    /** 宿主半边注册的端点前缀。 */
    const API = '/laurel'

    /**
     * 内置默认值 —— **必须和 lib/store.js 的 DEFAULT_CONFIG 一致**（测试会核对）。
     * 为什么在这里再抄一份：宿主路由拿不到时（非 Web 组合、或插件被单独加载）
     * 通知还得能按默认值工作，不能因为读不到配置就整个哑掉。
     */
    const FALLBACK = {
      notifyOnQuestion: true,
      notifyOnPlanReview: true,
      notifyOnApproval: true,
      notifyOnCompletion: false,
      onlyWhenUnfocused: true,
      toast: true,
      toastMs: 6000,
      toastCorner: 'bottom-right',
      toastOnQuestion: true,
      toastOnApproval: true,
      toastOnPlanReview: true,
      toastOnCompletion: false,
      throttleSeconds: 30,
      sound: true,
      soundFile: '',
      sticky: true,
      title: '',
      maxBodyChars: 140,
      language: 'auto',
      logLevel: 'info',
    }

    /** 页内卡片允许的四个角落（宿主半边 lib/store.js 里那份白名单必须与这份一致）。 */
    const TOAST_CORNERS = ['bottom-right', 'bottom-left', 'top-right', 'top-left']

    const TEXT = {
      zh: {
        label: '通知',
        heading: '系统通知', rulesTab: '提醒规则', appearanceTab: '声音与卡片', diagnosticsTab: '运行诊断',
        intro: 'agent 需要你的时候提醒你。',
        /* ── 顶部「当前效果」摘要：把 4 个区块的配置折算成一句人话 ──────────
         * 上一版的毛病：用户要在「通知时机」「事件表」「系统通知」「页内卡片」
         * 四块之间做乘法，才能推出"到底什么时候会弹"。这里直接把结论写出来。
         */
        effectHeading: '当前效果',
        effectOff: '通知全关了 —— 什么都不会弹。',
        effectNoEvents: '没有勾选任何事件',
        effectPrefix: '提醒：',
        effectSummary: {
          background: '窗口在后台时发系统通知；在前台不打扰。',
          foreground: '只在窗口在前台时弹卡片；窗口收起来就不提醒。',
          both: '窗口在前台弹卡片，在后台发系统通知。',
        },
        kindShort: {
          notifyOnQuestion: '提问',
          notifyOnPlanReview: '计划确认',
          notifyOnApproval: '审批',
          notifyOnCompletion: '回合结束',
        },
        /* ── 折叠区标题 ───────────────────────────────────────────────── */
        foldSoundHint: '留空 = 用系统通知音',
        timing: '通知时机',
        timingBackground: '只在后台',
        timingBackgroundHint: '走系统通知。你正看着窗口时不打扰 —— 但那样也就看不到任何提示。',
        timingForeground: '只在前台',
        timingForegroundHint: '走页内卡片，就在眼前。窗口收起来时不打扰。',
        timingBoth: '两种都发',
        timingBothHint: '没在前台发系统通知，在前台弹页内卡片。哪边都不漏。',
        eventsHeading2: '哪些事件要提醒我',
        colSystem: '系统通知',
        colCard: '页内卡片',
        notifyOnQuestion: '需要你回答',
        notifyOnQuestionHint: 'agent 用提问工具停下来等你回答。',
        notifyOnApproval: '需要你审批',
        notifyOnApprovalHint: '工具要权限、停下来等你点。',
        notifyOnPlanReview: '计划待确认',
        notifyOnPlanReviewHint: 'agent 让你确认一份计划。',
        notifyOnCompletion: '回合结束',
        notifyOnCompletionHint: '干完了也响一声。默认关闭：长任务会响很多次。',
        matrixNote: '左列是窗口没在前台时走的系统通知，右列是窗口在前台时弹的页内卡片。每一类事件、每一条通路都各有一个开关 —— 想让某类只走一种，就把另一列取消勾选（行名旁边会标出「仅后台」或「仅前台」）。',
        /* 只有一侧开着时挂在行名旁边的标记。用户勾了某类的"系统通知"却没勾"页内卡片"，
         * 前台就永远收不到提醒 —— 这件事原本在界面上完全看不出来（2026-09-30 用户实测踩过）。 */
        onlySystem: '仅后台',
        onlyCard: '仅前台',
        systemHeading: '系统通知（窗口没在前台时）',
        systemHint: '出声、以及挡路的通知要不要留在通知中心。',
        sound: '提示音',
        soundHint: '关掉则完全静音（自定义提示音也不响）。',
        soundFileLabel: '自定义提示音',
        soundFileHint: '留空 = Windows 系统通知音。填提示音目录里的文件名（如 ding.wav）、Windows 自带音效的绝对路径（如 C:/Windows/Media/Windows Notify Calendar.wav），或 http(s) 链接。设了自定义音之后，系统通知音会被静音，避免两声叠在一起。',
        soundFilePlaceholder: '例如 ding.wav（留空用系统通知音）',
        preview: '试听',
        previewHint: '马上播一次当前的提示音设置（会先存盘）',
        previewing: '试听中…',
        soundsDir: '提示音目录：',
        noSounds: '目录里还没有音频文件。把 wav / mp3 / ogg / m4a / flac 丢进去，再点下面的「重新读取」。',
        sticky: '留在通知中心',
        stickyHint: '提问 / 审批这类挡路的系统通知，弹出来不自动消失，直到你处理。',
        cardHeading: '页内卡片（窗口在前台时）',
        cardHint: '卡片长什么样：停多久、落在哪个角落。',
        toastMs: '停留（秒，0 = 不自动关）',
        corner: '角落',
        cornerNames: {
          'bottom-right': '右下',
          'bottom-left': '左下',
          'top-right': '右上',
          'top-left': '左上',
        },
        otherHeading: '其他',
        throttle: '同一会话最小间隔（秒）',
        titlePrefix: '标题前缀（留空 = 用会话标题）',
        test: '测试通知',
        testHint: '发一条系统通知（通知中心那条路），窗口在前台也照发 —— 它不受上面「通知时机」和事件表影响。',
        testShown: '系统通知已发出，去通知中心看。',
        testFailed: '系统通知没发出去，请看下面最近事件里的原因。',
        testCard: '试页内卡片',
        testCardHint: '只弹页内卡片，就在眼前，不用去通知中心找。',
        testCardShown: '卡片已弹出，看一眼卡片落在的角落。',
        testCardFailed: '卡片没弹出来，请看下面事件里的原因。',
        reload: '重新读取',
        reloadHint: '重新读配置、提示音目录和通知权限。',
        saving: '保存中…',
        saved: '已保存',
        saveFailed: '保存失败：',
        statusHeading: '运行状态',
        origin: '页面来源',
        supported: '通知 API',
        permission: '通知权限',
        hooks: '状态订阅',
        settingsPath: '配置文件',
        eventsHeading: '最近事件',
        noEvents: '还没有事件。',
        unsupported: '这个环境里没有 Notification API：通知不会弹（下面的事件会记录原因）。',
        question: '有问题想问你',
        planReview: '计划等你确认',
        approval: '要你批准',
        completion: '回合结束',
        approvalBody: (tool) => `工具 ${tool} 请求批准`,
        testTitle: 'DSH 通知测试',
        testBody: '看到这条、并且听到声音，说明通知是通的。',
        toastClose: '关闭',
        toastTitleKind: {
          question: '需要你回答',
          approval: '需要你审批',
          planReview: '计划待确认',
          completion: '回合结束',
          test: '测试通知',
        },
      },
      en: {
        label: 'Notifications',
        heading: 'System notifications', rulesTab: 'Reminder rules', appearanceTab: 'Sound & cards', diagnosticsTab: 'Diagnostics',
        intro: 'Alert you when the agent needs you.',
        effectHeading: 'What happens now',
        effectOff: 'All notifications are off — nothing will pop.',
        effectNoEvents: 'no event is ticked',
        effectPrefix: 'Alerts: ',
        effectSummary: {
          background: 'System notification in the background; nothing while you are looking at the window.',
          foreground: 'In-window card while the window is focused; nothing once it is tucked away.',
          both: 'In-window card while focused, system notification in the background.',
        },
        kindShort: {
          notifyOnQuestion: 'questions',
          notifyOnPlanReview: 'plan review',
          notifyOnApproval: 'approvals',
          notifyOnCompletion: 'turn finished',
        },
        foldSoundHint: 'empty = use the system notification sound',
        timing: 'When to notify',
        timingBackground: 'Background only',
        timingBackgroundHint: 'System notification. No interruption while you are looking at the window — but then you see nothing at all.',
        timingForeground: 'Foreground only',
        timingForegroundHint: 'In-window card, right in front of you. Nothing while the window is tucked away.',
        timingBoth: 'Both',
        timingBothHint: 'System notification in the background, in-window card in the foreground. Nothing gets missed.',
        eventsHeading2: 'Which events should alert me',
        colSystem: 'System',
        colCard: 'Card',
        notifyOnQuestion: 'Needs your answer',
        notifyOnQuestionHint: 'The agent asks you something and waits.',
        notifyOnApproval: 'Needs your approval',
        notifyOnApprovalHint: 'A tool needs permission and is waiting.',
        notifyOnPlanReview: 'Plan needs review',
        notifyOnPlanReviewHint: 'The agent asks you to confirm a plan.',
        notifyOnCompletion: 'Turn finished',
        notifyOnCompletionHint: 'Also chime when a turn ends. Off by default: long tasks ring a lot.',
        matrixNote: 'The left column is the system notification used while the window is in the background; the right column is the in-window card shown while it is focused. Every kind has its own switch on each side — untick one column to keep that kind off that path (the row label will then show "background only" or "focused only").',
        onlySystem: 'background only',
        onlyCard: 'foreground only',
        systemHeading: 'System notification (window in the background)',
        systemHint: 'The sound, and whether blocking notifications stay in the notification centre.',
        sound: 'Sound',
        soundHint: 'Off = completely silent (the custom sound does not play either).',
        soundFileLabel: 'Custom sound',
        soundFileHint: 'Empty = Windows system sound. A file name from the sounds folder (e.g. ding.wav), an absolute path to a Windows sound (e.g. C:/Windows/Media/Windows Notify Calendar.wav), or an http(s) URL. A custom sound mutes the system sound so you never hear two.',
        soundFilePlaceholder: 'e.g. ding.wav (empty = system sound)',
        preview: 'Preview',
        previewHint: 'Plays the current sound setting once (saves first)',
        previewing: 'Playing…',
        soundsDir: 'Sounds folder: ',
        noSounds: 'No audio files yet. Drop wav / mp3 / ogg / m4a / flac in and hit "Reload" below.',
        sticky: 'Keep in notification centre',
        stickyHint: 'Blocking system notifications (question / approval) stay until you deal with them.',
        cardHeading: 'In-window card (window focused)',
        cardHint: 'What the card looks like: how long it stays and which corner it lands in.',
        toastMs: 'Dwell (seconds, 0 = stays)',
        corner: 'Corner',
        cornerNames: {
          'bottom-right': 'Bottom right',
          'bottom-left': 'Bottom left',
          'top-right': 'Top right',
          'top-left': 'Top left',
        },
        otherHeading: 'Other',
        throttle: 'Min seconds between notifications per session',
        titlePrefix: 'Title prefix (empty = session title)',
        test: 'Test notification',
        testHint: 'Sends one system notification (the notification-centre path) even while the window is focused — it ignores "When to notify" and the event table above.',
        testShown: 'System notification sent — check the notification centre.',
        testFailed: 'The system notification did not go out; see the reason in the recent events below.',
        testCard: 'Test in-window card',
        testCardHint: 'Fires only the in-window card, right in front of you — no need to hunt in the notification centre.',
        testCardShown: 'Card fired — take a look at the corner it landed in.',
        testCardFailed: 'The card did not appear; see the reason in the events below.',
        reload: 'Reload',
        reloadHint: 'Re-reads the config, the sounds folder and the notification permission.',
        saving: 'Saving…',
        saved: 'Saved',
        saveFailed: 'Save failed: ',
        statusHeading: 'Runtime status',
        origin: 'Page origin',
        supported: 'Notification API',
        permission: 'Permission',
        hooks: 'Status subscription',
        settingsPath: 'Settings file',
        eventsHeading: 'Recent events',
        noEvents: 'No events yet.',
        unsupported: 'No Notification API in this environment: nothing will pop (events below record why).',
        question: 'Needs your answer',
        planReview: 'Plan needs your review',
        approval: 'Needs your approval',
        completion: 'Turn finished',
        approvalBody: (tool) => `Tool ${tool} requests approval`,
        testTitle: 'DSH notification test',
        testBody: 'If you see this and hear the sound, notifications work.',
        toastClose: 'Close',
        toastTitleKind: {
          question: 'Needs your answer',
          approval: 'Needs your approval',
          planReview: 'Plan needs review',
          completion: 'Turn finished',
          test: 'Test notification',
        },
      },
    }

    /**
     * 页内卡片的样式基础。
     *
     * ⚠️ 字体**不能**继承调用方 —— 卡片挂在 `document.body` 上，而 dsh 的
     *   字体规则作用在更内层的容器上；不显式写一遍就会退化成浏览器默认的
     *   衬线体（Times New Roman），中文尤其难看。
     */
    const CARD_FONT = 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif'

    const T = {
      text: 'var(--dsw-text-primary, #e8eaed)',
      dim: 'var(--dsw-text-secondary, #9aa0a6)',
      faint: 'var(--dsw-text-tertiary, #6b7280)',
      bg2: 'var(--dsw-bg-subtle, #17191d)',
      border: 'var(--dsw-border-subtle, rgba(255,255,255,0.10))',
      accent: '#7cc4ff',
      ok: '#4ade80',
      warn: '#ffb020',
      danger: '#ff6b6b',
    }

    /* ------------------------------------------------------------------ *
     * 运行时状态
     * ------------------------------------------------------------------ */

    /** 生效配置（启动时是内置默认值，读到宿主配置后被覆盖）。 */
    let cfg = { ...FALLBACK }
    /** 读宿主配置失败的原因（设置页要显示它）。 */
    let cfgError = null
    /** 状态订阅是否挂上了。 */
    let watching = false
    /** 最近事件（设置页显示，最多 20 条）。 */
    const recent = []
    /** 节流：全局一条 + 每会话一条。 */
    const throttle = { globalAt: 0, bySession: new Map() }

    function now() {
      return Date.now()
    }

    function originOf() {
      try { return String(location.origin) } catch { return 'unknown' }
    }

    function supported() {
      return typeof Notification === 'function'
    }

    function permissionOf() {
      try { return supported() ? String(Notification.permission ?? 'unknown') : 'unsupported' } catch { return 'unknown' }
    }

    function hasFocus() {
      try { return typeof document.hasFocus === 'function' ? document.hasFocus() : true } catch { return true }
    }

    function visibilityOf() {
      try { return String(document.visibilityState ?? 'unknown') } catch { return 'unknown' }
    }

    function language() {
      if (cfg.language === 'zh' || cfg.language === 'en') return cfg.language
      try {
        const nav = String(navigator.language ?? '')
        return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en'
      } catch { return 'zh' }
    }

    function t() {
      return TEXT[language()] ?? TEXT.zh
    }

    /** 记住 + 回传一条事件。任何失败都吞掉 —— 记日志不能反过来影响通知。 */
    function report(event) {
      const record = { ...event, origin: event.origin ?? originOf() }
      try {
        recent.unshift({ t: new Date().toISOString(), ...record })
        if (recent.length > 20) recent.pop()
      } catch { /* 忽略 */ }
      try {
        const res = fetch(`${API}/event`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(record),
          keepalive: true,
        })
        if (res && typeof res.catch === 'function') res.catch(() => {})
      } catch { /* 回传失败无所谓 */ }
      try {
        if (record.kind === 'error') console.warn('[laurel]', record.detail ?? record.body ?? 'error')
      } catch { /* 忽略 */ }
    }

    /**
     * 宿主配置 → 本地配置。这里**再归一化一次**：
     * 跨进程传过来的东西不可信，一个坏的 `throttleSeconds` 会让节流算成 NaN。
     */
    function adoptConfig(raw) {
      const input = raw && typeof raw === 'object' ? raw : {}
      const out = { ...FALLBACK }
      for (const key of ['notifyOnQuestion', 'notifyOnPlanReview', 'notifyOnApproval', 'notifyOnCompletion', 'onlyWhenUnfocused', 'sound', 'sticky', 'toast', 'toastOnQuestion', 'toastOnApproval', 'toastOnPlanReview', 'toastOnCompletion']) {
        if (typeof input[key] === 'boolean') out[key] = input[key]
      }
      const throttleSeconds = Number(input.throttleSeconds)
      if (Number.isFinite(throttleSeconds)) out.throttleSeconds = Math.min(3600, Math.max(0, Math.round(throttleSeconds)))
      const toastMs = Number(input.toastMs)
      if (Number.isFinite(toastMs)) out.toastMs = Math.min(120000, Math.max(0, Math.round(toastMs)))
      if (typeof input.toastCorner === 'string' && ['bottom-right', 'bottom-left', 'top-right', 'top-left'].includes(input.toastCorner)) out.toastCorner = input.toastCorner
      const maxBodyChars = Number(input.maxBodyChars)
      if (Number.isFinite(maxBodyChars)) out.maxBodyChars = Math.min(500, Math.max(20, Math.round(maxBodyChars)))
      if (typeof input.title === 'string') out.title = input.title.trim().slice(0, 40)
      if (typeof input.soundFile === 'string') out.soundFile = input.soundFile.trim().slice(0, 400)
      if (input.language === 'zh' || input.language === 'en' || input.language === 'auto') out.language = input.language
      return out
    }

    /** 读宿主配置。返回是否成功。 */
    async function loadConfig() {
      try {
        const res = await fetch(`${API}/config`, { headers: { accept: 'application/json' } })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        if (!json || json.ok !== true) throw new Error(String(json?.error ?? '宿主返回了非 ok 的负载'))
        cfg = adoptConfig(json.data?.config)
        cfgError = null
        try { window.dispatchEvent(new CustomEvent('laurel:configuration-saved', { detail: { id: 'laurel', persisted: true } })) } catch {}
        return { ok: true, data: json.data }
      } catch (error) {
        cfgError = String(error?.message ?? error)
        report({ kind: 'warn', detail: `读不到宿主配置，改用内置默认值：${cfgError}` })
        return { ok: false, error: cfgError }
      }
    }

    /** 写宿主配置（设置页用）。 */
    async function saveConfig(patch) {
      try {
        const res = await fetch(`${API}/config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ config: patch }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        if (!json || json.ok !== true) throw new Error(String(json?.error ?? '保存被拒绝'))
        cfg = adoptConfig(json.data?.config)
        cfgError = null
        return { ok: true, data: json.data }
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
    }

    /* ------------------------------------------------------------------ *
     * 弹通知
     * ------------------------------------------------------------------ */

    /**
     * 通知 tag —— **必须压缩**，不能直接塞 sessionId。
     *
     * ⚠ Windows 的 Toast Tag 有 **64 字符**硬上限，超了会抛
     *   「通知標籤的大小太大」，而 Chromium 是先拼成
     *   `n#<origin>#<tag>` 再交给系统 —— dsh 的 origin 是
     *   `dsh-app://app`，光前缀 `n#dsh-app://app#` 就吃掉 16 字符，
     *   留给这里的预算只剩 **48**。
     *
     *   旧写法 `laurel:${kind}:${sessionId}` 里 sessionId 是
     *   `session-` + 36 位 UUID = 43 字符，拼完整前缀 78 字符 —— 必然超限。
     *   Windows 会**整条丢弃**这条通知，且 `Notification.onerror` 不触发，
     *   页面侧完全无感，只在 events.log 留下一条 `fire`。
     *   这就是「测试通知（tag 短）能弹、回合结束通知从来不响」的根因。
     *
     *   这里在超预算时退化成 32 位 FNV-1a 的 base36 短标识（≤8 字符），
     *   保住「同一会话的通知互相替换」的语义，同时留足余量。
     *   ⚠ 节流用的 `throttle.bySession` 仍用完整 key，不要一起改。
     */
    const TAG_BUDGET = 40

    function tagKey(kind, key) {
      const full = `laurel:${kind}:${key}`
      if (full.length <= TAG_BUDGET) return full
      let hash = 2166136261
      for (let i = 0; i < full.length; i += 1) {
        hash ^= full.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
      }
      const short = `laurel:${kind}:h${(hash >>> 0).toString(36)}`
      // kind 本身异常长时再退一步（正常不会走到，纯粹防御「静默丢通知」这类故障）
      return short.length <= TAG_BUDGET ? short : `laurel:h${(hash >>> 0).toString(36)}`
    }

    /* ------------------------------------------------------------------ *
     * 页内卡片（窗口在前台时的通知）
     * ------------------------------------------------------------------ */

    /** 页内卡片的位置 → CSS 定位。纯函数，便于单测。 */
    function toastPlacement(corner) {
      const bottom = corner !== 'top-left' && corner !== 'top-right'
      const left = corner === 'bottom-left' || corner === 'top-left'
      return {
        position: 'fixed',
        [bottom ? 'bottom' : 'top']: 20,
        [left ? 'left' : 'right']: 20,
        zIndex: 2147483000,
        display: 'flex',
        flexDirection: bottom ? 'column' : 'column-reverse',
        gap: 10,
        maxWidth: 380,
        pointerEvents: 'none',
      }
    }

    /** `<style>` 只插一次（用 id 认领，HMR 重放也不会越插越多）。 */
    const TOAST_STYLE_ID = 'laurel-toast-style'
    const TOAST_CSS = [
      '.laurel-toast{pointer-events:auto;box-sizing:border-box;width:340px;max-width:calc(100vw - 40px);',
      `font-family:${CARD_FONT};background:rgba(32,34,38,0.97);color:#ecedef;`,
      'border:1px solid rgba(255,255,255,0.12);border-radius:14px;padding:12px 14px;',
      'box-shadow:0 12px 36px rgba(0,0,0,0.48);animation:laurel-toast-in .18s ease-out}',
      '.laurel-toast-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}',
      '.laurel-toast-mark{flex:0 0 auto;width:16px;height:16px;border-radius:5px;',
      'background:linear-gradient(135deg,#7cc4ff,#3f8ae0)}',
      '.laurel-toast-title{flex:1 1 auto;font-size:13px;font-weight:600;overflow:hidden;',
      'text-overflow:ellipsis;white-space:nowrap}',
      '.laurel-toast-x{flex:0 0 auto;width:22px;height:22px;border:0;border-radius:6px;background:transparent;',
      'color:#9aa0a6;font-size:15px;line-height:1;cursor:pointer;padding:0}',
      '.laurel-toast-x:hover{background:rgba(255,255,255,0.10);color:#fff}',
      '.laurel-toast-body{font-size:12.5px;line-height:1.55;color:#c6c9cd;word-break:break-word;',
      'display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}',
      '.laurel-toast-foot{margin-top:8px;font-size:11px;color:#7f858c}',
      '.laurel-toast--error{border-color:rgba(255,107,107,0.55)}',
      '@keyframes laurel-toast-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}',
    ].join('')

    function ensureToastStyle() {
      try {
        if (document.getElementById(TOAST_STYLE_ID)) return
        const style = document.createElement('style')
        style.id = TOAST_STYLE_ID
        style.textContent = TOAST_CSS
        document.head.appendChild(style)
      } catch { /* 插不进样式不该让通知挂掉 */ }
    }

    /**
     * 设置页的样式补丁。
     *
     * 面板里的控件都是内联样式（这样不怕宿主的 CSS 变），但内联样式写不了 `:hover`
     * 与 `:focus-visible` —— 于是鼠标扫过去、键盘 Tab 过来都是一点反馈都没有，
     * 而设置页恰恰是靠 Tab 走的地方。这里补上这两条，选择器全部挂在
     * `.laurel-settings` 下面，碰不到宿主的其它界面。
     */
    const SETTINGS_STYLE_ID = 'laurel-settings-style'
    const SETTINGS_CSS = [
      '.laurel-settings :focus-visible{outline:2px solid #7cc4ff;outline-offset:1px;border-radius:6px}',
      '.laurel-settings button:hover,.laurel-settings select:hover{border-color:rgba(124,196,255,0.55)!important}',
      '.laurel-settings button[aria-pressed="true"]:hover{border-color:#7cc4ff!important}',
    ].join('')

    function ensureSettingsStyle() {
      try {
        if (document.getElementById(SETTINGS_STYLE_ID)) return
        const style = document.createElement('style')
        style.id = SETTINGS_STYLE_ID
        style.textContent = SETTINGS_CSS
        document.head.appendChild(style)
      } catch { /* 插不进样式不该让设置页挂掉 */ }
    }

    function toastHost() {
      try {
        if (!document || !document.body) return null
        ensureToastStyle()
        let host = document.getElementById('laurel-toast-host')
        if (!host) {
          host = document.createElement('div')
          host.id = 'laurel-toast-host'
          host.setAttribute('role', 'status')
          host.setAttribute('aria-live', 'polite')
          const placement = toastPlacement(cfg.toastCorner)
          for (const key of Object.keys(placement)) host.style[key] = placement[key]
          document.body.appendChild(host)
        } else {
          // 位置可能在设置页里被改过：每次弹都重新对齐一次。
          const placement = toastPlacement(cfg.toastCorner)
          for (const key of Object.keys(placement)) host.style[key] = placement[key]
        }
        return host
      } catch { return null }
    }

    const MAX_TOASTS = 3
    let toastSeq = 0

    /**
     * 弹一张页内卡片。
     *
     * 刻意只用 DOM，不用 React：bundle 里 `require` 只能拿平台播种表里的模块，
     * 表格外的名字会**直接抛错**。纯 DOM 不引入任何新依赖，也就没有这份风险。
     *
     * @returns {boolean} 是否真的挂上去了
     */
    function showToast(input) {
      const info = {
        kind: input.kind,
        sessionId: input.sessionId ?? null,
        title: input.title,
        body: input.body,
        focused: hasFocus(),
        visibility: visibilityOf(),
        supported: supported(),
        permission: permissionOf(),
      }
      const host = toastHost()
      if (!host) {
        report({ ...info, kind: 'error', detail: '页内卡片挂不上去：拿不到 document.body' })
        return false
      }

      const strings = t()
      let card
      try {
        card = document.createElement('div')
        card.className = input.kind === 'error' ? 'laurel-toast laurel-toast--error' : 'laurel-toast'
        card.dataset.laurelKind = String(input.kind)

        const head = document.createElement('div')
        head.className = 'laurel-toast-head'
        const mark = document.createElement('span')
        mark.className = 'laurel-toast-mark'
        const title = document.createElement('div')
        title.className = 'laurel-toast-title'
        title.textContent = input.title
        const close = document.createElement('button')
        close.type = 'button'
        close.className = 'laurel-toast-x'
        close.setAttribute('aria-label', strings.toastClose)
        close.title = strings.toastClose
        close.textContent = '✕'
        head.appendChild(mark)
        head.appendChild(title)
        head.appendChild(close)

        const body = document.createElement('div')
        body.className = 'laurel-toast-body'
        body.textContent = input.body

        const foot = document.createElement('div')
        foot.className = 'laurel-toast-foot'
        const label = strings.toastTitleKind[input.kind] ?? ''
        foot.textContent = label ? `${label} · DSH` : 'DSH'

        card.appendChild(head)
        card.appendChild(body)
        card.appendChild(foot)
      } catch (error) {
        report({ ...info, kind: 'error', detail: `页内卡片建不出来：${error?.message ?? error}` })
        return false
      }

      const id = (toastSeq += 1)
      let timer = null
      const dismiss = (reason) => {
        try { if (timer !== null) clearTimeout(timer) } catch { /* 忽略 */ }
        timer = null
        try { if (card.parentNode) card.parentNode.removeChild(card) } catch { /* 忽略 */ }
        report({ ...info, kind: 'dismiss', detail: reason, toastId: id })
      }

      card.querySelector('.laurel-toast-x')?.addEventListener('click', (event) => {
        try { event.stopPropagation() } catch { /* 忽略 */ }
        dismiss('手动关闭')
      })
      card.addEventListener('click', () => {
        try { window.focus() } catch { /* 拿不回焦点也没关系 */ }
        report({ ...info, kind: 'click', detail: '点了页内卡片' })
      })

      const ms = Number(cfg.toastMs)
      if (Number.isFinite(ms) && ms > 0) {
        const arm = () => {
          try { timer = setTimeout(() => dismiss('自动消失'), ms) } catch { timer = null }
        }
        arm()
        // 鼠标停在卡片上时先别消失（要读正文 / 点关闭）
        card.addEventListener('mouseenter', () => {
          try { if (timer !== null) clearTimeout(timer) } catch { /* 忽略 */ }
          timer = null
        })
        card.addEventListener('mouseleave', arm)
      }

      try { host.appendChild(card) } catch (error) {
        report({ ...info, kind: 'error', detail: `页内卡片插不进 DOM：${error?.message ?? error}` })
        return false
      }
      // 最多留几张，旧的先走（多了会盖住整个右下角）
      try {
        while (host.childNodes.length > MAX_TOASTS && host.firstChild) host.removeChild(host.firstChild)
      } catch { /* 忽略 */ }

      report({ ...info, kind: 'toast', detail: `${input.force ? '测试卡片' : '页内卡片已显示'} · 停留 ${ms > 0 ? `${Math.round(ms / 1000)}s` : '不自动关'}` })
      return true
    }

    /**
     * 这类事件要不要弹页内卡片？逐类可选，设置页里能勾。
     * 未知种类默认给 `true`：以后新加的类别应该先能看见，
     * 而不是因为忘了一个映射就静默消失。
     */
    const CARD_TOGGLE = {
      question: 'toastOnQuestion',
      approval: 'toastOnApproval',
      planReview: 'toastOnPlanReview',
      completion: 'toastOnCompletion',
    }

    /**
     * 设置页里那张「哪些事件要提醒我」的表。
     * 一行 = 一类事件，两列 = 两条通路（系统通知 / 页内卡片）。
     * 两列各自有独立的配置键，所以"只发系统通知、不弹卡片"这种组合能表达出来。
     *
     * ⚠️ 2026-09-30 起**不再有「共用开关」的行**：提问与计划确认各有一个 `notifyOn*` 键。
     * 旧版让这两行共用一个开关，界面上只能画一个「跨两行」的格子 —— 那个格子视觉上
     * 落在第二行，「需要你回答」的系统通知格看着就是空的，被当成错位 / 漏配。
     * 现在每行都画全两个格子，既不会错位，两类也真的能分别设了。
     */
    const EVENT_KINDS = [
      { labelKey: 'notifyOnQuestion', hintKey: 'notifyOnQuestionHint', systemKey: 'notifyOnQuestion', cardKey: 'toastOnQuestion' },
      { labelKey: 'notifyOnPlanReview', hintKey: 'notifyOnPlanReviewHint', systemKey: 'notifyOnPlanReview', cardKey: 'toastOnPlanReview' },
      { labelKey: 'notifyOnApproval', hintKey: 'notifyOnApprovalHint', systemKey: 'notifyOnApproval', cardKey: 'toastOnApproval' },
      { labelKey: 'notifyOnCompletion', hintKey: 'notifyOnCompletionHint', systemKey: 'notifyOnCompletion', cardKey: 'toastOnCompletion' },
    ]

    function allowCard(kind) {
      const key = CARD_TOGGLE[kind]
      if (!key) return true
      return cfg[key] !== false
    }

    /**
     * 通知时机 —— 用户可选的三档。这是设置页里那个三选一按钮组。
     *
     * 为什么要有这一层：底下的 `onlyWhenUnfocused` 与 `toast` 两个布尔字段
     * 一共 8 种组合，但实际只产生 3 种行为（`toast` 只在
     * `onlyWhenUnfocused: true` 时才有意义）—— 两个开关管一件事，
     * 界面上一旦分开摆，用户没法判断自己到底选中了什么。
     * 所以界面只暴露这三档，那两个字段退化成它的内部表示：
     *
     *   background —— 只走系统通知（窗口没在前台时）
     *   foreground —— 只走页内卡片（窗口在前台时）
     *   both       —— 两条都走：没在前台发系统通知，在前台弹卡片
     */
    const TIMING_MODES = [
      { field: 'timing', labelKey: 'timingBackground', hintKey: 'timingBackgroundHint', system: true, card: false, onlyWhenUnfocused: true, toast: false },
      { field: 'timing', labelKey: 'timingForeground', hintKey: 'timingForegroundHint', system: false, card: true, onlyWhenUnfocused: false, toast: true },
      { field: 'timing', labelKey: 'timingBoth', hintKey: 'timingBothHint', system: true, card: true, onlyWhenUnfocused: true, toast: true },
    ]

    function timingMode() {
      if (cfg.onlyWhenUnfocused === false) return 'foreground'
      return cfg.toast === false ? 'background' : 'both'
    }

    /** 这一档要不要走某条通路：只后台 = 只系统通知，只前台 = 只卡片，两种都发 = 两条都走。 */
    function timingWants(path, mode = timingMode()) {
      if (path === 'card') return mode === 'foreground' || mode === 'both'
      return mode === 'background' || mode === 'both'
    }

    /** 这一档在窗口前台时走的是哪条路（状态区那一行字要用）。 */
    function timingLabel(mode = timingMode()) {
      const hit = TIMING_MODES.find((entry) => modeOf(entry) === mode)
      return hit ? t()[hit.labelKey] : mode
    }

    function modeOf(entry) {
      if (entry.onlyWhenUnfocused === false) return 'foreground'
      return entry.toast === false ? 'background' : 'both'
    }

    /**
     * 系统通知这条路这次能不能真的走通？
     * 环境里有 Notification API；这一档愿意走系统通知；而且窗口不在前台
     *（"两种都发"与"只后台"这两档都不打扰正看着窗口的人 —— 前台那一档走卡片）。
     *
     * `ignoreFocus` 给设置页里的「测试通知」按钮用：那是用户自己按的，
     * 要能随时验证通知中心那一路，不受"窗口有焦点就不打扰"影响。
     */
    function systemUsable(mode = timingMode(), ignoreFocus = false) {
      if (!supported()) return false
      if (ignoreFocus) return true
      if (!timingWants('system', mode)) return false
      return !hasFocus()
    }

    /** 这一类事件要不要发系统通知？矩阵里"系统通知"那一列。 */
    function allowSystem(kind) {
      if (kind === 'completion') return cfg.notifyOnCompletion !== false
      if (kind === 'approval') return cfg.notifyOnApproval !== false
      if (kind === 'question') return cfg.notifyOnQuestion !== false
      if (kind === 'planReview') return cfg.notifyOnPlanReview !== false
      return true
    }

    /**
     * @param {{ kind: string, sessionId?: string, title: string, body: string, force?: boolean, mode?: 'card' | 'system' }} input
     * @returns {boolean} 是否真的弹了
     */
    function fire(input) {
      const info = {
        kind: input.kind,
        sessionId: input.sessionId ?? null,
        title: input.title,
        body: input.body,
        focused: hasFocus(),
        visibility: visibilityOf(),
        supported: supported(),
        permission: permissionOf(),
      }

      // `mode` 让设置页能明确点名走哪条路（两个手动测试按钮就是这么分工的）：
      //   'card'   —— 只弹页内卡片
      //   'system' —— 只发系统通知，不看窗口有没有焦点
      //   其它      —— 自动：按「通知时机」那一档路由
      const forcedCard = input.mode === 'card'
      const forcedSystem = input.mode === 'system'
      const timing = timingMode()
      const focused = hasFocus()

      // 点名要系统通知，可这个环境没有 Notification API：说清原因，别静默失败。
      if (forcedSystem && !supported()) {
        report({ ...info, kind: 'error', detail: '这个环境没有 Notification API：系统通知这条通路不存在（「测试通知」按钮因此发不出去）' })
        return false
      }
      // 通知能力：系统通知 或 页内卡片，有一个能用就行。
      if (!supported() && !cfg.toast) {
        report({ ...info, kind: 'error', detail: '这个环境既没有 Notification API，页内卡片也被关掉了：不会弹任何东西' })
        return false
      }
      // 被点名要卡片，但卡片总开关关着：说清原因，别静默什么都不做。
      if (forcedCard && !cfg.toast) {
        report({ ...info, kind: 'error', detail: '页内卡片已在设置里关掉：先去打开「通知时机」里带卡片的那一档' })
        return false
      }

      // 这一次该走哪条路：先看「通知时机」这一档走不走这条通路，
      // 再看矩阵里这一类事件的这一列有没有勾上。
      // 手动点名时只看自己那条通路的总开关 —— 用户按了按钮就得给他看，
      // 否则"验证"这件事本身就没法做了。
      const cardOn = !forcedSystem && (forcedCard || (timingWants('card', timing) && cfg.toast && allowCard(input.kind)))
      const systemOn = !forcedCard && systemUsable(timing, forcedSystem) && allowSystem(input.kind)

      // 卡片优先：既在前台、又允许卡片时，系统通知要压掉，否则同一件事弹两遍。
      // 另外，这个环境**没有 Notification API** 时也退到卡片：那时卡片是唯一
      // 还能让用户看到的通路（"两种都发"这一档尤其不能因此一条都不弹）。
      // 注意只在这个前提下退 —— 用户自己关掉某类事件的系统通知时不该偷偷弹卡片。
      const noSystemApi = !supported() && timingWants('card', timing) && cfg.toast
      if (cardOn && (forcedCard || focused || noSystemApi)) {
        if (showToast(input)) return true
        report({ ...info, kind: 'warn', detail: '页内卡片没能显示（系统通知这条通路这次也没走）' })
        return false
      }
      if (!systemOn) {
        // 分清"设置里关掉了"和"这次没轮到它"：前者用户该去改设置，后者只是时机不对。
        const closedBySettings = !timingWants('system', timing) || !allowSystem(input.kind)
        report({
          ...info,
          kind: 'warn',
          detail: closedBySettings
            ? `按设置不发通知：「${input.kind}」这一类在「通知时机」或事件表里没有打开任何一条通路`
            : `按设置不发通知：「${input.kind}」这一类这次没轮到系统通知 —— 「通知时机」这一档在窗口有焦点时不打扰（或这个环境没有 Notification API）`,
        })
        return false
      }
      const at = now()
      const key = input.sessionId ?? 'global'
      const lastSession = throttle.bySession.get(key) ?? 0
      if (!input.force && cfg.throttleSeconds > 0) {
        if (at - throttle.globalAt < 2000) {
          report({ ...info, kind: 'warn', detail: '全局节流（2 秒内已经响过）' })
          return false
        }
        if (at - lastSession < cfg.throttleSeconds * 1000) {
          const left = Math.ceil((cfg.throttleSeconds * 1000 - (at - lastSession)) / 1000)
          report({ ...info, kind: 'warn', detail: `同一会话节流中，还需 ${left} 秒` })
          return false
        }
      }

      // 自定义提示音：先放它，再把系统通知音静音（否则两声会叠在一起）。
      const customSound = playSound(info)
      const silent = cfg.sound === false || customSound !== ''

      try {
        const notification = new Notification(input.title, {
          body: input.body,
          silent,
          tag: tagKey(input.kind, key),
          requireInteraction: cfg.sticky && input.kind !== 'completion',
        })
        notification.onclick = () => {
          try { window.focus() } catch { /* 拿不回焦点也没关系 */ }
          report({ ...info, kind: 'click', detail: '点了通知' })
        }
        notification.onshow = () => report({ ...info, kind: 'shown' })
        notification.onerror = (event) => report({ ...info, kind: 'error', detail: `弹出失败：${event?.error?.message ?? event?.error ?? 'unknown'}` })
        throttle.globalAt = at
        throttle.bySession.set(key, at)
        report({
          ...info,
          kind: 'fire',
          detail: `${input.force ? '测试通知' : '已弹出'} · ${customSound ? `自定义提示音 ${cfg.soundFile}` : (cfg.sound === false ? '静音' : '系统提示音')}`,
        })
        return true
      } catch (error) {
        report({ ...info, kind: 'error', detail: `创建通知失败：${error?.message ?? error}` })
        return false
      }
    }

    /**
     * 自定义提示音 → 可直接交给 Audio 的 URL。
     *   - 空串        → 返回空串（意思是"用系统通知音"）
     *   - http(s)     → 原样交给浏览器（受页面 CSP 限制，离线不可用）
     *   - 带路径分隔符 → 走宿主端点，由宿主按配置里的路径读文件
     *   - 纯文件名     → 走宿主端点 + file 参数，只许读提示音目录里的那一个
     */
    function soundUrlFor(file) {
      const value = String(file ?? '').trim()
      if (!value) return ''
      if (/^https?:\/\//i.test(value)) return value
      if (value.includes('/') || value.includes('\\')) return `${API}/sound`
      return `${API}/sound?file=${encodeURIComponent(value)}`
    }

    /**
     * 播自定义提示音。
     * @returns {string} 播了的 URL；空串 = 没播（该让系统通知音出声）
     */
    function playSound(info, options = {}) {
      const url = (cfg.sound === false && options.force !== true) ? '' : soundUrlFor(cfg.soundFile)
      if (!url) return ''
      if (typeof Audio !== 'function') {
        report({ ...info, kind: 'error', detail: '这个环境没有 Audio API：自定义提示音播不了，退回系统通知音' })
        return ''
      }
      try {
        const audio = new Audio(url)
        try { audio.volume = 1 } catch { /* 有些实现是只读的 */ }
        const played = audio.play?.()
        if (played && typeof played.then === 'function') {
          played
            .then(() => report({ ...info, kind: 'sound', detail: `自定义提示音已播放：${url}` }))
            .catch((error) => report({ ...info, kind: 'error', detail: `提示音播放失败：${error?.message ?? error}（${url}）` }))
        } else {
          report({ ...info, kind: 'sound', detail: `自定义提示音已触发：${url}` })
        }
      } catch (error) {
        report({ ...info, kind: 'error', detail: `提示音创建失败：${error?.message ?? error}（${url}）` })
      }
      return url
    }

    function clip(text, max) {
      const value = String(text ?? '').replace(/\s+/g, ' ').trim()
      return value.length > max ? `${value.slice(0, Math.max(1, max - 1))}…` : value
    }

    function firstLine(text) {
      const value = String(text ?? '').split('\n').find((line) => line.trim().length > 0) ?? ''
      return value.replace(/\s+/g, ' ').trim()
    }

    /** 会话标题：拿不到就空串（调用方会退回 'DSH'）。 */
    function sessionTitle(ctx, sessionId) {
      try {
        const sessions = ctx?.get?.('sessions') ?? null
        const row = sessions?.list?.getSnapshot?.()?.byId?.[sessionId]
        const title = row?.displayTitle ?? row?.title ?? row?.name ?? row?.summary
        return typeof title === 'string' ? title.trim() : ''
      } catch { return '' }
    }

    function titleFor(ctx, sessionId) {
      const session = sessionTitle(ctx, sessionId)
      if (cfg.title) return session ? `${cfg.title} · ${session}` : cfg.title
      return session || 'DSH'
    }

    /* ------------------------------------------------------------------ *
     * 挂到会话状态上
     * ------------------------------------------------------------------ */

    function interactionKind(pending) {
      const kind = pending?.kind
      if (kind === 'approval') return 'approval'
      if (kind === 'plan-review') return 'planReview'
      return 'question'
    }

    function bodyFor(kind, pending) {
      const strings = t()
      if (kind === 'approval') {
        const tool = pending?.toolName ?? '?'
        const reason = firstLine(pending?.displayReason ?? pending?.reason ?? '')
        return clip(`${strings.approvalBody(tool)}${reason ? `：${reason}` : ''}`, cfg.maxBodyChars)
      }
      const question = pending?.questions?.[0]
      const text = firstLine(q_text(question))
      if (kind === 'planReview') return clip(`${strings.planReview}：${text}`, cfg.maxBodyChars)
      return clip(`${strings.question}：${text || '（没有正文）'}`, cfg.maxBodyChars)
    }

    function q_text(question) {
      return question?.question ?? question?.detail ?? ''
    }

    function onPending(ctx, sessionId, pending) {
      const kind = interactionKind(pending)
      if (!allowSystem(kind) && !(timingWants('card') && allowCard(kind))) {
        report({ kind: 'warn', sessionId, detail: `${kind} 这一类已关掉（事件表里两条通路都没有打开），跳过` })
        return
      }
      fire({ kind, sessionId, title: titleFor(ctx, sessionId), body: bodyFor(kind, pending) })
    }

    /**
     * 回合结束。这里不预先看 `notifyOnCompletion`：那张事件表有两列，
     * 只要"页内卡片"那一列勾上了就该弹 —— 该走哪条路由 `fire()` 决定。
     */
    function onCompletion(ctx, sessionId) {
      if (!allowSystem('completion') && !(timingWants('card') && allowCard('completion'))) {
        report({ kind: 'warn', sessionId, detail: 'completion 这一类已关掉（事件表里两条通路都没有打开），跳过' })
        return
      }
      fire({ kind: 'completion', sessionId, title: titleFor(ctx, sessionId), body: t().completion })
    }

    /**
     * 订阅每个会话的状态快照。
     *
     * 只认两种"新发生的事"：
     *   1. `pendingInteraction` 从不空变成非空（或换了一个对象）；
     *   2. `running` 由 true 变 false。
     * **第一帧只当基线，不弹**：刚加载页面时可能挂着一条旧问题，那不是"刚刚发生"。
     */
    function watchStatus(ctx) {
      const uiSession = (() => {
        try { return ctx?.get?.('uiSession') ?? ctx?.uiSession ?? null } catch { return null }
      })()
      const source = uiSession?.sessionStatus
      if (!source || typeof source.subscribe !== 'function' || typeof source.getSnapshot !== 'function') {
        report({ kind: 'error', detail: '拿不到 uiSession.sessionStatus：通知不会触发（这份 DSH 版本可能不一样）' })
        return false
      }

      let previous = source.getSnapshot() ?? new Map()
      const diff = () => {
        let next
        try { next = source.getSnapshot() ?? new Map() } catch (error) {
          report({ kind: 'error', detail: `读状态失败：${error?.message ?? error}` })
          return
        }
        for (const [sessionId, status] of next) {
          const before = previous.get(sessionId)
          const pending = status?.pendingInteraction ?? null
          const beforePending = before?.pendingInteraction ?? null
          if (pending && pending !== beforePending) onPending(ctx, sessionId, pending)
          else if (before?.running === true && status?.running === false) onCompletion(ctx, sessionId)
        }
        previous = next
      }

      try {
        ctx.effect(() => source.subscribe(diff), 'laurel.session-status')
        watching = true
      } catch (error) {
        report({ kind: 'error', detail: `订阅失败：${error?.message ?? error}` })
        return false
      }
      report({ kind: 'watch', detail: '已挂到 uiSession.sessionStatus' })
      return true
    }

    /* ------------------------------------------------------------------ *
     * 设置页
     * ------------------------------------------------------------------ */

    function Toggle({ label, hint, value, onChange, field }) {
      return h('div', { 'data-setting-key': field,
        style: { display: 'flex', gap: 12, alignItems: 'flex-start', padding: '8px 0', borderTop: `1px solid ${T.border}` },
      },
        h('button', {
          type: 'button',
          onClick: () => onChange(!value),
          'aria-pressed': value === true,
          style: {
            marginTop: 2, flex: '0 0 auto', width: 40, height: 22, borderRadius: 11, cursor: 'pointer',
            border: `1px solid ${value ? T.accent : T.border}`,
            background: value ? 'rgba(124,196,255,0.22)' : 'transparent', position: 'relative', padding: 0,
          },
        }, h('span', {
          style: {
            position: 'absolute', top: 2, left: value ? 20 : 2, width: 16, height: 16, borderRadius: '50%',
            background: value ? T.accent : T.faint, transition: 'left .12s',
          },
        })),
        h('div', { style: { flex: '1 1 auto' } },
          h('div', { style: { fontSize: 13, color: T.text } }, label),
          hint ? h('div', { style: { fontSize: 11.5, color: T.faint, marginTop: 2, lineHeight: 1.5 } }, hint) : null,
        ),
      )
    }

    function Row({ label, value }) {
      return h('div', { style: { display: 'flex', gap: 8, fontSize: 12, padding: '3px 0' } },
        h('span', { style: { color: T.faint, minWidth: 96 } }, label),
        h('span', { style: { color: T.dim, wordBreak: 'break-all' } }, value),
      )
    }

    function NotifySettings() {
      const [state, setState] = React.useState({ cfg: { ...cfg }, error: cfgError, info: null, sounds: null, busy: false, notice: null, tick: 0 })
      /**
       * 折叠区的展开状态，**默认全收起**。
       *
       * 设置页原来一屏塞了「通知时机 + 事件表 + 系统通知 + 页内卡片 + 其他」五个区块，
       * 外加一整块「运行状态」，要滚两屏才到底。真正常用的只有前两块 ——
       * 自定义提示音、节流秒数、标题前缀、运行状态都是改一次就再也不碰的，
       * 收进折叠区能把版面砍掉一半。
       */
      const [open, setOpen] = React.useState({})
      const [settingsTab, setSettingsTab] = React.useState('rules')
      React.useEffect(() => { const locate = event => { if(event.detail?.id !== 'laurel')return;setSettingsTab(event.detail.tab || 'rules');const fold=event.detail.key==='soundFile'?'sound':['throttleSeconds','title'].includes(event.detail.key)?'other':'';if(fold)setOpen(prev=>prev[fold]?prev:{...prev,[fold]:true}) };window.addEventListener('laurel:locate-setting',locate);return()=>window.removeEventListener('laurel:locate-setting',locate) }, [])
      ensureSettingsStyle()
      const strings = t()

      const refresh = async () => {
        setState((s) => ({ ...s, busy: true, notice: null }))
        const result = await loadConfig()
        let info = null
        let sounds = null
        try {
          const res = await fetch(`${API}/config`, { headers: { accept: 'application/json' } })
          const json = await res.json()
          info = json?.data ?? null
        } catch { /* 设置页不该因为读不到诊断信息而报错 */ }
        try {
          const res = await fetch(`${API}/sounds`, { headers: { accept: 'application/json' } })
          const json = await res.json()
          sounds = json?.data ?? null
        } catch { /* 同上 */ }
        setState((s) => ({
          ...s,
          busy: false,
          cfg: { ...cfg },
          error: result.ok ? null : result.error,
          info,
          sounds,
          notice: null,
          tick: s.tick + 1,
        }))
      }

      React.useEffect(() => { refresh() }, [])

      /**
       * 存一项或一批配置。`patch('sound', true)` 与 `patch({ a: 1, b: 2 })` 都行 ——
       * 「通知时机」是三选一，一次要改两个键，不能分两次发（中间态会短暂生效）。
       */
      const patch = async (keyOrPatch, maybeValue) => {
        const changes = typeof keyOrPatch === 'object' && keyOrPatch !== null ? keyOrPatch : { [keyOrPatch]: maybeValue }
        const next = { ...state.cfg, ...changes }
        setState((s) => ({ ...s, cfg: next, busy: true, notice: strings.saving }))
        const result = await saveConfig(changes)
        setState((s) => ({
          ...s,
          busy: false,
          cfg: { ...cfg },
          error: result.ok ? null : result.error,
          notice: result.ok ? strings.saved : `${strings.saveFailed}${result.error}`,
        }))
      }

      const heading = h('div', { className: 'lc-embedded-heading', style: { fontSize: 14, color: T.text, marginBottom: 4 } }, strings.heading)
      const intro = h('div', { className: 'lc-embedded-description', style: { fontSize: 12, color: T.faint, lineHeight: 1.6, marginBottom: 10 } }, strings.intro)

      const banner = !supported()
        ? h('div', { style: { fontSize: 12, color: T.warn, marginBottom: 8 } }, strings.unsupported)
        : (state.error ? h('div', { style: { fontSize: 12, color: T.danger, marginBottom: 8 } }, state.error) : null)

      /* ── 三个动作：两个测试按钮各验一条通路，一个刷新 ────────────────── */
      const test = async () => {
        // 浏览器里（不是桌面壳）通知权限默认是 default，必须由一次用户手势里申请。
        // 这个按钮就是那次手势 —— 不申请的话 `new Notification()` 只会静默失败。
        try {
          if (supported() && Notification.permission === 'default' && typeof Notification.requestPermission === 'function') {
            const granted = await Notification.requestPermission()
            setState((s) => ({ ...s, notice: String(granted ?? '') }))
          }
        } catch { /* 用户拒绝也照样试一次，好让事件日志里留下失败原因 */ }
        // 点名走系统通知这条路：`mode: 'system'` 跳过"窗口有焦点就不打扰"，
        // 也跳过「通知时机」和事件表 —— 它和「试页内卡片」是两个通路的验证按钮，
        // 各钉在自己那条路上，不然按了「测试通知」却弹出一张卡片，就没法验证通知中心那一侧。
        const ok = fire({ kind: 'test', sessionId: 'test', title: strings.testTitle, body: strings.testBody, force: true, mode: 'system' })
        setState((s) => ({ ...s, notice: ok ? strings.testShown : strings.testFailed }))
      }

      const testCard = () => {
        // 点名只走页内卡片。窗口在前台时它就在眼前，
        // 不用去通知中心找、也不用把窗口最小化。
        const ok = fire({ kind: 'test', sessionId: 'test-card', title: strings.testTitle, body: strings.testBody, mode: 'card' })
        setState((s) => ({ ...s, notice: ok ? strings.testCardShown : strings.testCardFailed }))
      }

      const preview = async () => {
        setState((s) => ({ ...s, busy: true, notice: strings.previewing }))
        // 先存再听：宿主是按配置里的路径去读文件的，这样试听的就是"真正会响的那个"。
        const result = await saveConfig({ soundFile: state.cfg.soundFile })
        setState((s) => ({
          ...s,
          busy: false,
          cfg: { ...cfg },
          error: result.ok ? null : result.error,
          notice: result.ok ? null : `${strings.saveFailed}${result.error}`,
        }))
        playSound({ kind: 'test', sessionId: 'preview' }, { force: true })
      }

      /* ── 版面骨架 ──────────────────────────────────────────────────────
       * 每个区块都是「标题（+ 一句说明）+ 内容」，间距和描边统一。
       * 上一版的毛病是控件散在区块外面（节流秒数、标题前缀直接摆在两个区块之间），
       * 用户看不出哪几个控件属于同一件事；同一件事的控件还被拆到了两块里
       * （提示音总开关在一块、自定义提示音在另一块）。
       */
      const BLOCK_STYLE = { marginTop: 10, padding: '10px 12px', borderRadius: 8, background: T.bg2, border: `1px solid ${T.border}` }
      // `data-laurel-block` 是给测试和排错用的把手：界面上一堆 div 长得一样，
      // 想断言"这几个控件在同一块里"只能靠一个稳定的锚点。
      //
      // 传了 `foldId` 就是折叠块（默认收起，点标题展开）。
      // ⚠ 收起时正文走 `display: none` 而**不是条件渲染** —— 版面测试靠遍历 tree
      //   断言"控件在正确的块里"，条件渲染会把子树整个摘掉，那些断言会凭空失败。
      const block = (title, children, foldId) => {
        const isOpen = foldId === undefined || open[foldId] === true
        const head = foldId === undefined
          ? h('div', { style: { fontSize: 12.5, color: T.text } }, title)
          : h('button', {
            type: 'button',
            'aria-expanded': isOpen,
            // `aria-label` 让读屏软件和版面测试都能点名这个标题
            //（测试里的 findButton 只认纯文本 children 或 aria-label，而这里的
            // children 是 [箭头, 标题] 两段，光靠 children 匹配不到）。
            'aria-label': title,
            onClick: () => setOpen((s) => ({ ...s, [foldId]: !isOpen })),
            style: {
              display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
              padding: 0, border: 0, background: 'transparent', cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 12.5, color: T.text,
            },
          },
            h('span', { style: { flex: '0 0 auto', color: T.faint, fontSize: 10 } }, isOpen ? '▾' : '▸'),
            h('span', null, title),
          )
        return h('div', { 'data-laurel-block': title, 'data-lc-notification-block': '', style: BLOCK_STYLE },
          head,
          h('div', { style: { display: isOpen ? 'block' : 'none' } }, ...children),
        )
      }
      const blockHint = (text) => h('div', { style: { fontSize: 11.5, color: T.faint, lineHeight: 1.55, marginTop: 4 } }, text)

      /**
       * 折叠区：一行可点的标题 + 收起的正文，用在「低频、但不想删掉」的项上
       *（自定义提示音、节流、标题前缀）。正文同样用 `display` 隐藏，理由见 `block()`。
       */
      const fold = (id, title, hint, children) => {
        const isOpen = open[id] === true
        return h('div', { style: { marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.border}` } },
          h('button', {
            type: 'button',
            'aria-expanded': isOpen,
            'aria-label': title,
            onClick: () => setOpen((s) => ({ ...s, [id]: !isOpen })),
            style: {
              display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
              padding: 0, border: 0, background: 'transparent', cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 12, color: T.dim,
            },
          },
            h('span', { style: { flex: '0 0 auto', color: T.faint, fontSize: 10 } }, isOpen ? '▾' : '▸'),
            h('span', { style: { flex: '0 0 auto' } }, title),
            hint ? h('span', { style: { flex: '1 1 auto', color: T.faint, fontSize: 11.5, textAlign: 'right' } }, hint) : null,
          ),
          h('div', { style: { display: isOpen ? 'block' : 'none' } }, ...children),
        )
      }
      const FIELD_STYLE = { padding: '3px 6px', borderRadius: 6, border: `1px solid ${T.border}`, background: 'transparent', color: T.text, fontFamily: 'inherit', fontSize: 12 }
      const field = (label, control, style) => h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: T.dim, ...style } }, label, control)
      const smallButton = (label, onClick, title) => h('button', {
        type: 'button',
        onClick,
        title: title ?? label,
        style: { padding: '4px 10px', borderRadius: 6, border: `1px solid ${T.border}`, background: 'transparent', color: T.dim, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' },
      }, label)
      const primaryButton = (label, onClick, title) => h('button', {
        type: 'button',
        onClick,
        title: title ?? label,
        style: { padding: '4px 10px', borderRadius: 6, border: `1px solid ${T.accent}`, background: 'rgba(124,196,255,0.14)', color: T.text, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' },
      }, label)

      /**
       * 数字输入：改动先落在本地 state，失焦时才写回宿主 ——
       * 边打字边写会把中间态也写进 settings.json（清空输入框的那一瞬间就是 0）。
       */
      const numberField = (label, key, toHost, fromHost, limits = {}) => field(label,
        h('input', {
          type: 'number',
          min: limits.min,
          max: limits.max,
          'data-setting-key': key, value: fromHost(state.cfg[key]),
          onChange: (event) => setState((s) => ({ ...s, cfg: { ...s.cfg, [key]: toHost(Number(event.target.value)) } })),
          onBlur: () => patch(key, state.cfg[key]),
          style: { ...FIELD_STYLE, width: 74 },
        }), { flex: '1 1 200px', justifyContent: 'flex-end' })

      const textField = (label, key, maxLength) => field(label,
        h('input', {
          type: 'text',
          'data-setting-key': key, value: state.cfg[key] ?? '',
          maxLength,
          onChange: (event) => setState((s) => ({ ...s, cfg: { ...s.cfg, [key]: event.target.value } })),
          onBlur: () => patch(key, state.cfg[key]),
          style: { ...FIELD_STYLE, flex: '1 1 120px' },
        }), { flex: '1 1 260px' })

      /* 1) 通知时机：三选一。底下的两个布尔字段是它的内部表示，界面上不再分开摆。
       *    上一版是三个各带一段说明的大按钮，光这一块就占掉半屏；现在压成一行胶囊，
       *    说明只显示**选中那一档**的 —— 信息量一样，高度只有三分之一。 */
      const timing = timingMode()
      const pickTiming = (entry) => patch({ onlyWhenUnfocused: entry.onlyWhenUnfocused, toast: entry.toast })

      const timingChip = (entry) => {
        const on = timing === modeOf(entry)
        return h('button', {
          key: modeOf(entry),
          type: 'button',
          'aria-pressed': on,
          title: strings[entry.hintKey],
          onClick: () => pickTiming(entry),
          style: {
            flex: '1 1 0', minWidth: 0, padding: '6px 8px', borderRadius: 999, cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 12.5, textAlign: 'center', whiteSpace: 'nowrap',
            border: `1px solid ${on ? T.accent : T.border}`,
            background: on ? 'rgba(124,196,255,0.14)' : 'transparent',
            color: on ? T.text : T.dim,
          },
        }, strings[entry.labelKey])
      }

      const activeTiming = TIMING_MODES.find((entry) => modeOf(entry) === timing)
      const timingBlock = h('div', { 'data-setting-key': 'timing' }, block(strings.timing, [
        h('div', { style: { display: 'flex', gap: 6, marginTop: 8 } },
          ...TIMING_MODES.map((entry) => timingChip(entry)),
        ),
        blockHint(activeTiming ? strings[activeTiming.hintKey] : ''),
      ]))

      /* 0) 当前效果：把其余四块的配置折算成**一句人话**，钉在最顶上。
       *    上一版用户得自己在「通知时机」（三选一）× 「事件表」（4 行 × 2 列）
       *    × 两条通路的细节之间做乘法，才能推出"到底什么时候会弹"。
       *    设置页最该回答的就是这个问题，所以直接给结论。
       */
      const effectSummary = (() => {
        const reminded = EVENT_KINDS
          .filter((row) => state.cfg[row.systemKey] === true || state.cfg[row.cardKey] !== false)
          .map((row) => strings.kindShort?.[row.labelKey] ?? strings[row.labelKey])
        const timingText = strings.effectSummary?.[timing] ?? ''
        return {
          off: reminded.length === 0,
          text: reminded.length === 0
            ? strings.effectOff
            : `${timingText} ${strings.effectPrefix}${reminded.join(' / ')}`,
        }
      })()

      const effectBlock = h('div', {
        'data-laurel-block': strings.effectHeading, className: 'lc-notify-effect',
        style: {
          marginTop: 10, padding: '10px 12px', borderRadius: 8,
          background: 'rgba(124,196,255,0.06)', border: `1px solid ${T.border}`,
        },
      },
        h('div', { style: { fontSize: 12.5, color: T.text, marginBottom: 4 } }, strings.effectHeading),
        h('div', { style: { fontSize: 12, color: T.dim, lineHeight: 1.6 } }, effectSummary.text),
      )

      /* 2) 逐类事件 × 两条通路
       *    系统通知 → notifyOnX（窗口没在前台时用）
       *    页内卡片 → toastOnX（窗口在前台时用）
       * 一行的两个格子各管一侧：合成一个勾选框会让"只发系统通知、不弹卡片"没法表达。
       */
      const cellButton = (key, on, name, title) => h('button', {
        type: 'button', className: 'lc-matrix-switch', 'data-setting-key': key, disabled: state.busy,
        'aria-pressed': on,
        'aria-label': name,
        title: title ?? name,
        onClick: () => patch(key, !on),
        style: {
          width: 26, height: 18, borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit', fontSize: 11,
          border: `1px solid ${on ? T.accent : T.border}`,
          background: on ? 'rgba(124,196,255,0.22)' : 'transparent',
          color: on ? T.text : T.faint, padding: 0,
        },
      }, on ? '✓' : '')

      /** 矩阵里的一格：列号直接写死，不依赖自动排布的顺序。 */
      const matrixCell = (column, child) => h('div', {
        style: {
          gridColumn: String(column),
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        },
      }, child)

      const rowLabelCell = (key, label, hint, sideNote) => h('div', {
        key,
        style: { gridColumn: '1', padding: '6px 0', borderTop: `1px solid ${T.border}` },
      },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 12.5, color: T.text } }, label),
          // 「仅后台 / 仅前台」：只有一侧开着时才出现。否则用户看不出某类事件
          // 在另一侧根本不会提醒 —— 这正是"勾了回合结束却一直不弹"的成因。
          sideNote ? h('span', {
            style: {
              fontSize: 11, color: T.faint, border: `1px solid ${T.border}`, borderRadius: 999,
              padding: '0 6px', whiteSpace: 'nowrap',
            },
          }, sideNote) : null,
        ),
        hint ? h('div', { style: { fontSize: 11.5, color: T.faint, marginTop: 1, lineHeight: 1.5 } }, hint) : null,
      )

      const matrix = h('div', { className: 'lc-notify-matrix', style: { display: 'grid', gridTemplateColumns: '1fr 34px 34px' } },
        h('div', { style: { gridColumn: '1' } }),
        h('div', { style: { gridColumn: '2', textAlign: 'center', fontSize: 11.5, color: T.faint, paddingBottom: 4 } }, strings.colSystem),
        h('div', { style: { gridColumn: '3', textAlign: 'center', fontSize: 11.5, color: T.faint, paddingBottom: 4 } }, strings.colCard),
        ...EVENT_KINDS.map((row) => {
          const label = strings[row.labelKey]
          // 两侧状态一致（都开或都关）就不挂标记，只有"只走了一条路"才点出来。
          const sysOn = state.cfg[row.systemKey] === true
          const cardOn = state.cfg[row.cardKey] !== false
          const sideNote = sysOn === cardOn ? null : (sysOn ? strings.onlySystem : strings.onlyCard)
          // 每一行都画全两个格子：不再有跨行合并，也就不可能错位。
          return [
            rowLabelCell(row.labelKey, label, row.hintKey ? strings[row.hintKey] : '', sideNote),
            matrixCell(2, cellButton(row.systemKey, state.cfg[row.systemKey] === true, `${label} 系统通知`)),
            matrixCell(3, cellButton(row.cardKey, state.cfg[row.cardKey] !== false, `${label} 页内卡片`)),
          ]
        }).flat(),
      )

      const eventsBlock = block(strings.eventsHeading2, [
        h('div', { style: { marginTop: 8 } }, matrix),
        blockHint(strings.matrixNote),
      ])

      /* 3) 系统通知这块：出声（提示音总开关 + 自定义音）与"留在通知中心"。
       *    提示音和自定义提示音原本被拆在两个区块里，其实是同一件事，现在收到一起。
       *    自定义提示音再进一步收进折叠区 —— 它的输入框 + 试听 + 目录 + 文件列表
       *    曾占掉这块三分之二的高度，而绝大多数人用系统通知音就够了。
       */
      const customSound = h('div', { style: { paddingTop: 10 } },
        h('div', { style: { fontSize: 11.5, color: T.faint, margin: '0 0 8px', lineHeight: 1.6 } }, strings.soundFileHint),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
          h('input', {
            type: 'text',
            'data-setting-key': 'soundFile', value: state.cfg.soundFile,
            placeholder: strings.soundFilePlaceholder,
            onChange: (event) => setState((s) => ({ ...s, cfg: { ...s.cfg, soundFile: event.target.value } })),
            onBlur: () => patch('soundFile', state.cfg.soundFile),
            style: { ...FIELD_STYLE, flex: '1 1 240px', padding: '4px 6px' },
          }),
          smallButton(strings.preview, preview, strings.previewHint),
        ),
        h('div', { style: { marginTop: 8, fontSize: 11.5, color: T.faint, wordBreak: 'break-all' } },
          strings.soundsDir, state.sounds?.dir ?? '—'),
        state.sounds?.files?.length
          ? h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 } },
            state.sounds.files.map((file) => h('button', {
              key: file.name,
              type: 'button',
              title: `${file.name}（${Math.max(1, Math.round(file.size / 1024))} KB）`,
              onClick: () => {
                setState((s) => ({ ...s, cfg: { ...s.cfg, soundFile: file.name } }))
                patch('soundFile', file.name)
              },
              style: {
                padding: '2px 8px', borderRadius: 999, cursor: 'pointer', fontSize: 11.5, fontFamily: 'inherit',
                border: `1px solid ${state.cfg.soundFile === file.name ? T.accent : T.border}`,
                background: state.cfg.soundFile === file.name ? 'rgba(124,196,255,0.14)' : 'transparent',
                color: T.dim,
              },
            }, file.name)))
          : h('div', { style: { marginTop: 6, fontSize: 11.5, color: T.faint } }, strings.noSounds),
        state.sounds?.resolved?.error
          ? h('div', { style: { marginTop: 6, fontSize: 11.5, color: T.warn } }, state.sounds.resolved.error)
          : null,
      )

      const systemBlock = block(strings.systemHeading, [
        blockHint(strings.systemHint),
        h(Toggle, { field: 'sound', label: strings.sound, hint: strings.soundHint, value: state.cfg.sound, onChange: (v) => patch('sound', v) }),
        h(Toggle, { field: 'sticky', label: strings.sticky, hint: strings.stickyHint, value: state.cfg.sticky, onChange: (v) => patch('sticky', v) }),
        fold('sound', strings.soundFileLabel, strings.foldSoundHint, [customSound]),
      ])

      /* 4) 页内卡片：只留"卡片长什么样"（停留多久、落在哪个角落）。 */
      const cornerNames = strings.cornerNames ?? {}
      const cardBlock = block(strings.cardHeading, [
        blockHint(strings.cardHint),
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 } },
          numberField(strings.toastMs, 'toastMs', (v) => v * 1000, (v) => Math.round((v ?? 0) / 1000), { min: 0, max: 120 }),
          field(strings.corner,
            h('select', {
              'data-setting-key': 'toastCorner', value: state.cfg.toastCorner,
              onChange: (event) => patch('toastCorner', event.target.value),
              style: { ...FIELD_STYLE, paddingRight: 4 },
            }, ...TOAST_CORNERS.map((corner) => h('option', { key: corner, value: corner }, cornerNames[corner] ?? corner))),
            { flex: '1 1 160px', justifyContent: 'flex-end' }),
        ),
      ])

      /* 5) 其他：节流与标题前缀 —— 跟"走哪条路""弹什么"都没关系，改一次就不碰，
       *    所以整块收进折叠区，默认不占版面。
       */
      const otherBlock = block(strings.otherHeading, [
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 } },
          numberField(strings.throttle, 'throttleSeconds', (v) => v, (v) => v, { min: 0, max: 3600 }),
          textField(strings.titlePrefix, 'title', 40),
        ),
      ], 'other')

      // 测试两个按钮各验一条通路；「重新读取」是唯一那个刷新动作
      //（原来「重新读取配置」和「重新扫描目录」是同一个函数挂了两个按钮）。
      const actions = h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' } },
        primaryButton(strings.test, test, strings.testHint),
        primaryButton(strings.testCard, testCard, strings.testCardHint),
        smallButton(strings.reload, refresh, strings.reloadHint),
        h('span', { style: { fontSize: 11.5, color: T.faint } }, state.notice ?? ''),
      )

      /* 6) 运行状态与最近事件：纯排错信息。平时不需要，但通知一旦不弹它就是唯一线索
       *    —— 所以不删，只是收进折叠区，默认不占版面。
       */
      const status = block(strings.statusHeading, [
        h('div', { style: { marginTop: 8 } },
          h(Row, { label: strings.origin, value: originOf() }),
          h(Row, { label: strings.supported, value: supported() ? 'yes' : 'no' }),
          h(Row, { label: strings.permission, value: permissionOf() }),
          h(Row, { label: strings.hooks, value: watching ? 'uiSession.sessionStatus' : '—' }),
          h(Row, { label: strings.timing, value: timingLabel(timing) }),
          h(Row, { label: strings.settingsPath, value: state.info?.settingsPath ?? '—' }),
        ),
        h('div', { style: { fontSize: 12.5, color: T.text, margin: '12px 0 4px' } }, strings.eventsHeading),
        recent.length === 0
          ? h('div', { style: { fontSize: 12, color: T.faint } }, strings.noEvents)
          : h('div', { style: { fontSize: 11.5, color: T.faint, lineHeight: 1.6 } }, recent.slice(0, 10).map((event, index) => h('div', { key: `${event.t}-${index}` },
            `${event.t.slice(11, 19)} ${event.kind}${event.detail ? ` · ${event.detail}` : ''}${event.body ? ` · ${event.body}` : ''}`))),
      ], 'status')

      return h('div', { className: 'laurel-settings', 'data-laurel-module': '', style: { padding: '4px 2px 24px', color: T.text, fontSize: 13 } },
        heading, intro, banner,
        h('nav', { 'aria-label': strings.heading }, ...[['rules', strings.rulesTab], ['appearance', strings.appearanceTab], ['diagnostics', strings.diagnosticsTab]].map(([id, label]) => h('button', { key: id, type: 'button', 'aria-pressed': settingsTab === id, onClick: () => setSettingsTab(id) }, label))),
        h('div', { hidden: settingsTab !== 'rules' }, effectBlock, timingBlock, eventsBlock, otherBlock, actions),
        h('div', { hidden: settingsTab !== 'appearance' }, systemBlock, cardBlock),
        h('div', { hidden: settingsTab !== 'diagnostics' }, status),
      )
    }

    /* ------------------------------------------------------------------ *
     * 注册
     * ------------------------------------------------------------------ */

    /**
     * 需要这两个客户端服务：
     *   - `slots`     设置页是插槽，不是独立路由；
     *   - `uiSession` 会话状态的权威来源（没有它就没得可通知）。
     * 声明为必需 = cordis 等它们就绪后才激活本插件。
     */
    const inject = ['slots', 'uiSession']

    /**
     * 注册设置页。
     *
     * 两路注册（2026-10-13 起）：装载机在就聚合进「Laurel总控」，不在就照旧单独一条。
     * 为什么必须两路都留着：插槽系统「声明即独占渲染权」—— 聚合插槽
     * `laurel-center.module` 是装载机声明的，用户只装了 laurel 没装装载机时，聚合那条路
     * 永远等不到声明，设置页就整块消失。两个 inject 同时挂着，谁先成立谁生效；
     * 聚合成立就把独立那份撤掉，免得同时出现在设置导航和总控里两处。
     *
     * ⚠ 这里写的 `id: 'laurel'` 必须与 `lib/registry.js` 里那条的 `settingsId` 一致 ——
     * 装载机就是靠这个值把「总控里那张卡片」和「这段设置内容」对上的。对不上不会报错，
     * 只会让卡片展开后是空的。
     */
    function registerSettings(ctx) {
      const slots = ctx.slots
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        throw new Error('laurel: 拿不到 slots 服务，无法注册设置页')
      }
      const GROUP = 'laurel-center.module'
      const put = (name) => slots.register({
        name,
        id: 'laurel',
        order: 55,
        label: () => t().label,
      }, NotifySettings)
      ctx.effect(() => {
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
        // `?.()`：inject 的契约是返回 disposer，但测试替身未必给 —— 卸载时抛
        // 「offGroup is not a function」会把整个卸载流程带塌。
        return () => { offGroup?.(); offStandalone?.() }
      }, 'laurel.settings-section')
    }

    function apply(ctx) {
      // 配置：先读一次（异步，不阻塞注册）。读不到就按内置默认值跑，并留一条事件。
      loadConfig().catch(() => {})
      watchStatus(ctx)
      try {
        registerSettings(ctx)
      } catch (error) {
        report({ kind: 'error', detail: `设置页注册失败（不影响通知）：${error?.message ?? error}` })
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})

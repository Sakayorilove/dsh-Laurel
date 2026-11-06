/**
 * laurel-reasoning-scroll · 客户端半边（源码，构建成 lib/client.js）
 *
 * 把「思考过程」的展开体做成限高滚动窗：限高 + 遮罩渐变 + 流式贴底 + 结束收起。
 * 做成 Laurel 套件的一个独立模块，与宿主原生渲染解耦。
 *
 * ── 这个文件只做四件事 ─────────────────────────────────────────────────
 *   1. 替换 conversation.chat.reasoning.body：正文原样交给宿主渲染，只加窗口与样式；
 *   2. 设置页：八个开关，写宿主半边的 /laurel/reasoning-scroll/config；
 *   3. DOM 控制器：流式自动展开 / 结束自动收起 / 工具过程并入同一个限高窗；
 *   4. 「跳回最新」胶囊按钮。
 *
 * ── 客户端四条硬约束（套件 CONTRACT）──────────────────────────────────
 *   · 产物是 classic script 里的 CJS factory：不许顶层 import、不许默认导出、
 *     不许动态 import()。本文件只写命名导出，打包器会剥掉 export 关键字。
 *   · require() 只认 platform seed 表。共享代码由打包器内联 —— kit 就在同一个
 *     作用域里，requestJSON / registerSettingsSection 直接可用。
 *   · 必须导出 apply(ctx)。
 *   · 顶层不许有依赖执行顺序的副作用：所有状态、store、组件都建在 apply 里面。
 *
 * ── 打包器两个坑（别改回去）────────────────────────────────────────────
 *   · 剥注释状态机不处理「模板串里嵌套模板串」，所以本文件**不用模板串**，
 *     全部用 + 拼接。
 *   · 注释里也不要写「反引号夹一段代码」，那是给人看的，会被当成字符串起点。
 *
 * ── 渐变为什么用遮罩而不是 background-clip:text ───────────────────────
 * 宿主思考正文是嵌套 markdown，后代自带 paint containment，祖先的
 * background-clip:text 裁剪形状不包含这些后代的字形，背景被裁成空；再叠加
 * 继承下去的 -webkit-text-fill-color:transparent，正文就整段看不见了
 * （实测 innerText 长度 0，而 textContent 有 4800 字）。遮罩只影响透明度，
 * 永远不会让文字消失。所以 CSS 里还会有一条兜底：正文所有后代强制
 * text-fill-color 为 currentColor。
 *
 * Copyright (c) 2026 Clelia
 * SPDX-License-Identifier: MIT
 */

/** 宿主半边的前缀路由。三处必须一致：lib/index.js / lib/host/routes.js / 这里。 */
const API = '/laurel/reasoning-scroll'

/** 设置页条目 id。必须等于 registry.js 的 settingsId。 */
const SETTINGS_ID = 'reasoning-scroll'
const SETTINGS_ORDER = 55

/** 只注入真实存在的客户端服务名（写错会让整行停在 pending，web boot 直接失败）。 */
const inject = ['slots']

const BODY_ATTR = 'data-lrs-body'
const PROCESS_ATTR = 'data-lrs-process-body'
const THINK_SELECTOR = '[data-variant="think"]'
const DISCLOSURE_SELECTOR = '[data-disclosure-row]'
const PROCESS_BODY_SELECTOR = '[data-step-process-body]'

/**
 * 首屏兜底。宿主端点还没通时界面必须画得出来。
 * 权威在宿主 lib/core/config.js 的 FIELDS —— 这里只是「读不到配置时」的显示底稿。
 */
const FALLBACK = {
  enabled: true,
  maxHeight: 240,
  autoFollow: true,
  expandOnStream: true,
  collapseOnDone: true,
  gradientText: true,
  showJumpButton: true,
  includeToolCalls: false,
}

const FIELDS = Object.keys(FALLBACK)
const MIN_HEIGHT = 80
const MAX_HEIGHT = 1200

/** 按兜底值的类型归一化一个字段：绝不信任外部传进来的值。 */
function normalize(field, value) {
  const base = FALLBACK[field]
  if (typeof base === 'boolean') return typeof value === 'boolean' ? value : base
  if (typeof base === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return base
    return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(value)))
  }
  return value === undefined ? base : value
}

function normalizeAll(source) {
  const out = {}
  for (const field of FIELDS) out[field] = normalize(field, source === undefined || source === null ? undefined : source[field])
  return out
}

/** 中英双语：语言只看 navigator，中文才走中文，其余落英文。 */
function isEn() {
  try {
    return /^en/i.test(typeof navigator === 'undefined' ? '' : String(navigator.language || ''))
  } catch (_languageFailure) {
    return false
  }
}

function tr(zh, en) {
  return isEn() ? en : zh
}
/* ------------------------------------------------------------------ *
 * 设置 store：模块级单例
 * ------------------------------------------------------------------ */

/**
 * 为什么是模块级单例而不是 React context：
 * 这个 store 同时被「思考正文组件」「设置页」和「DOM 控制器」读写，
 * 三者分处三棵 React 树（正文在会话流里、设置在设置面板里、控制器根本没有树）。
 * 用 context 就得在宿主外面再包一层 Provider，而插槽作者包不了宿主。
 */
function createStore() {
  let current = Object.assign({}, FALLBACK)
  const listeners = new Set()

  /** 把设置写到根节点上：CSS 变量与总开关标记都由它带出去。 */
  function publishRoot(next) {
    try {
      if (typeof document === 'undefined' || document.documentElement === null) return
      const root = document.documentElement
      root.style.setProperty('--lrs-max-height', String(next.maxHeight) + 'px')
      if (next.enabled) root.setAttribute('data-lrs-on', '')
      else root.removeAttribute('data-lrs-on')
    } catch (_rootFailure) {
      /* 非浏览器环境：样式不生效，逻辑照常 */
    }
  }

  function emit() {
    for (const fn of Array.from(listeners)) {
      try {
        fn()
      } catch (_listenerFailure) {
        /* 订阅者自己的问题不能带走整个模块 */
      }
    }
  }

  const store = {
    get() {
      return current
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    /** 整份替换（从宿主读回来的那一份）。 */
    reset(next) {
      const merged = normalizeAll(next)
      let changed = false
      for (const field of FIELDS) {
        if (merged[field] !== current[field]) {
          changed = true
          break
        }
      }
      current = merged
      publishRoot(current)
      if (changed) emit()
      return changed
    },
    /** 合并一批（用户点了某个开关）。返回值表示是否真的变了。 */
    merge(patch) {
      const next = Object.assign({}, current)
      let changed = false
      for (const field of FIELDS) {
        if (patch === undefined || patch === null || patch[field] === undefined) continue
        const value = normalize(field, patch[field])
        if (value !== next[field]) {
          next[field] = value
          changed = true
        }
      }
      if (!changed) return false
      current = next
      publishRoot(current)
      emit()
      return true
    },
  }
  publishRoot(current)
  return store
}

/* ------------------------------------------------------------------ *
 * 样式
 * ------------------------------------------------------------------ */

const CSS = [
  '[data-lrs-body]{position:relative;display:block;box-sizing:border-box;'
    + 'max-height:var(--lrs-max-height,240px);overflow-y:auto;overflow-x:hidden;'
    + 'overscroll-behavior:contain;scrollbar-width:thin;scrollbar-gutter:stable;'
    + 'border-left:2px solid var(--dsw-alias-border-l1);padding:2px 2px 2px 12px;margin:2px 0 4px 0}',
  '[data-lrs-body][data-gradient]{--lrs-grad:linear-gradient(180deg,#000 0%,#000 55%,rgba(0,0,0,.55) 100%)}',
  '[data-lrs-body][data-fade-up]{--lrs-edge:linear-gradient(#0000 0,#000 24px 100%)}',
  '[data-lrs-body][data-fade-down]{--lrs-edge:linear-gradient(#000 0 calc(100% - 24px),#0000 100%)}',
  '[data-lrs-body][data-fade-up][data-fade-down]{--lrs-edge:linear-gradient(#0000 0,#000 24px calc(100% - 24px),#0000 100%)}',
  '[data-lrs-body][data-gradient],[data-lrs-body][data-fade-up],[data-lrs-body][data-fade-down]{'
    + '-webkit-mask-image:var(--lrs-grad,linear-gradient(#000,#000)),var(--lrs-edge,linear-gradient(#000,#000));'
    + 'mask-image:var(--lrs-grad,linear-gradient(#000,#000)),var(--lrs-edge,linear-gradient(#000,#000));'
    + '-webkit-mask-composite:source-in;mask-composite:intersect}',
  '[data-lrs-body] *{-webkit-text-fill-color:currentColor}',
  '[data-lrs-jump-wrap]{position:sticky;bottom:6px;z-index:2;display:flex;justify-content:center;height:0;pointer-events:none}',
  '[data-lrs-jump]{pointer-events:auto;display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 10px;'
    + 'border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-overlay);'
    + 'color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);'
    + 'line-height:1;cursor:pointer}',
  '[data-lrs-process-body]{max-height:var(--lrs-max-height,240px)!important;'
    + 'overflow-y:auto!important;scrollbar-width:thin;overscroll-behavior:contain}',
  '[data-lrs-page]{display:flex;flex-direction:column;gap:2px;padding:0 0 24px}',
  '[data-lrs-h]{font-size:16px;line-height:24px;color:var(--dsw-alias-label-primary);margin:0 0 4px}',
  '[data-lrs-lede]{font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary);margin:0 0 12px}',
  '[data-lrs-row]{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:14px 0;'
    + 'border-bottom:.5px solid var(--dsw-alias-border-l2)}',
  '[data-lrs-row]:last-child{border-bottom:none}',
  '[data-lrs-title]{font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary)}',
  '[data-lrs-desc]{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
  '[data-lrs-num]{width:88px;height:28px;padding:0 8px;border-radius:var(--dsw-radius-sm);'
    + 'border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);'
    + 'color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
  '[data-lrs-note]{margin-top:10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
  '[data-lrs-note][data-tone="warn"]{color:var(--dsw-alias-label-warning,inherit)}',
  '[data-lrs-note][data-tone="error"]{color:var(--dsw-alias-label-danger,inherit)}',
  '[data-lrs-meta]{margin-top:4px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);'
    + 'word-break:break-all}',
  '@media (prefers-reduced-motion:reduce){[data-lrs-jump]{transition:none}}',
].join('')

/**
 * 装样式表。已经装过就返回 no-op（重复挂载不叠标签）。
 * 用 data-plugin 标出来，卸载时只摘自己那一张。
 */
function createStyleInstaller() {
  let tag = null
  return {
    install() {
      try {
        if (typeof document === 'undefined') return
        if (tag !== null) return
        const existing = document.querySelector('style[data-plugin="' + SETTINGS_ID + '"]')
        if (existing !== null) {
          tag = existing
          return
        }
        const el = document.createElement('style')
        el.setAttribute('data-plugin', SETTINGS_ID)
        el.textContent = CSS
        document.head.appendChild(el)
        tag = el
      } catch (_styleFailure) {
        /* 样式装不上不影响功能，只是不好看 */
      }
    },
    remove() {
      try {
        if (tag !== null && tag.parentNode !== null) tag.parentNode.removeChild(tag)
      } catch (_removeFailure) {
        /* 已经不在文档里 */
      }
      tag = null
    },
  }
}
/* ------------------------------------------------------------------ *
 * 正文：原样交给宿主的渲染器
 * ------------------------------------------------------------------ */

/**
 * 原语包在整套客户端里通常可用，但**拿不到也必须能活**。
 * 注意 require 只认 platform seed 表：写一个不在表里的包名会抛
 * 「missed the module table」，所以整个 require 必须在 try 里。
 */
function loadPrimitives(require) {
  try {
    return require('@deepseek-ai/dsh-client-ui-primitives') || {}
  } catch (_primitivesUnavailable) {
    return {}
  }
}

/** 纯文本兜底：保留换行与折行，绝不吞内容。 */
function plainText(React, text) {
  return React.createElement('div', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, text)
}

/**
 * 渲染正文。三层降级，任何一层失败都能继续往下：
 *   ① 宿主自己的 reasoning.content 工厂（官方 markdown，labels 由宿主给）；
 *   ② 原语里的 MarkdownText；
 *   ③ 纯文本。
 * 契约要求原始文本仍然完整可见 —— 这一条比「好看」重要。
 */
function createReasoningContent(React, primitives) {
  /** 错误边界：子渲染崩了不能让整段思考消失。 */
  class ContentBoundary extends React.Component {
    constructor(props) {
      super(props)
      this.state = { failed: false }
    }
    static getDerivedStateFromError() {
      return { failed: true }
    }
    componentDidCatch() {
      /* 静默降级：思考文本还要能看 */
    }
    render() {
      if (this.state.failed) return this.props.fallback
      return this.props.children
    }
  }

  return function ReasoningContent(props) {
    const text = props.text
    const running = props.running
    const rendered = React.useMemo(() => {
      if (props.forcePlain === true) return plainText(React, text)
      if (typeof props.renderFactorySlot === 'function') {
        try {
          const node = props.renderFactorySlot('conversation.chat.reasoning.content', { text: text, running: running })
          if (node !== undefined && node !== null && node !== false) return node
        } catch (_factoryFailure) {
          /* 落到下一层 */
        }
      }
      if (typeof primitives.MarkdownText === 'function') {
        try {
          return React.createElement(primitives.MarkdownText, { text: text, streaming: running, variant: 'compact' })
        } catch (_markdownFailure) {
          /* 落到下一层 */
        }
      }
      return plainText(React, text)
    }, [text, running, props.renderFactorySlot, props.forcePlain])

    return React.createElement(ContentBoundary, { fallback: plainText(React, text) }, rendered)
  }
}

/* ------------------------------------------------------------------ *
 * 量测小工具（三个测量陷阱的防线）
 * ------------------------------------------------------------------ */

/** 读滚动尺寸；任何一项缺失/非数都当 0，绝不把 NaN 传进样式判断。 */
function metricsOf(el) {
  const top = Number(el.scrollTop) || 0
  const height = Number(el.scrollHeight) || 0
  const view = Number(el.clientHeight) || 0
  return { top: top, floor: Math.max(0, height - view), distance: Math.max(0, height - view - top) }
}

/**
 * 元素此刻是否真的参与渲染。
 * 挡住的是「外层折叠组 content-visibility:hidden」这种假空：那时 body 矩形正常，
 * innerText 恒为 0，但 markdown 完全正常。误判会把好内容降级成纯文本。
 */
function isRendered(el) {
  try {
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true }) === true
    }
    return el.getClientRects().length > 0
  } catch (_visibilityFailure) {
    return true
  }
}

/** 解析一个 CSS 颜色，返回 alpha；解析不出返回 -1。 */
function alphaOf(color) {
  if (typeof color !== 'string') return -1
  const value = color.trim()
  if (value === '') return -1
  if (value === 'transparent') return 0
  const match = /rgba?\(([^)]+)\)/.exec(value)
  if (match === null) return -1
  const parts = match[1].split(/[\s,/]+/).filter(function (s) { return s !== '' })
  if (parts.length < 4) return 1
  const raw = String(parts[3])
  const alpha = Number(raw.replace('%', ''))
  if (!Number.isFinite(alpha)) return -1
  return raw.indexOf('%') >= 0 ? alpha / 100 : alpha
}

/** 正文里第一个带文字的节点，其文字填充色是不是透明的（v0.2.0 隐形 bug 的硬特征）。 */
function textFillIsInvisible(el) {
  try {
    if (typeof document === 'undefined' || typeof document.createTreeWalker !== 'function') return false
    const walker = document.createTreeWalker(el, 4)
    let node = walker.nextNode()
    let guard = 0
    while (node !== null && guard < 300) {
      guard += 1
      const raw = node.nodeValue
      if (raw !== null && raw !== undefined && String(raw).trim().length > 0) {
        const parent = node.parentElement
        if (parent !== null) {
          const style = getComputedStyle(parent)
          const fill = style.webkitTextFillColor || style.color || ''
          return alphaOf(fill) === 0
        }
      }
      node = walker.nextNode()
    }
    return false
  } catch (_fillFailure) {
    return false
  }
}

/** 渲染了、有文字内容，但所有文本节点都量不到任何几何（宽高皆 0）。 */
function hasNoTextGeometry(el) {
  try {
    if (typeof document === 'undefined' || typeof document.createRange !== 'function') return false
    const walker = document.createTreeWalker(el, 4)
    let node = walker.nextNode()
    let guard = 0
    while (node !== null && guard < 300) {
      guard += 1
      const raw = node.nodeValue
      if (raw !== null && raw !== undefined && String(raw).trim().length > 0) {
        const range = document.createRange()
        range.selectNodeContents(node)
        const rects = range.getClientRects()
        for (let i = 0; i < rects.length; i += 1) {
          if (rects[i].width > 0 && rects[i].height > 0) return false
        }
      }
      node = walker.nextNode()
    }
    return true
  } catch (_geometryFailure) {
    return false
  }
}
/* ------------------------------------------------------------------ *
 * 滚动窗本体（替换 conversation.chat.reasoning.body）
 * ------------------------------------------------------------------ */

function createReasoningScrollBody(React, ReasoningContent, store, useSettings) {
  return function ReasoningScrollBody(props) {
    const config = useSettings()
    const text = typeof props.text === 'string' ? props.text : ''
    const running = props.running === true

    const bodyRef = React.useRef(null)
    const followRef = React.useRef(true)
    const lastTopRef = React.useRef(0)
    const pair = React.useState(true)
    const following = pair[0]
    const setFollowing = pair[1]
    const edgePair = React.useState({ up: false, down: false })
    const edges = edgePair[0]
    const setEdges = edgePair[1]
    const plainPair = React.useState(false)
    const forcePlain = plainPair[0]
    const setForcePlain = plainPair[1]

    const scrollToBottom = React.useCallback(function (behavior) {
      const el = bodyRef.current
      if (el === null) return
      try {
        if (typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior: behavior || 'auto' })
        else el.scrollTop = el.scrollHeight
      } catch (_scrollFailure) {
        el.scrollTop = el.scrollHeight
      }
    }, [])

    const syncEdges = React.useCallback(function () {
      const el = bodyRef.current
      if (el === null) return
      const metrics = metricsOf(el)
      setEdges(function (prev) {
        const up = metrics.top > 1
        const down = metrics.top < metrics.floor - 1
        if (prev.up === up && prev.down === down) return prev
        return { up: up, down: down }
      })
    }, [])

    const onScroll = React.useCallback(function () {
      const el = bodyRef.current
      if (el === null) return
      const metrics = metricsOf(el)
      const wentUp = metrics.top < lastTopRef.current
      if (wentUp && metrics.distance > 20) followRef.current = false
      else if (!wentUp && metrics.distance < 10) followRef.current = true
      lastTopRef.current = metrics.top
      setFollowing(followRef.current)
      syncEdges()
    }, [syncEdges, setFollowing])

    /** 内容变化 → 跟随。React 每次 text 变化都会重渲染，比 MutationObserver 可靠。 */
    React.useLayoutEffect(function () {
      if (config.autoFollow && followRef.current) scrollToBottom('auto')
      syncEdges()
    }, [text, running, config.autoFollow, config.maxHeight, scrollToBottom, syncEdges])

    /** 新的一段思考进来 → 重新贴底。 */
    React.useLayoutEffect(function () {
      followRef.current = true
      setFollowing(true)
      scrollToBottom('auto')
      syncEdges()
    }, [scrollToBottom, syncEdges, setFollowing])

    /**
     * 内容自检（两帧之后跑）：只有在拿到**硬凭据**时才退回纯文本。
     *   · 元素必须真的在渲染（挡住外层折叠组造成的假空）；
     *   · 文字填充色真的是透明的 → 退回（这是 v0.2.0 bug 的真实特征）；
     *   · 渲染了、有字，却量不到任何可见文字几何 → 退回。
     * innerText 长度本身**不作为判据** —— 它可能只是没渲染或离屏测量。
     */
    React.useLayoutEffect(function () {
      if (forcePlain) return undefined
      const el = bodyRef.current
      if (el === null || String(text).trim().length === 0) return undefined
      let cancelled = false
      const probe = function () {
        if (cancelled || el === null) return
        try {
          if (!isRendered(el)) return
          const box = el.getBoundingClientRect()
          if (!(box.width > 8 && box.height > 8)) return
          if (textFillIsInvisible(el)) {
            setForcePlain(true)
            return
          }
          const inner = typeof el.innerText === 'string' ? el.innerText.trim().length : -1
          if (inner === 0 && String(el.textContent || '').trim().length > 0 && hasNoTextGeometry(el)) setForcePlain(true)
        } catch (_probeFailure) {
          /* 量不到就维持现状，绝不据此降级 */
        }
      }
      const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : function (fn) { return setTimeout(fn, 16) }
      const id = raf(function () { raf(probe) })
      return function () {
        cancelled = true
        if (typeof cancelAnimationFrame === 'function') {
          try {
            cancelAnimationFrame(id)
          } catch (_cancelFailure) {
            /* 已经跑完 */
          }
        }
      }
    }, [text, forcePlain, setForcePlain])

    /* 总开关关掉：不套任何样式，原样交还宿主正文（等于回到原生展示）。 */
    if (!config.enabled) {
      return React.createElement(ReasoningContent, { text: text, running: running, forcePlain: forcePlain, renderFactorySlot: props.renderFactorySlot })
    }

    const attributes = { ref: bodyRef, onScroll: onScroll, tabIndex: -1 }
    attributes[BODY_ATTR] = ''
    if (config.gradientText) attributes['data-gradient'] = ''
    if (edges.up) attributes['data-fade-up'] = ''
    if (edges.down) attributes['data-fade-down'] = ''
    if (following) attributes['data-lrs-follow'] = ''

    let jump = null
    if (config.showJumpButton && !following) {
      jump = React.createElement(
        'div',
        { 'data-lrs-jump-wrap': '' },
        React.createElement(
          'button',
          {
            type: 'button',
            'data-lrs-jump': '',
            onClick: function () {
              followRef.current = true
              setFollowing(true)
              scrollToBottom('smooth')
              syncEdges()
            },
          },
          tr('跳到最新', 'Jump to latest'),
        ),
      )
    }

    return React.createElement(
      'div',
      attributes,
      React.createElement(ReasoningContent, { text: text, running: running, forcePlain: forcePlain, renderFactorySlot: props.renderFactorySlot }),
      jump,
    )
  }
}
/* ------------------------------------------------------------------ *
 * DOM 控制器：流式自动展开 / 结束自动收起 / 工具过程并入限高窗
 * ------------------------------------------------------------------ */

/**
 * 展开/收起是宿主 ReasoningRow 的 React 状态，插槽作者改不到。
 * 所以这里**派发真的 click**，让宿主自己改状态；绝不直接改 data-expanded。
 *
 * 为什么不能直接改属性：宿主的状态与 DOM 不同步时，下一次它重渲染就会把它改回去，
 * 于是表现成「自动展开闪一下又收回」，而且没有任何报错可查。
 */
function createController(store) {
  if (typeof document === 'undefined' || typeof MutationObserver !== 'function') {
    return { start: function () { return function () {} } }
  }

  return {
    start: function () {
      const STATE = new WeakMap()
      /** 工具过程窗口的跟随状态：和思考窗一样，用户往上翻就不再抢位置。 */
      const PROC = new WeakMap()
      let disposed = false
      let frame = 0
      let selfClickTarget = null
      let observer = null

      function recordOf(root) {
        let rec = STATE.get(root)
        if (rec === undefined) {
          rec = { lastRunning: null, userCollapsed: false }
          STATE.set(root, rec)
        }
        return rec
      }

      /** 宿主：data-expanded={expanded || undefined}；正文已经在 DOM 里也算展开。 */
      function isExpanded(root) {
        if (root.hasAttribute('data-expanded')) return true
        return root.querySelector('[' + BODY_ATTR + ']') !== null
      }

      function clickRow(root, rec) {
        const row = root.querySelector(DISCLOSURE_SELECTOR)
        if (row === null) return
        selfClickTarget = rec
        try {
          row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
        } catch (_dispatchFailure) {
          /* 派发不出去就算了，下一帧还会再试 */
        } finally {
          selfClickTarget = null
        }
      }

      function attachProcessFollow(body) {
        if (PROC.has(body)) return
        const rec = { follow: true, top: 0, detach: null }
        PROC.set(body, rec)
        const onScroll = function () {
          const metrics = metricsOf(body)
          const wentUp = metrics.top < rec.top - 1
          if (wentUp && metrics.distance > 20) rec.follow = false
          else if (!wentUp && metrics.distance < 10) rec.follow = true
          rec.top = metrics.top
        }
        body.addEventListener('scroll', onScroll, { passive: true })
        rec.detach = function () { body.removeEventListener('scroll', onScroll) }
      }

      /** 工具过程窗口：includeToolCalls 打开时套上限高滚动，并自己维护「贴底」。 */
      function markProcessBodies() {
        const config = store.get()
        const on = config.enabled === true && config.includeToolCalls === true
        const bodies = document.querySelectorAll(PROCESS_BODY_SELECTOR)
        for (let i = 0; i < bodies.length; i += 1) {
          const body = bodies[i]
          if (!on) {
            if (body.hasAttribute(PROCESS_ATTR)) body.removeAttribute(PROCESS_ATTR)
            const rec = PROC.get(body)
            if (rec !== undefined) {
              try {
                if (typeof rec.detach === 'function') rec.detach()
              } catch (_detachFailure) {
                /* 元素可能已经不在文档里 */
              }
              PROC.delete(body)
            }
            continue
          }
          body.setAttribute(PROCESS_ATTR, '')
          attachProcessFollow(body)
          const rec = PROC.get(body)
          if (rec !== undefined && rec.follow) {
            const metrics = metricsOf(body)
            if (metrics.floor > 0) {
              body.scrollTop = metrics.floor
              rec.top = metrics.floor
            }
          }
        }
      }

      function tick() {
        frame = 0
        if (disposed) return
        try {
          markProcessBodies()
          const config = store.get()
          if (!config.enabled) return
          const roots = document.querySelectorAll(THINK_SELECTOR)
          for (let i = 0; i < roots.length; i += 1) {
            const root = roots[i]
            const rec = recordOf(root)
            const running = root.dataset !== undefined && root.dataset.state === 'running'
            const expanded = isExpanded(root)
            if (rec.lastRunning === true && running === false) {
              rec.userCollapsed = false
              if (config.collapseOnDone && expanded) clickRow(root, rec)
            } else if (rec.lastRunning === false && running === true) {
              if (config.expandOnStream && !expanded && !rec.userCollapsed) clickRow(root, rec)
            } else if (rec.lastRunning === null && config.expandOnStream && running && !expanded && !rec.userCollapsed) {
              clickRow(root, rec)
            }
            rec.lastRunning = running
          }
        } catch (_tickFailure) {
          /* 宿主 DOM 处于意外形状时不要连带影响页面 */
        }
      }

      function schedule() {
        if (disposed || frame !== 0) return
        const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : function (fn) { return setTimeout(fn, 16) }
        frame = raf(tick)
      }

      function onClick(event) {
        const target = event.target
        if (target === null || target === undefined || typeof target.closest !== 'function') return
        if (target.closest(DISCLOSURE_SELECTOR) === null) return
        const root = target.closest(THINK_SELECTOR)
        if (root === null) return
        const rec = recordOf(root)
        if (selfClickTarget === rec) return
        queueMicrotask(function () {
          rec.userCollapsed = !isExpanded(root)
        })
      }

      observer = new MutationObserver(schedule)
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-state', 'data-variant', 'data-expanded', 'hidden'],
      })
      document.addEventListener('click', onClick, true)
      schedule()

      return function () {
        disposed = true
        try {
          if (observer !== null) observer.disconnect()
        } catch (_disconnectFailure) {
          /* 已经断开 */
        }
        document.removeEventListener('click', onClick, true)
        if (frame !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
        frame = 0
        const marked = document.querySelectorAll('[' + PROCESS_ATTR + ']')
        for (let i = 0; i < marked.length; i += 1) {
          const body = marked[i]
          const rec = PROC.get(body)
          if (rec !== undefined && typeof rec.detach === 'function') {
            try {
              rec.detach()
            } catch (_detachFailure) {
              /* 收摊失败不阻断卸载 */
            }
            PROC.delete(body)
          }
          body.removeAttribute(PROCESS_ATTR)
        }
      }
    },
  }
}
/* ------------------------------------------------------------------ *
 * 设置页
 * ------------------------------------------------------------------ */

/** 一行的骨架：左边标题 + 说明，右边控件。 */
function createRows(React, useSettings) {
  function Row(props) {
    return React.createElement(
      'div',
      { 'data-lrs-row': '' },
      React.createElement(
        'div',
        null,
        React.createElement('div', { 'data-lrs-title': '' }, props.title),
        props.description ? React.createElement('div', { 'data-lrs-desc': '' }, props.description) : null,
      ),
      props.control,
    )
  }

  function SwitchRow(props) {
    const config = useSettings()
    const checked = config[props.field] === true
    const pair = React.useState(false)
    const busy = pair[0]
    const setBusy = pair[1]
    const onChange = function (event) {
      const next = event !== null && event !== undefined && event.target !== undefined
        ? event.target.checked === true
        : event === true
      setBusy(true)
      Promise.resolve(props.onWrite(props.field, next)).then(function () { setBusy(false) }, function () { setBusy(false) })
    }
    return React.createElement(Row, {
      title: props.title,
      description: props.description,
      control: React.createElement('input', {
        type: 'checkbox',
        role: 'switch',
        'data-lrs-switch': props.field,
        checked: checked,
        disabled: busy,
        onChange: onChange,
        style: { width: 34, height: 20, cursor: busy ? 'progress' : 'pointer' },
      }),
    })
  }

  function NumberRow(props) {
    const config = useSettings()
    const value = config[props.field]
    const draftPair = React.useState(String(value))
    const draft = draftPair[0]
    const setDraft = draftPair[1]
    const focusedRef = React.useRef(false)
    React.useEffect(function () {
      if (!focusedRef.current) setDraft(String(value))
    }, [value])
    const commit = function (raw) {
      const parsed = Number(raw)
      if (!Number.isFinite(parsed) || parsed < MIN_HEIGHT || parsed > MAX_HEIGHT) return
      props.onWrite(props.field, Math.round(parsed))
    }
    return React.createElement(Row, {
      title: props.title,
      description: props.description,
      control: React.createElement('input', {
        'data-lrs-num': '',
        type: 'number',
        min: MIN_HEIGHT,
        max: MAX_HEIGHT,
        step: 20,
        value: draft,
        onFocus: function () { focusedRef.current = true },
        onChange: function (event) {
          setDraft(event.target.value)
          commit(event.target.value)
        },
        onBlur: function () {
          focusedRef.current = false
          setDraft(String(value))
        },
      }),
    })
  }

  return { Row: Row, SwitchRow: SwitchRow, NumberRow: NumberRow }
}

/**
 * 设置页。
 *
 * ── 一次写入要说三件事 ──────────────────────────────────────────────────
 * 「已经生效」（内存）、「已经落盘」（盘上）、「盘上那份和内存一致」（回读核对）。
 * 只报第一件是很多插件通病：用户以为保存住了，重启发现回默认，而且没有任何提示。
 * 所以宿主端点回什么，这里就照实显示什么，不自己猜。
 */
function createSettingsPage(React, store, useSettings, rows) {
  const SwitchRow = rows.SwitchRow
  const NumberRow = rows.NumberRow

  return function SettingsPage() {
    useSettings()
    const loadingPair = React.useState(true)
    const loading = loadingPair[0]
    const setLoading = loadingPair[1]
    const notePair = React.useState(null)
    const note = notePair[0]
    const setNote = notePair[1]

    React.useEffect(function () {
      let cancelled = false
      requestJSON(API, '/config').then(function (data) {
        if (cancelled) return
        if (data !== null && data !== undefined && data.config !== undefined) store.reset(data.config)
        setLoading(false)
      }, function (error) {
        if (cancelled) return
        setLoading(false)
        setNote({ tone: 'error', text: tr('读不到宿主配置（界面上这些值是首屏兜底）：', 'Could not read host config (showing fallbacks): ') + String(error && error.message ? error.message : error) })
      })
      return function () { cancelled = true }
    }, [])

    const write = function (field, value) {
      // 先本地生效：点一下立刻看得到变化，不用等网络。
      store.merge((function () {
        const patch = {}
        patch[field] = value
        return patch
      })())
      const patch = {}
      patch[field] = value
      return requestJSON(API, '/config', { method: 'POST', body: { config: patch } }).then(function (data) {
        if (data !== null && data !== undefined && data.config !== undefined) store.reset(data.config)
        const verified = data === null || data === undefined ? null : data.verified
        if (data !== null && data !== undefined && data.persisted === false) {
          setNote({ tone: 'error', text: tr('已在本次运行生效，但**没有写进磁盘**：', 'Applied in this run, but NOT written to disk: ') + String(data.reason || '') })
          return
        }
        if (verified !== null && verified !== undefined && verified.matches === false) {
          setNote({ tone: 'warn', text: tr('已落盘，但回读过不了：', 'Saved, but read-back disagrees: ') + String(verified.reason || '') })
          return
        }
        try { window.dispatchEvent(new CustomEvent('laurel:configuration-saved', { detail: { id: 'reasoning-scroll', persisted: true } })) } catch {}
        setNote({ tone: 'ok', text: tr('已保存并回读核对通过。', 'Saved and verified by read-back.') })
      }, function (error) {
        // 失败时不能说“已保存”。把原因原样摊出来。
        setNote({ tone: 'error', text: tr('保存失败：', 'Save failed: ') + String(error && error.message ? error.message : error) })
      })
    }

    const children = [
      React.createElement('div', { key: 'h', 'data-lrs-h': '' }, tr('思考过程滚动窗', 'Reasoning scroll window')),
      React.createElement('div', { key: 'lede', 'data-lrs-lede': '' }, tr(
        '把「思考」的展开体做成限高滚动窗：超高等高滚动、正文自上而下淡出、流式时自动贴底。关掉总开关就完全回到 DSH 原本的样子。',
        'Turn the expanded reasoning text into a capped scroll window: fixed max height, top-to-bottom fade, auto-follow while streaming. Turn the master switch off to get the stock DSH behaviour back.',
      )),
      React.createElement(SwitchRow, {
        key: 'enabled',
        field: 'enabled',
        title: tr('总开关', 'Master switch'),
        description: tr('关掉之后一个字节都不改宿主界面，完全回到 DSH 原本的思考展示。', 'When off, not a single byte of the host UI is touched.'),
        onWrite: write,
      }),
      React.createElement(NumberRow, {
        key: 'maxHeight',
        field: 'maxHeight',
        title: tr('滚动窗高度（px）', 'Window height (px)'),
        description: tr('超过这个高度就开始内部滚动。默认 240，范围 80–1200。', 'Content taller than this scrolls inside the window. Default 240, range 80-1200.'),
        onWrite: write,
      }),
      React.createElement(SwitchRow, {
        key: 'gradientText',
        field: 'gradientText',
        title: tr('渐变文字', 'Faded text'),
        description: tr('自上而下由实到淡（用遮罩实现，不会让文字消失）。', 'Solid at the top, fading downward. Implemented with a mask, so text can never disappear.'),
        onWrite: write,
      }),
      React.createElement(SwitchRow, {
        key: 'autoFollow',
        field: 'autoFollow',
        title: tr('流式时自动贴底', 'Follow while streaming'),
        description: tr('新内容来了自动滚到底；你手动往上翻之后就不再抢你的位置。', 'Scrolls to the newest text as it arrives. Stops as soon as you scroll up.'),
        onWrite: write,
      }),
      React.createElement(SwitchRow, {
        key: 'showJumpButton',
        field: 'showJumpButton',
        title: tr('「跳到最新」按钮', 'Show jump-to-latest'),
        description: tr('上翻之后右下角给一颗胶囊按钮，点一下回到最新内容。', 'After you scroll up, a pill button brings you back to the newest text.'),
        onWrite: write,
      }),
      React.createElement(SwitchRow, {
        key: 'expandOnStream',
        field: 'expandOnStream',
        title: tr('开始思考时自动展开', 'Expand when thinking starts'),
        description: tr('模型一动脑子就把这一段摊开；手动收起过的不会再被摊开。', 'Opens the block when the model starts thinking. Blocks you closed by hand stay closed.'),
        onWrite: write,
      }),
      React.createElement(SwitchRow, {
        key: 'collapseOnDone',
        field: 'collapseOnDone',
        title: tr('思考结束自动收起', 'Collapse when thinking ends'),
        description: tr('正文开始输出时折叠成一行摘要。', 'Folds back to a one-line summary once the answer starts.'),
        onWrite: write,
      }),
      React.createElement(SwitchRow, {
        key: 'includeToolCalls',
        field: 'includeToolCalls',
        title: tr('工具过程也并入同一个高度上限', 'Cap tool-call output too'),
        description: tr('编辑 / 查看 / 调用这些工具记录，同样套用上面的高度上限（走宿主的步骤过程分组窗口）。', 'Applies the same height cap to the tool-call step groups.'),
        onWrite: write,
      }),
    ]

    if (loading) {
      children.push(React.createElement('div', { key: 'loading', 'data-lrs-note': '' }, tr('正在读取宿主配置…', 'Reading host config...')))
    }
    if (note !== null) {
      children.push(React.createElement('div', { key: 'note', 'data-lrs-note': '', 'data-tone': note.tone }, note.text))
    }

    return React.createElement('div', { 'data-lrs-page': '' }, children)
  }
}
/* ------------------------------------------------------------------ *
 * 装配
 * ------------------------------------------------------------------ */

/**
 * 客户端入口。
 *
 * ── 为什么所有东西都建在这里 ────────────────────────────────────────────
 * 顶层不许有依赖执行顺序的副作用：bundle 会被宿主求值一次、然后按需物化，
 * 顶层建 store / 装样式会让「求值」和「激活」两件事纠缠在一起，
 * 停用再启用时状态就说不清是谁的。
 */
export function apply(ctx) {
  const React = require('react')
  const primitives = loadPrimitives(require)

  const store = createStore()
  const style = createStyleInstaller()

  /** 订阅当前配置的 hook。除 React 之外不带任何依赖，所以放在 apply 里面。 */
  function useSettings() {
    const pair = React.useState(store.get())
    const value = pair[0]
    const setValue = pair[1]
    React.useEffect(function () {
      const off = store.subscribe(function () { setValue(store.get()) })
      setValue(store.get())
      return off
    }, [])
    return value
  }

  const ReasoningContent = createReasoningContent(React, primitives)
  const ReasoningScrollBody = createReasoningScrollBody(React, ReasoningContent, store, useSettings)
  const rows = createRows(React, useSettings)
  const SettingsPage = createSettingsPage(React, store, useSettings, rows)
  const controller = createController(store)

  /** 单个挂载点失败不许连累其它功能。 */
  const safeEffect = function (label, work) {
    try {
      ctx.effect(work, 'laurel-reasoning-scroll.' + label)
    } catch (error) {
      try {
        console.warn('[laurel-reasoning-scroll] ' + label + ' 挂载失败（已跳过）：' + String(error && error.message ? error.message : error))
      } catch (_consoleFailure) {
        /* 无 console 环境忽略 */
      }
    }
  }

  // ① 样式表
  safeEffect('styles', function () {
    style.install()
    return function () { style.remove() }
  })

  // ② 从宿主读一次配置；读不到就继续用首屏兜底（**不报错**，界面照常能画）
  requestJSON(API, '/config').then(function (data) {
    if (data !== null && data !== undefined && data.config !== undefined) store.reset(data.config)
  }, function (error) {
    try {
      console.warn('[laurel-reasoning-scroll] 读不到宿主配置，先用首屏兜底：' + String(error && error.message ? error.message : error))
    } catch (_consoleFailure) {
      /* 无 console 环境忽略 */
    }
  })

  const slots = (function () {
    try {
      if (ctx && typeof ctx.get === 'function') {
        const viaGet = ctx.get('slots')
        if (viaGet) return viaGet
      }
    } catch (_getFailure) {
      /* 落到下面的属性读法 */
    }
    return ctx && ctx.slots ? ctx.slots : null
  })()

  if (slots === null || slots === undefined) {
    try {
      console.warn('[laurel-reasoning-scroll] 拿不到 slots 服务：滚动窗与设置页都不会出现（这不影响宿主任何功能）')
    } catch (_consoleFailure) {
      /* 无 console 环境忽略 */
    }
    return
  }

  // ③ 换掉展开的思考正文（官方条目 priority 100，更小的值替换它）
  const mountBody = function () {
    return slots.inject('conversation.chat.reasoning.body', function () {
      return slots.register({ name: 'conversation.chat.reasoning.body', priority: 50 }, ReasoningScrollBody)
    })
  }
  safeEffect('reasoning-body', function () {
    const off = mountBody()
    return function () {
      if (typeof off === 'function') off()
    }
  })

  // ④ 设置页：走 kit 的两路注册（总控台在就聚合进去，不在就单独一条）
  if (typeof registerSettingsSection === 'function') {
    safeEffect('settings', function () {
      return registerSettingsSection(ctx, {
        id: SETTINGS_ID,
        order: SETTINGS_ORDER,
        label: function () { return tr('思考滚动', 'Reasoning scroll') },
        component: SettingsPage,
        slots: slots,
      })
    })
  } else {
    // kit 不在（理论上不会发生，产物必定内联）。兜底成只注册独立那一路，
    // 而不是静默什么都不注册 —— 后者表现成「设置页整块消失」，无从查起。
    safeEffect('settings-fallback', function () {
      return slots.inject('settings.section', function () {
        return slots.register({
          name: 'settings.section',
          id: SETTINGS_ID,
          order: SETTINGS_ORDER,
          label: function () { return tr('思考滚动', 'Reasoning scroll') },
        }, SettingsPage)
      })
    })
  }

  // ⑤ 自动展开/收起 + 工具过程并入（纯 DOM 驱动宿主自己的状态，异常不外冒）
  safeEffect('controller', function () {
    let stop = function () {}
    try {
      stop = controller.start()
    } catch (error) {
      try {
        console.warn('[laurel-reasoning-scroll] DOM 控制器起不来（自动展开/收起不可用）：' + String(error && error.message ? error.message : error))
      } catch (_consoleFailure) {
        /* 无 console 环境忽略 */
      }
      stop = function () {}
    }
    return function () {
      try {
        stop()
      } catch (_teardownFailure) {
        /* 收摊失败不阻断卸载 */
      }
    }
  })

  // ⑥ 卸下时把写在根节点上的东西一并清干净（否则停用后样式变量还赖着）
  safeEffect('root', function () {
    return function () {
      try {
        if (typeof document === 'undefined' || document.documentElement === null) return
        document.documentElement.style.removeProperty('--lrs-max-height')
        document.documentElement.removeAttribute('data-lrs-on')
      } catch (_cleanupFailure) {
        /* 清理失败无所谓 */
      }
    }
  })
}

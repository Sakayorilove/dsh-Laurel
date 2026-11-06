/**
 * laurel-context/owner —— 每会话历史压缩的所有者仲裁。
 *
 * 规则来自 04 规格 A：
 *  - 每会话只允许一个历史压缩 owner；
 *  - 开启 Laurel 之前必须先核宿主所有权，不能两个同时改同一段历史；
 *  - 仲裁只做判定与说明，不改任何配置（改配置是适配器/用户的事）。
 *
 * ## L08 修了什么（这份文件原来是三重阻断的第一重）
 *
 * 旧实现只看「宿主压缩提供者是否仍生效」这一个布尔量，于是：
 *   · 根层 `ctx.provide` 成功但 agent 在 isolate 组里看不到（`isolated-sibling`）
 *     → `hostActive:true` → **永远判 host**；
 *   · 换成 S8 的 preset 换装之后，agent 用的确实是 Laurel，**但根层这条会话仍然
 *     判盲**（组里 `isolate: {compaction:true}` 还在，只是组内那一行已经是 Laurel）
 *     → 依旧判 host，端点显示"宿主仍在压"，而实际上 Laurel 已经在压。
 *
 * 判断"谁在压"必须按**谁真正提供 agent 解析到的那份实现**，而不是按根层
 * provide 的可见性。所以现在多收两个输入：
 *   · `presetTakeover`      —— overlay 是否已经把预设组里的压缩提供者换成 Laurel；
 *   · `hostProviderSwapped` —— 根层/provider 是否已被 Laurel 换掉。
 * 任一为真 → `owner:"laurel"`。
 *
 * ## 优先级
 *
 * Laurel 已接管 > 宿主自带 > 关闭。仲裁只做判定与说明，不改任何配置。
 */

export const OWNERS = Object.freeze(['host', 'laurel', 'off'])

/** 宿主 provider 名视为"未启用"的取值。 */
const HOST_OFF = new Set([undefined, null, false, '', 'none', 'off', 'disabled', 'false'])

/**
 * 判定本会话历史压缩的 owner。
 *
 * @param {object}   input
 * @param {*}        [input.hostProvider]         宿主压缩提供者是否仍生效（false/off 表示已让位）
 * @param {boolean}  [input.hostProviderSwapped]  宿主 provider 是否已被 Laurel 换掉
 * @param {boolean}  [input.presetTakeover]       overlay 是否已换装预设组（S8 的落地证据）
 * @param {boolean}  [input.laurelEnabled]        Laurel 原生压缩是否启用
 */
export function resolveOwner(input = {}) {
  const {
    hostProvider,
    hostProviderSwapped = false,
    presetTakeover = false,
    laurelEnabled,
  } = input

  const conflicts = []
  if (typeof laurelEnabled !== 'boolean') {
    return {
      owner: 'off',
      reason: 'laurelEnabled 必须是布尔值；缺省不猜测为开启',
      conflicts: ['invalid-input'],
      hostActive: false,
      laurelTookOver: false,
    }
  }

  const hostActive = !HOST_OFF.has(hostProvider)
  // Laurel 是否真的接管了压缩。两个来源任一成立即算：
  //   · 预设组内部被换装（S8 的正解 —— 组内就是 Laurel，agent 天然看得见）
  //   · 根层 provider 已被换掉
  const laurelTookOver = presetTakeover === true || hostProviderSwapped === true

  const base = {
    hostActive,
    laurelTookOver,
  }

  if (!laurelEnabled) {
    return {
      owner: hostActive ? 'host' : 'off',
      reason: hostActive ? 'Laurel 原生压缩未启用，保留宿主压缩及自动触发器' : 'Laurel 压缩未启用：不摄取、不外置、不发布摘要',
      conflicts: [],
      ...base,
    }
  }

  if (laurelTookOver) {
    return {
      owner: 'laurel',
      reason: presetTakeover
        ? '预设组内的压缩提供者已被 overlay 换成 laurel-context/compaction：agent 解析到的就是 Laurel，历史改写权在 Laurel'
        : '宿主压缩提供者已被 Laurel 的实现替换：历史改写权在 Laurel',
      conflicts,
      via: presetTakeover ? 'preset-overlay' : 'provide',
      ...base,
    }
  }

  if (hostActive) {
    conflicts.push('laurel-vs-host')
    return {
      owner: 'host',
      reason: `宿主压缩提供者仍生效（${String(hostProvider)}）：历史改写权留在宿主`,
      conflicts,
      ...base,
      nextStep: '先关闭宿主 compaction 提供者，再让 Laurel 接管；否则会重复压缩并互相破坏锚点',
    }
  }

  return {
    owner: 'laurel',
    reason: '宿主压缩提供者已关闭、Laurel 已启用：由 Laurel 独占本会话历史压缩',
    conflicts,
    ...base,
  }
}

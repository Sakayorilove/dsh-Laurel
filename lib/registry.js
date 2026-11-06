/**
 * Built-in catalog seed and release inputs, not the complete runtime catalog.
 * id is the stable store/switch identity; dir is the source/archive directory; entry is the package name.
 * clientId identifies the original factory; managed clients use a content-based alias.
 * settingsId must match the module settings slot. Keep built-in titles/descriptions aligned with locale.
 * New official catalog entries can appear without rebuilding Center.
 */

/** @typedef {{ zh: string, en: string }} SubPluginText */
/** @typedef {{ id: string, dir: string, entry: string, clientId: string, title: SubPluginText, desc: SubPluginText, defaultOn: boolean, settingsId: string, client?: boolean }} SubPlugin */

/** @type {SubPlugin[]} */
export const SUB_PLUGINS = [
  {
    id: 'laurel',
    saveMode: 'instant',
    summary: { zh: '提醒提问、审批与完成事件。', en: 'Alerts for questions, approvals and completion.' },
    scope: { zh: '只负责把需要你处理的事件送到前台卡片或系统通知。', en: 'Delivers events through in-app cards or system notifications.' },
    category: 'experience', order: 50, keywords: ['通知', '提醒', 'notification'],
    dir: 'laurel',
    entry: 'laurel',
    clientId: 'laurel',
    settingsId: 'laurel',
    title: { zh: 'Laurel 通知', en: 'Laurel Notifications' },
    desc: { zh: '提醒提问、审批和完成事件。', en: 'Get reminders for questions, approvals, and completed work.' },
    defaultOn: false,
  },
  {
    id: 'memory-core',
    saveMode: 'apply',
    summary: { zh: '跨会话保存事实、要求与经验。', en: 'Keep facts, requirements and experience across conversations.' },
    scope: { zh: '记忆核心负责保存、检索与经验学习；当前对话的压缩由「上下文压缩」处理。', en: 'Stores and retrieves memory and experience. Context compression handles the current conversation.' },
    category: 'continuity', order: 10, keywords: ['记忆', '经验', 'skill', 'memory'],
    dir: 'laurel-memory',
    entry: 'laurel-memory',
    clientId: 'laurel-memory',
    settingsId: 'memory-core',
    title: { zh: '记忆核心', en: 'Memory core' },
    desc: { zh: '把记忆与经验学习合成一套：记录要求与项目现状、从修复中积累经验、按需形成 Skill。零推理可用，不接模型也能记录、检索、纠正、搬家。', en: 'Memory and experience learning in one store: record requirements and project state, build experience from fixes, form skills on demand. Works with zero inference.' },
    defaultOn: false,
  },
  {
    id: 'context-compress',
    saveMode: 'read-only',
    summary: { zh: '压缩当前对话，按需回读原文。', en: 'Compact the current conversation and retrieve original content.' },
    scope: { zh: '负责当前会话的体积与压缩，不代替记忆核心的长期知识管理。', en: 'Manages conversation size and compaction, separately from long-term memory.' },
    category: 'continuity', order: 20, keywords: ['压缩', '上下文', '原文', 'context'],
    dir: 'laurel-context',
    entry: 'laurel-context',
    clientId: 'laurel-context',
    settingsId: 'context-compress',
    title: { zh: '上下文压缩', en: 'Context compression' },
    desc: { zh: '长对话瘦身：大结果外置成稳定引用、按需回读原文、分级摘要。独立启停，记忆核心关掉也照样压缩。', en: 'Shrink long conversations: stable refs for large results, on-demand original readback, tiered summaries. Runs independently of the memory core.' },
    defaultOn: false,
  },
  {
    id: 'auto-continue',
    saveMode: 'instant',
    summary: { zh: '中断后自动继续，无人值守也能跑下去。', en: 'Resume interrupted turns automatically so long runs keep going.' },
    scope: { zh: '负责「这一轮没跑完就接着跑」与「有推荐项时替你选」。不裁历史、不管压缩、不约束子代理等待。', en: 'Resumes unfinished turns and answers recommended options. Does not compact history or cap subagent waits.' },
    category: 'execution', order: 10, keywords: ['自动继续', '续跑', '重试', 'auto-continue', 'resume'],
    dir: 'laurel-continue',
    entry: 'laurel-continue',
    clientId: 'laurel-continue',
    settingsId: 'auto-continue',
    title: { zh: '自动继续', en: 'Auto continue' },
    desc: { zh: '会话因超时或网络报错中断后自动续跑，可限定生效时段；提问带推荐项时自动选。与护栏、压缩共存不打架。', en: 'Resume a turn interrupted by a timeout or network error, optionally within chosen hours; auto-select a recommended option when asked. Yields to the guard and compaction modules.' },
    defaultOn: false,
  },
  {
    id: 'warden',
    saveMode: 'instant',
    summary: { zh: '约束等待、返工与并发修改。', en: 'Guard waits, repeated rework and concurrent changes.' },
    scope: { zh: '护栏负责执行约束、预算提醒和可选的工具输出归档；历史对话压缩在「上下文压缩」中查看。', en: 'Guards execution, budget nudges and optional tool-output archiving. Check Context compression for history compaction.' },
    category: 'execution', order: 40, keywords: ['护栏', '等待', 'guard'],
    dir: 'dsh-warden',
    entry: 'dsh-warden',
    clientId: 'dsh-warden',
    settingsId: 'warden',
    title: { zh: '内耗护栏', en: 'Friction guard' },
    desc: { zh: '减少无效等待、重复返工与上下文堆积。', en: 'Subagent wait caps, results to files, rework nudges, context watermark, shared-directory locks.' },
    defaultOn: false,
  },
  {
    id: 'reasoning-scroll',
    saveMode: 'instant',
    summary: { zh: '把思考过程收成限高滚动窗。', en: 'Turn reasoning output into a capped scroll window.' },
    scope: { zh: '只管「思考」这一块的显示方式：限高、淡出、贴底、何时展开收起；不裁剪内容，也不改模型说的话。', en: 'Only changes how the reasoning block is displayed: height cap, fade, auto-follow, expand/collapse. It never trims content.' },
    category: 'experience', order: 70, keywords: ['思考', '推理', '滚动', 'reasoning', 'scroll'],
    dir: 'laurel-reasoning-scroll',
    entry: 'laurel-reasoning-scroll',
    clientId: 'laurel-reasoning-scroll',
    settingsId: 'reasoning-scroll',
    title: { zh: '思考滚动窗', en: 'Reasoning scroll' },
    desc: { zh: '把「思考」的展开体做成限高滚动窗：渐变淡出、流式贴底、结束收起，可把工具过程也并进来。', en: 'Turns the reasoning block into a height-capped scroll window: faded text, auto-follow while streaming, collapses when done. Tool-call output can share the same cap.' },
    defaultOn: false,
  },
];

/**
 * 已退役、**不再作为模块出现**的旧包（2026-10-21 forge / 2026-10-23 strata）。
 *
 * `packages/<dir>/` 的源码还留在仓库里，但这几样不再进注册表，因此：
 *   · 不进 `cordis.patch.yml` 的 loader 树（没有行、没有 `disabled` 开关）；
 *   · 不出现在控制中心页面的行列表里（用户已经看不到、也点不动）；
 *   · 不进 profile 的依赖清单（安装器不会去链接它）。
 *
 * 为什么删掉而不是标 `supersededBy` 了事：`supersededBy` 只是**元数据**，
 * 页面上那一行照样渲染、开关照样可点。forge 在真实 profile 里从来没装过，
 * 它的开关只会返回 `operation-error` —— 留一行点不动的开关，比没有这一行更糟。
 *
 * ── strata 为什么也退役（2026-10-23，用户决定）──────────────────────────
 * 它与「记忆核心」**不共用数据**：存储分别是 `$DSH_HOME/strata/memories.jsonl`
 * 和 `$DSH_HOME/laurel-core`，两边都挂 `agent/pre-step` 与 `session/event`，
 * 工具名也是两套（`memory_*` vs `laurel_memory`）。同开等于两个采集器各写各的。
 * 原先这里写的「由治理声明仲裁」从未实现 —— 治理只覆盖 warden/strata 的
 * waitCap 与 waterLevelNudge，不碰记忆采集与注入。
 *
 * 旧数据**没有删**：仍在 `$DSH_HOME/strata/`，需要时用
 * `laurel-memory import-strata <仓> --file <memories.jsonl>` 迁进记忆核心。
 * 源码留在这里当回滚路径（想恢复：把这条加回 `SUB_PLUGINS` 与 patch 即可）。
 *
 * `dsh-tool-batch` 不是「退役」，它是**同仓但不属于装载机的独立插件**：
 * 由 profile 自己的 `cordis.patch.yml` 直接接线（`- id: tool-batch`），
 * 有自己的开关入口，与 Laurel 套件的模块清单无关。
 *
 * 这两个集合只用于让 `scripts/check.mjs` 的「注册表条目数 = packages/ 目录数」
 * 断言能区分「忘了登记的模块」和「故意不登记的东西」——它的本意是抓前者。
 */
export const RETIRED_DIRS = new Set(['dsh-forge', 'dsh-strata']);
export const UNRELATED_DIRS = new Set(['dsh-tool-batch']);

/**
 * `packages/` 下**有实体但不作为模块出现**的公共库。
 *
 * `laurel-core` 被上面几个子包共同 require（注册表推导、统一结果合同等），
 * 它没有设置页、没有开关、也不该出现在控制中心的行列表里 —— 它是被依赖的
 * 代码，不是用户能开的那一类功能。放在这里是为了让「孤儿目录」检测能区分
 * 「忘了登记的模块」和「本来就不登记的库」。
 */
export const SHARED_LIB_DIRS = new Set(['laurel-core']);

/** 按 id 取一条。 */
export function subPlugin(id) {
  return SUB_PLUGINS.find((p) => p.id === id) ?? null;
}

/** 全部 id。 */
export const SUB_IDS = SUB_PLUGINS.map((p) => p.id);

/** 首次加载时的默认开关表。 */
export function defaultEnabled() {
  return Object.fromEntries(SUB_PLUGINS.map((p) => [p.id, p.defaultOn]));
}

/** 把任意输入规整成完整、布尔化的开关表。 */
export function normalizeEnabled(input) {
  const out = defaultEnabled();
  if (input && typeof input === 'object') {
    for (const p of SUB_PLUGINS) {
      if (typeof input[p.id] === 'boolean') out[p.id] = input[p.id];
    }
  }
  return out;
}

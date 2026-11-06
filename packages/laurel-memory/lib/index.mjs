/**
 * laurel-memory —— 记忆核心入口。
 *
 * 一个模块、一套数据，两种内容视图：
 *   memory/     事实与日常工作（偏好/要求/现状/进展/流水）
 *   experience/ 经验生命周期（原始经历→候选→试用→正式→Skill）
 *
 * 两者共用 laurel-core 的事件来源、blob 仓、文本索引、revision 失效与搬家协议。
 */
export * as memory from './memory/index.mjs'
export * as experience from './experience/lifecycle.mjs'
export { makeRecord, correctRecord, revokeRecord, searchMemory, composeNotes, validateNotes, pageBody, findConflicts, TIER_BUDGET, stampUsedAt } from './memory/index.mjs'

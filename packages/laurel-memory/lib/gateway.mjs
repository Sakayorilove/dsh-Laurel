/**
 * laurel-memory/gateway —— 薄再导出层。
 *
 * 实现已经搬到 `laurel-core/lib/gateway.mjs`（D136）：laurel-context 也需要
 * 网关才能在没有模型时退回机械摘要，而 laurel-context 只依赖 laurel-core，
 * 不能反向依赖 laurel-memory（记忆核心关掉时压缩仍要能独立工作）。
 *
 * 这里保留再导出而不是删文件，是为了不动 laurel-memory 的对外导出表
 * （package.json 的 "./gateway" 与 cli.mjs 的 import 都还指着它）。
 * **不要在这里重新实现任何东西** —— 两份实现一定会漂。
 */
export * from '../../laurel-core/lib/gateway.mjs'

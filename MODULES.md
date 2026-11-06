# 模块清单与结构

Laurel 使用一个控制中心和独立模块的结构。源码仍在同一仓库维护，标准控制中心 tgz 不包含 `packages/`；每个模块单独生成带版本的 `.lmod`。`cordis.patch.yml` 只挂载控制中心，模块通过 `ctx.plugin()` 成为独立子 Fiber。

| 身份 | id | 源码目录 | 安装方式 |
|---|---|---|---|
| 控制中心 | laurel-center | lib | 原生 DSH 插件安装 |
| 通知 | laurel | packages/laurel | 模块商店 |
| 记忆核心 | memory-core | packages/laurel-memory | 模块商店 |
| 上下文压缩 | context-compress | packages/laurel-context | 模块商店 |
| 自动继续 | auto-continue | packages/laurel-continue | 模块商店 |
| 内耗护栏 | warden | packages/dsh-warden | 模块商店 |
| 思考滚动窗 | reasoning-scroll | packages/laurel-reasoning-scroll | 模块商店 |
| 隐藏公共库 | laurel-core | packages/laurel-core | 随依赖自动下载 |

版本以各自 `package.json` 为准。`lib/registry.js` 是内置种子与构建输入；远端官方目录提供运行时模块清单，可以添加新 id，无需更新控制中心。下架不自动删除本机模块，仍保留卸载入口。

## 生命周期与存储

代码位于 `<profile>/.laurel-modules/slots/<uuid>/packages/<dir>`；依赖公共库同槽保存。`installed.json` 保存活动版本与前一版本；`modules.json` 保存开关。首次下载默认关闭，用户启用后等待宿主与客户端 Fiber 激活。关闭、卸载和更新时分别释放生命周期，控制中心停用时统一清理。

模块配置、记忆与其他用户数据沿用原有目录。卸载只移除安装登记和开关，保留用户数据及代码缓存；重新安装后重新启用。数据格式不同的版本不会自动更新或回退，需要专门迁移。

## 添加或更新模块

1. 在 `packages/` 下创建独立包，填写 `name`、`version`、入口和客户端构建命令；保留 LICENSE 与第三方归属。不声明额外 Loader 行。
2. 在 `lib/registry.js` 登记稳定 id、目录、entry、clientId、settingsId 和双语文案。宿主入口导出 `apply` 与真实依赖 `inject`；客户端必须可独立释放。
3. 若依赖公共库，在包的 `laurel.dependencies` 中声明精确的 `{ id, version }`；当前只支持目录中的隐藏公共库，不在安装时运行包脚本或安装任意 npm 依赖。
4. 只改模块时升该模块版本，构建独立 client.js，完成模块流程验证。相同版本的发布字节不可改变。
5. 以已发布的可信目录为 `--previous` 构建候选；验证远端包后再发布目录。完整命令见 [模块商店设计](docs/module-store.md)。

开发用依赖应在构建时内联，或由已验证的宿主提供。客户端包名依赖通过宿主模块表解析，不能假设浏览器存在 npm 或任意 `require`。

# Laurel 插件合同

本文描述 1.9.2 模块商店候选。兼容声明限定 DSH 0.2.1-rc.5；内部 API 变更需要重新验证。旧版多 Loader 行、全量包和原生逐模块开关的描述属于历史实现，不适用于当前架构。

## 安装边界

标准 `laurel-center` 包只包含控制中心。`cordis.patch.yml` 只插入控制中心一行；不要给商店模块追加 Loader 行或修改 profile 的基础 `cordis.yml`。控制中心启停由宿主管理；模块启停保存在 profile 的 `.laurel-modules/modules.json`，由控制中心管理子 Fiber。

控制中心安装和更新使用原生 PluginManager。确认原生返回的 application 和安装后磁盘版本，不能将 RPC 封套的 `ok: true` 当作已生效。磁盘版本和运行版本不同必须提示重启。

## 宿主与客户端生命周期

模块宿主入口使用 `ctx.plugin(plugin)` 创建独立 Fiber，等待 `.await()` 且确认 active；停止时等待 dispose。不可直接调用 `apply(parentCtx)` 逃逸生命周期。安装事务与开关变更串行，任务运行时拒绝代码变更。

客户端 bundle 使用 classic script 的 `window.__ModuleLoader__.load({ id, factory })`，不能运行时 require 任意 npm 包。DSH rc.5 可以 import 已注册但没有 boot graph 行的 factory；重复注册相同 id 会失败。因此每份模块客户端以内容 hash 生成唯一别名，由 `ctx.get('modules')` 导入后作为独立子 Fiber 激活。共享的脚本 Promise 缓存跨控制中心 HMR 保留，生命周期挂载不共享。

`package.json` 的 `dsh.client.inject` 是包名和 boot graph 依赖；客户端 `exports.inject` 是真实服务名。依赖不满足不能宣称模块已启用。客户端清理包括设置插槽、事件、定时器和 DOM。

## HTTP 与认证

注册宿主路由不会自动继承原生认证。模块、商店、外观、壁纸等端点分别执行 `presentationAdmission` 和 `connection.admit(req)`，输入限制、字段白名单和具体资源权限不可省略。脚本标签无法自定义 UI header，脚本端点仅为同源脚本适配该标记，仍保留真实请求和原生鉴权，拒绝跨源与同站不同源请求。

## 发布与数据

模块使用精确版本的 `.lmod`，SHA256 和大小来自验证后的官方目录。版本发布后不可修改相同版本字节。依赖仅支持目录内隐藏公共库，下载后同槽解析；不执行安装脚本。用户数据不写进版本槽，卸载保留数据。旧全量安装首次使用迁移包，再切换到标准精简包。

## 验证范围

单元测试覆盖事务、归档、兼容与鉴权；专项浏览器验证使用真实 rc.5 ClientModuleSystem 和 Cordis，shell 插槽及 peer 边界受控；隔离冷启验证使用真实 rc.5 Loader、WebServer、PluginManager 和生产模块归档。它们不代替用户日常桌面 GUI 验收。开发和测试在 WSL；不要对 Windows 日常 profile 运行 Linux pnpm，不启动继承 Web DSH_HOME 的桌面客户端。

源码入口：`lib/module-store.js`、`module-store-api.js`、`modules.js`、`client/module-runtime.mjs`。发布协议与命令见 [module-store.md](module-store.md)。

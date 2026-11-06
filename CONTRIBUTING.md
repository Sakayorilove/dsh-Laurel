# 参与开发

欢迎 Issue 和 PR。这个仓库是「一个控制中心 + 七个模块」的单一开发仓库，每个包独立版本，模块的增删与登记步骤见 [MODULES.md](MODULES.md)。

## 环境

- **Node.js** `^22.19.0 || >=24.0.0`。CI 用 Node 22。
- **pnpm 11.28.3**（根 `package.json` 的 `packageManager` 已指定）。装依赖用
  `pnpm install --frozen-lockfile --ignore-scripts`；`--ignore-scripts` 是为了跳过
  Playwright 的浏览器下载，跑浏览器用例时再单独装。
- 建议在 **WSL2 / Linux** 下开发与跑测试。Windows 也能跑，但有一条用例需要符号链接权限
  （见下）。
- **不要**对着你正在使用的 DSH profile 跑 `pnpm install`。开发只在仓库里做；要试装，
  装打包出来的 tgz，或者用一个独立的 profile。

## 常用命令

```sh
pnpm install --frozen-lockfile --ignore-scripts
node --test tests/*.test.mjs         # 单元测试，不需要宿主
pnpm run build:client                # 重新生成 lib/client.js
pnpm run build:client:check          # 只比对产物与源码是否一致（CI 用这个）
pnpm run build:particle              # 重新生成粒子文档（需要素材别名表）
```

`tests/private-materials.test.mjs` 里有一条用例会建符号链接。Windows 没开开发者模式时会
报 `EPERM`，这是环境限制，不是代码问题：在 WSL 里跑，或以管理员身份运行。

## 改代码时的约定

- **内置种子与发布输入**：`lib/registry.js`。加模块、改标题在这里登记并保持模块 locale 一致；
  运行时目录可以新增模块，所有新下载模块默认关闭。
- **文案中英双写**：控制中心的 `title`/`desc` 必须与模块 `locale/*.json` 逐字一致，
  客户端面板和宿主原生插件页读的是同一份文案。
- **客户端产物要重建**：改 `lib/client/**` 后跑 `pnpm run build:client`，并确认
  `build:client:check` 通过，别手改 `lib/client.js`。
- **不要引入未声明的运行时 npm 依赖**：根包 `dependencies` 保持 `{}`，模块通过商店独立下载。
  公共库使用目录内的精确依赖；其他代码在构建时内联或使用已验证的宿主服务。
- **数据目录**：一律经 `$DSH_HOME` 解析，不要写死绝对路径。

## 提交前

仓库自带隐私扫描器（零依赖）：

```sh
node .github/privacy-guard/privacy-guard.mjs scan --all --fail-on medium
```

也可以装成本地钩子，提交时自动跑：

```sh
node .github/privacy-guard/privacy-guard.mjs install-hooks --repo .
```

它检查本机用户名与绝对路径、密钥、私钥、邮箱、内网地址、手机号、身份证号。CI 上同样会跑
（`.github/workflows/privacy-guard.yml`）。严格发布检查不读取宽泛 `.privacy-allow` 或按位置冻结的基线；确认为示例时才新增精确的文件／规则／内容哈希例外，并写明理由。真实隐私应移出仓库。

## PR

- 说明改动范围与理由；涉及行为的，写清楚前后差别。
- 附上你实际跑过的命令与结果（`node --test`、`build:client:check`）。
- 一次 PR 只做一件事；模块边界相关的改动请同时更新 [MODULES.md](MODULES.md)。

## 安全

发现安全问题不要开公开 Issue，按 [SECURITY.md](SECURITY.md) 的私密渠道报告。


## 私人资料与发布

- 新克隆后运行 `pnpm run privacy:setup`；钩子不会自动随 Git 克隆安装。
- 具体私有根、源码路径和运行安装记录写到仓库外的项目登记及本机 `AGENTS.local.md`，不写入公开文档。会话原文、截图、原始日志和个人素材保存在仓库外。
- 默认提交钩子扫描 index；推送钩子运行完整发布检查。CI 检查发生在上传之后，不能作为防止首次上传的措施。
- `pnpm run privacy:release` 检查当前源码、Git可达历史、构建一致性、单元测试、真正的 tgz 成员和解包内容；跳过关键文件、未审核的 medium/high 命中或成员异常都会失败。
- 发布检查依赖 Python 3、项目声明的 pnpm 和 Gitleaks。输出目录必须在仓库外；可通过 `LAUREL_RELEASE_OUTPUT` 指定。不要上传整个报告目录，其中包含本机路径和审计身份。
- 修改隐私工具后运行 `pnpm run privacy:test`，包括真实 Git 提交／推送和 worktree 反例。扫描通过不能替代新素材的许可审核或截图内容检查。
- 控制中心 tgz、独立模块 `.lmod`、旧版迁移包和版本目录分别构建；发布字节不可原地修改。
  仅模块更新和远端校验的命令见 [模块商店设计](docs/module-store.md)。构建不执行远程发布。

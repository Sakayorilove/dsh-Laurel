## 改了什么

<!-- 一两句说清楚；涉及某个模块就写清是哪个包 -->

## 为什么

<!-- 解决了什么问题；有 issue 就贴编号 -->

## 怎么验证的

<!-- 贴命令与结果。行为变更请写清验证方式；没验证的部分要标注 -->

- [ ] `node scripts/check.mjs` 全绿
- [ ] `node scripts/integration-probe.mjs` 全绿
- [ ] `node scripts/bootgraph-probe.mjs` 全绿
- [ ] `node scripts/module.mjs check` 无问题
- [ ] `node scripts/build-client.mjs --check` 一致

## 检查

- [ ] 没有引入本机路径、用户名、密钥或个人数据
- [ ] 没有手改构建产物（`lib/client.js` 等由脚本生成）
- [ ] 改了模块清单的话，`lib/registry.js`、`cordis.patch.yml`、客户端 locale 都同步了
- [ ] 相关文档（README / MODULES.md / CHANGELOG.md）已同步

/**
 * laurel-memory/redact —— 记忆入库前的凭据脱敏（纯函数、零副作用、可单测）。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────
 * 只读审计 `implementation/evidence/journal-audit-20261020.md` 的 P1-5 节实测：
 * 采集路径（`lib/capture.mjs` / `lib/adapter-dsh.mjs`）**全明文、零脱敏**，
 * `grep 'redact|mask|sanitize'` 在采集路径 0 命中；`laurel-core/lib/encrypt.mjs`
 * 只服务 export/restore，不覆盖写入路径。审计当天全仓 531 条 records 里凭据类
 * 命中是 0 —— 但那是「侥幸没记到」，不是「设计上不会记到」。用户在对话里粘一次
 * `.env`、贴一条 `curl -H 'Authorization: Bearer ...'`，就会被永久明文写进
 * `~/.dsh/laurel-core`。本模块补的就是这一步：**写盘之前**把已知形态的凭据换成
 * 稳定标记。
 *
 * ── 设计纪律 ────────────────────────────────────────────────────────
 *  1. 纯函数：不读文件、不写文件、不读环境变量、不联网、不打印（无 console）。
 *     同样的入参永远得到同样的出参。
 *  2. 幂等：`redact(redact(x))` 与 `redact(x)` 逐字节相同。标记 `[已脱敏:<类别>]`
 *     **不含**任何能再次命中规则的字符 —— 各规则的值字符集都排除了 `[` / `]`，
 *     另外「替换结果 === 原文」的候选会被直接丢弃，所以二次脱敏不会叠标记、
 *     也不会重复计数。
 *  3. 只脱敏、不改正文：不裁剪、不折叠空白、不重排、不做 Unicode 归一化。
 *     不含敏感信息的长文本脱敏后与原文本**逐字节相同**。
 *  4. 宁漏勿错：值太短、值本身就是模式文本、纯数字配置值，一律**不动**。
 *     记忆核心的价值是「可读的工作流水」，误伤正常代码比漏掉一个短值更糟。
 *  5. 一次扫描、按位置拼接：所有规则先在原文上收集候选，按「起点升序、同起点
 *     长者优先、同长度按规则优先级」贪心取不重叠的一批，再一次性拼出结果。
 *     因此 `hits[].index` 是**原文**下标（不是中间态下标），且不会出现
 *     「A 规则的替换改动让 B 规则匹配到标记内部」这种链式污染。
 *
 * ── 覆盖的形态（每类都有「该脱敏 / 不该脱敏」正反测试）───────────────
 *  * `private-key`    `-----BEGIN … PRIVATE KEY-----` 到 `-----END … PRIVATE KEY-----` 整块
 *                    （含 RSA / EC / OPENSSH / ENCRYPTED / PGP … BLOCK；未闭合的整段吃走）
 *  * `url-credential` `https://user:pass@host/…`
 *  * `url-query`      `?token=…` `?api_key=…` `?key=…` `?sig=…`
 *  * `auth-header`    `Authorization: Bearer/Basic/Token/Digest <凭据>`；裸 `Bearer <token>`
 *  * `api-key`        `sk-…` `sk-ant-…` `sk-proj-…` `ghp_/gho_/ghu_/ghs_/ghr_…`
 *                    `github_pat_…` `xoxb-/xoxp-/xoxa-/xoxr-/xoxs-…` `AKIA…`/`ASIA…`（AWS）`AIza…`（Google）
 *  * `jwt`            三段 base64url（`eyJ….….…`）
 *  * `assignment`     `password=` `passwd=` `secret=` `token=` `api_key=` `apikey=`
 *                    `access_key=` `private_key=` …（大小写不敏感，`:` 或 `=`，可带引号）
 *  * `dotenv`         `SOMETHING_SECRET=值` 整行（保留变量名，值换成标记）
 *
 * ── 规则重叠时谁赢 ──────────────────────────────────────────────────
 * 按「起点升序 → 跨度长者优先 → 同长按规则顺序」贪心取不重叠的一批。所以
 * `DB_PASSWORD=值` 这种整行在 `.env` 规则（保留变量名、吃掉整行尾部）下命中
 * `dotenv` 而不是 `assignment`；`GITHUB_TOKEN=ghp_…` 同理整行算 `dotenv`，
 * 而单独的 `ghp_…` 算 `api-key`。`hits[].category` 因此反映的是**最终选中**的
 * 那条规则，不是所有匹配过的规则。
 *
 * ── 已知边界：会漏的地方（诚实登记，不假装解决了）─────────────────────
 *  a. **无前缀的裸随机串**：32/40/64 位 hex、UUID、自定义随机 token。没有上下文
 *     时与 commit hash / SHA256 / 时间戳无法区分，宁可不动。审计报告点名的
 *     `password` 74 处「模式字面量」就是这一类：`'password='` 这种字符串本身
 *     后面没有值，规则根本不会命中；而 `needPassword: true`、`db_password: 'z'`
 *     因为值太短（< 阈值）或值不是密钥形态而被主动跳过。
 *  b. **值长度不足阈值**：赋值式 < 5 字符（带引号 < 4）、`.env` < 6 字符、
 *     `Authorization` < 4 字符、`Bearer` 裸出现 < 8 字符。真实的
 *     `db_password: 'z'` 就是这种，会漏。
 *  c. **纯数字的 `.env` 值**：`PASSWORD=60000` 与 `TIMEOUT=60000` 无法区分，
 *     `.env` 规则主动跳过纯数字（赋值式规则仍可能兜住 `PASSWORD=60000`）。
 *  d. **裸 `Bearer` 后全字母的 token**：裸 Bearer 规则要求 token 里至少有一个
 *     数字，否则 `Bearer authentication` 这种英文短语会被误伤。带 schema 的
 *     `Authorization:` 头不受此限。
 *  e. **值里带 `(` `)` `[` `]` `{` `}` `<` `>` `&` `,` `;` `|` `\` 反引号 引号
 *     的**：这些字符在代码里更像模式文本/表达式，主动排除 → 这类密钥会漏。
 *  f. **被换行折断的 PEM**（只有 BEGIN 没有 END）：按「未闭合」处理，把 BEGIN
 *     之后**全部文本**一起打码（宁可多删一段，也不留半把钥匙）。这是唯一一处
 *     会吃掉大段正文的情况。
 *  g. **中文/空格夹带、跨行的密钥**、**非字符串字段**（Buffer/二进制 blob）、
 *     **`sk-` 后带连字符但不属于已知子前缀的旧式 key**（`sk-xxx-yyy`，因为
 *     `risk-assessment-tools` 这种英文 kebab 短语会被误伤）。`sk-` 的裸形式
 *     门槛提到 **32 位**（`sk-ant-` / `sk-proj-` 仍按 16 位）：20 位阈值会误伤
 *     本仓真实存在的插件 skill id（形如 `sk-` + 20 位 hex）。
 *  h. 本模块**不处理**用户名与绝对路径（`C:\Users\<名>`、`/home/<名>`、163 条
 *     绝对路径）。那是 P1-5 的另一半，属于「可读性占位符」而不是「凭据」，
 *     语义与替换策略不同，留给接线方单独立规则，这里不越界。
 *  会误伤的地方：
 *  i. **变量赋值**：严格说只有「值看起来像字面量」才打码，以下已主动放过 ——
 *     紧跟 `(` `.` `[` `{` `?` 或运算符（表达式）、点分成员链（`req.body.token`）、
 *     正则字面量（`TOKEN = /.../gi`）、PEM 前缀、占位词。但
 *     `token = literalValue`（值是裸字面量）仍会被打码 —— 无法区分「配置里的
 *     真 token」与「代码里的常量名」。这是本模块**最主要的误伤面**。
 *  j. `SECRET_REGEX = "..."` 这类全大写常量行会被 `dotenv` 规则整值打码
 *     （除非值本身是正则字面量或 shell 命令替换）。
 *  k. `?key=value` 这类普通查询参数：`key` 保留在名单里（API 常用它传密钥），
 *     所以公开的 `?key=public-value` 会被打码（已知误伤，换取覆盖）。
 *  l. `scheme://user:pass@` 形态打码，但**文档占位符整体放过**：用户名是
 *     `user`/`username`/`login` 且密码是 `pass`/`password`/`pwd`/`secret`/`token`
 *     的组合（`https://user:pass@host`）视为示例，不打码。
 *  m. 形如 `sk-` + 32 位以上纯字母数字的普通标识符会被打码（概率极低）。
 *  n. **省略号/星号占位**不打码：`Bearer ...`、`?sig=…`、`token=***`、
 *     `Authorization: Bearer <token>`（整体尖括号包裹）—— 一个 ASCII 字母数字
 *     都没有的值被判定为占位符。真密钥不会长成这样。
 *  o. **`.env` 行里的值若是 shell 命令替换**（`KEY="$(cat "$FILE")"`）不打码：
 *     它是指向密钥的指针，不是密钥本身。
 */

/** 脱敏规则版本。规则语义一变就 +1，已落盘的旧记录据此判断是否需要重跑。 */
export const REDACT_VERSION = 1

/** 标记前缀。所有替换结果都是 `[已脱敏:<类别>]`。 */
const MARK_PREFIX = '[已脱敏:'

/** 生成稳定标记。标记里不得出现任何能被规则再次命中的字符（见文件头第 2 条）。 */
const mark = (category) => `${MARK_PREFIX}${category}]`

/** 该值是否已经是一个标记（用于幂等短路，避免重复计数）。 */
const isMarked = (value) => typeof value === 'string' && value.startsWith(MARK_PREFIX)

/**
 * 赋值式密钥的**名字**集合。
 * 只放行明确是凭据的名字；**不放行裸 `key`** —— `key = nextKey` 在代码里太常见。
 * `api[_-]?key` / `apikey` / `access_key` 等复合名允许带 `_` 前缀（`DB_PASSWORD`、
 * `GITHUB_TOKEN` 都要能命中），所以名字前的 lookbehind 只排除字母数字、不排除 `_`。
 */
const SECRET_NAME = [
  'password', 'passwd', 'passphrase',
  'secret', 'client_secret', 'secret_key',
  'token', 'access_token', 'refresh_token', 'auth_token', 'session_token', 'id_token',
  'api[_-]?key', 'apikey', 'access_key', 'private_key', 'signing_key',
  'encryption_key', 'master_key',
].join('|')

/** 值前的边界：前面不能是字母数字（`_` 允许，见上）。 */
const NAME_BOUNDARY = '(?<![A-Za-z0-9])'

/**
 * 「看起来是占位符而不是真密钥」的值。命中就**不脱敏**。
 * 全部小写比较，避免 `needPassword: true` 这种被误伤。
 */
const PLACEHOLDER_RE =
  /^(?:true|false|null|undefined|none|nil|nan|todo|tbd|changeme|change_me|example|placeholder|redacted|password|secret|token|x{4,}|\*{3,}|-{3,}|\.{2,})$/i

/** 文档/示例里当占位符用的 URL 用户信息（`https://user:pass@host`）。 */
const URL_PLACEHOLDER_USER_RE = /^(?:user|username|usr|login|your[_-]?user(?:name)?)$/i
const URL_PLACEHOLDER_PASS_RE = /^(?:pass|password|passwd|pwd|secret|token|your[_-]?pass(?:word)?)$/i

/**
 * 「像成员访问链」的值：`req.body.password`、`this.state.token`。
 * 每一段都是普通标识符，且**不含数字**那种随机感 —— 真密钥几乎不会长成
 * 纯小写点分标识符。命中就不打码（见文件头边界 i）。
 */
const MEMBER_CHAIN_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/

/**
 * 「是正则字面量」的值：`/.../gi`、`/^token$/`、`/\s+/`。
 * 源码里 `TOKEN = /.../gi` 这种不能当密钥打码（审计报告点名的「模式文本」）。
 */
const REGEX_LITERAL_RE = /^\/.*\/[dgimsuvy]*$/

/**
 * 「是 shell 命令替换 / 占位引用」的值：`$(cat "$KEYFILE")`、`` `op read x` ``。
 * `.env` 规则要放过这些 —— 它们是指向密钥的**指针**，不是密钥本身。
 */
const SHELL_SUBST_RE = /^(?:\$\(|`|\$\{)/

/**
 * 一个字面量要算「像密钥」，得同时满足两条：
 *  1. 至少有一个 ASCII 字母或数字 —— 挡掉 `Bearer ...`、`?sig=…`、`token=***`
 *     这类**省略号/星号占位**（真密钥不可能一个字母数字都没有）；
 *  2. 不是整体被尖括号包住 —— 挡掉 `<redacted>`、`<your-token-here>` 这类
 *     文档/日志里的显式占位写法。
 */
const looksLikeSecret = (value) => /[A-Za-z0-9]/.test(value) && !/^<[^<>]*>$/.test(value)

/**
 * 规则表。**顺序即优先级**（同起点同长度时靠前者胜）。
 * 每条规则的 `sub(m)` 返回替换串；返回 `null` 表示「这条不算命中」（主动跳过）。
 * 所有正则都带 `g`、都避免 `(.*)+` 这类可灾难性回溯的结构；PEM 的懒匹配有
 * 20000 字符上界。
 */
const RULES = [
  /* ── 1. PEM 私钥整块。两条规则：闭合的整块 + 未闭合的尾巴，同类别。 ── */
  {
    id: 'private-key',
    re: /-----BEGIN[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,20000}?-----END[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----/g,
    sub: () => mark('private-key'),
  },
  {
    id: 'private-key',
    re: /-----BEGIN[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*$/g,
    // 上一条规则已经覆盖「有 END」的块；这条只负责真的没闭合的尾巴。
    // 若这段里其实出现了 END（说明是闭合块，尾部正文不该被吃掉）→ 主动放弃。
    sub: (m) => (/-----END[ A-Z0-9]*PRIVATE KEY/.test(m[0]) ? null : mark('private-key')),
  },

  /* ── 2. URL 内嵌账号密码：`scheme://user:pass@host`。 ──
   * 用户信息里排除 `[` `]` `:` `/` `@` 与引号，所以打完码之后
   * `https://[已脱敏:url-credential]@host` 不会再被同一条规则命中。 */
  {
    id: 'url-credential',
    re: /\b([A-Za-z][A-Za-z0-9+.\-]{1,15}:\/\/)([^\s/@:[\]{}<>"'`\\]{1,64}):([^\s/@:[\]{}<>"'`\\]{1,128})@/g,
    sub: (m) => {
      // 文档里的占位符整体放过：`https://user:pass@host` 这类写法在我们自己的
      // 审计与说明里到处都是，打码只会让文档不可读（见文件头「误伤」l）。
      if (URL_PLACEHOLDER_USER_RE.test(m[2]) && URL_PLACEHOLDER_PASS_RE.test(m[3])) return null
      if (!looksLikeSecret(m[3])) return null
      return `${m[1]}${mark('url-credential')}@`
    },
  },

  /* ── 3. URL 查询参数里的凭据。保留参数名（可读性 + 幂等）。 ──
   * `key` 保留在名单里：很多 API 用 `?key=` 传密钥（边界 k）。 */
  {
    id: 'url-query',
    re: /[?&](token|access_token|api_key|apikey|key|secret|password|passwd|sig|signature|auth)=([^\s&#"'`[\]{}<>]{4,})/gi,
    sub: (m) => {
      if (isMarked(m[2]) || !looksLikeSecret(m[2])) return null
      return `${m[0][0]}${m[1]}=${mark('url-query')}`
    },
  },

  /* ── 4. Authorization 头（带 schema）。不要求 token 含数字：Basic 的 base64
   * 可能全字母（`YWRtaW46YQ==`），这里宁严不漏。 ── */
  {
    id: 'auth-header',
    re: /authorization["']?[ \t]*[:=][ \t]*["'`]?(?:bearer|basic|token|digest)[ \t]+([^\s"',;`[\]{}()<>]{4,})/gi,
    sub: (m) =>
      isMarked(m[1]) || !looksLikeSecret(m[1])
        ? null
        : m[0].slice(0, m[0].length - m[1].length) + mark('auth-header'),
  },

  /* ── 5. 裸 `Bearer <token>`（curl 里最常见的一种贴法）。 ──
   * 要求 token 里至少有一个数字，否则 `Bearer authentication` 这种英文短语会被误伤；
   * 代价是全字母的裸 token 会漏（边界 d）。 */
  {
    id: 'auth-header',
    re: /\bBearer[ \t]+([A-Za-z0-9._~+/=\-]{8,})/g,
    sub: (m) => {
      if (isMarked(m[1])) return null
      if (!/\d/.test(m[1])) return null
      return m[0].slice(0, m[0].length - m[1].length) + mark('auth-header')
    },
  },

  /* ── 5. 裸 `Bearer <token>`（curl 里最常见的一种贴法）。 ──
   * 要求 token 里至少有一个数字，否则 `Bearer authentication` 这种英文短语会被误伤；
   * 代价是全字母的裸 token 会漏（边界 d）。 */
  {
    id: 'auth-header',
    re: /\bBearer[ \t]+([A-Za-z0-9._~+/=\-]{8,})/g,
    sub: (m) => {
      if (isMarked(m[1])) return null
      if (!/\d/.test(m[1])) return null
      return m[0].slice(0, m[0].length - m[1].length) + mark('auth-header')
    },
  },

  /* ── 6. 常见厂商 key 字面量。 ──
   * `sk-` 只放行「已知子前缀」或「≥32 位纯字母数字」：裸 `sk-[A-Za-z0-9_-]{16,}`
   * 会把 `risk-assessment-tools` 这类英文 kebab 短语打掉，而 20 位阈值又会误伤
   * 本仓的插件 skill id（形如 `sk-` + 20 位 hex，审计报告里已有登记）。
   * 真·旧式 OpenAI key 是 `sk-` + 48 位，32 位门槛留了余量（边界 g）。 */
  {
    id: 'api-key',
    re: /(?<![\w-])(?:sk-ant-[A-Za-z0-9_-]{16,}|sk-proj-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{32,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|A[KS]IA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})/g,
    sub: () => mark('api-key'),
  },

  /* ── 7. JWT：三段 base64url，第一段以 `eyJ`（`{"` 的 base64）开头。 ── */
  {
    id: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    sub: () => mark('jwt'),
  },

  /* ── 8. 赋值式密钥（带引号）。值 ≥4 字符，保留名字/分隔符/引号，只换值。 ── */
  {
    id: 'assignment',
    re: new RegExp(
      `${NAME_BOUNDARY}(${SECRET_NAME})([ \\t]*[:=][ \\t]*)(["'\`])([^"'\\\`\\[\\]\\s]{4,})\\3`,
      'gi',
    ),
    sub: (m) => {
      const value = m[4]
      if (isMarked(value) || PLACEHOLDER_RE.test(value)) return null
      return `${m[1]}${m[2]}${m[3]}${mark('assignment')}${m[3]}`
    },
  },

  /* ── 9. 赋值式密钥（不带引号）。值 ≥5 字符。 ──
   * 值字符集**只收 ASCII 键字符**（排除中文、空白、引号、括号、`&` `,` `;` `|` `\`）：
   * 否则 `password= 这种字样与` 这种「中文散文紧跟一个等号」会被当成密钥 ——
   * 本机实测就踩过（`password=` 后面跟中文句子）。代价是真的中文口令会漏（边界 b）。 */
  {
    id: 'assignment',
    re: new RegExp(
      `${NAME_BOUNDARY}(${SECRET_NAME})([ \\t]*[:=][ \\t]*)([A-Za-z0-9!$%^*_+.\\/~=@#-]{5,})`,
      'gi',
    ),
    sub: (m, text) => {
      const value = m[3]
      if (isMarked(value) || PLACEHOLDER_RE.test(value)) return null
      // 交给 PEM 规则整块处理，别把 `private_key=-----BEGIN` 打成半截（边界见文件头）。
      if (/^-{2,}/.test(value)) return null
      // 值是正则字面量（`TOKEN = /.../gi`）→ 这是模式文本，不是密钥。
      if (REGEX_LITERAL_RE.test(value)) return null
      // 紧跟 `(` `.` `[` `?` `{` 的是**表达式/成员访问**（`token = readEnv(...)`,
      // `secret = obj.password`），不是密钥字面量 —— 打了码就把代码读废了（边界 i）。
      // 中间允许若干空格：`secret = apiKey ?? resolveSecret(...)` 也算表达式。
      if (/^[ \t]*(?:[.([?{+\-*/%<>=&|,;:]|\?\?)/.test(text.slice(m.index + m[0].length))) return null
      if (MEMBER_CHAIN_RE.test(value)) return null
      return `${m[1]}${m[2]}${mark('assignment')}`
    },
  },

  /* ── 10. `.env` 风格整行：全大写变量名 + `=` + 值。保留变量名。 ──
   * 值 ≥6 字符且不是纯数字（否则 `TIMEOUT=60000` 也会被打掉，边界 c）。 ── */
  {
    id: 'dotenv',
    re: /^[ \t]*(?:export[ \t]+)?([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*)[ \t]*=[ \t]*(\S.{3,})$/gm,
    sub: (m) => {
      const value = m[2].trim()
      if (value.length < 6) return null
      if (/^\d+$/.test(value)) return null
      if (!looksLikeSecret(value)) return null
      if (isMarked(value)) return null
      // `export KEY="$(cat "$KEYFILE")"` 里的值是指向密钥的指针，不是密钥本身。
      if (SHELL_SUBST_RE.test(value.replace(/^["']|["']$/g, ''))) return null
      // `COMMAND_TOKEN = /(?:^|\s)(git|node)\b/gi` —— 值是正则字面量（模式文本）。
      if (REGEX_LITERAL_RE.test(value)) return null
      return `${m[1]}=${mark('dotenv')}`
    },
  },
]

/** 所有出现过的类别（去重、稳定顺序）。 */
export const REDACT_CATEGORIES = Object.freeze([...new Set(RULES.map((r) => r.id))])

function emptyCounts() {
  const counts = {}
  for (const id of REDACT_CATEGORIES) counts[id] = 0
  return counts
}

/**
 * 在原文上收集候选并按位置挑选不重叠的一批。
 * 复杂度：O(规则数 × 文本长度)，没有嵌套回溯；8000 字符量级远在毫秒内。
 */
function collectMatches(text) {
  const candidates = []
  for (let priority = 0; priority < RULES.length; priority++) {
    const rule = RULES[priority]
    const re = rule.re
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) {
      const raw = m[0]
      if (raw.length === 0) {
        // 兜底：理论上每条规则都要求至少 4 个字符，不会空匹配。
        re.lastIndex += 1
        continue
      }
      const replacement = rule.sub(m, text)
      // null = 这条候选主动放弃（占位符 / 太短 / 已脱敏）；相同的替换 = 已经打过码，
      // 跳过它既保证幂等，也保证第二遍的 hits/counts 与第一遍一致。
      if (typeof replacement !== 'string' || replacement === raw) {
        // 放弃时只前进 1 个字符，让「超大跨度但被否决」的候选（如未闭合 PEM 规则
        // 吃到了含 END 的整段）不会掩盖后面真正该命中的起点。
        re.lastIndex = m.index + 1
        continue
      }
      candidates.push({ category: rule.id, start: m.index, end: m.index + raw.length, replacement })
    }
  }
  candidates.sort((a, b) => a.start - b.start || b.end - a.end)
  const accepted = []
  let cursor = 0
  for (const c of candidates) {
    if (c.start < cursor) continue
    accepted.push(c)
    cursor = c.end
  }
  return accepted
}

/**
 * 对一段文本做脱敏。
 *
 * @param {string} text 原文（非字符串原样返回，不做任何转换）
 * @param {{ enabled?: boolean }} [options] `enabled:false` 时原样返回、`hits` 为空
 * @returns {{ text: string, hits: Array<{ category: string, index: number }>, counts: Record<string, number> }}
 *   `hits[].index` 是**原文**下标；顺序按 index 升序。`counts` 每类命中数（含 0）。
 */
export function redactText(text, options = {}) {
  const { enabled = true } = options ?? {}
  if (typeof text !== 'string') return { text, hits: [], counts: {} }
  if (enabled === false) return { text, hits: [], counts: {} }

  const accepted = collectMatches(text)
  if (accepted.length === 0) return { text, hits: [], counts: emptyCounts() }

  const counts = emptyCounts()
  const hits = []
  const parts = []
  let cursor = 0
  for (const c of accepted) {
    if (c.start > cursor) parts.push(text.slice(cursor, c.start))
    parts.push(c.replacement)
    cursor = c.end
    hits.push({ category: c.category, index: c.start })
    counts[c.category] += 1
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return { text: parts.join(''), hits, counts }
}

/** 只对普通对象/数组/字符串递归；其它类型（Date/RegExp/Map/Buffer…）原样返回。 */
function redactValue(value, options) {
  if (typeof value === 'string') return redactText(value, options).text
  if (Array.isArray(value)) return value.map((item) => redactValue(item, options))
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return value
    const out = {}
    for (const [key, inner] of Object.entries(value)) out[key] = redactValue(inner, options)
    return out
  }
  return value
}

/**
 * 对一条记录里**所有字符串值**做脱敏，返回新对象（深拷贝，绝不修改入参）。
 *
 * 只处理值，不处理**键名**（`{ token: '…' }` 的 `token` 是结构，改了会破坏记录形状）。
 * 需要诊断信息（命中类别/位置）时先用 `redactText` 单独跑一遍正文。
 *
 * @param {unknown} record 记录对象（普通对象/数组/字符串皆可）
 * @param {{ enabled?: boolean }} [options]
 * @returns {unknown} 新对象；`options.enabled === false` 时返回等值深拷贝
 */
export function redactRecord(record, options = {}) {
  return redactValue(record, options ?? {})
}

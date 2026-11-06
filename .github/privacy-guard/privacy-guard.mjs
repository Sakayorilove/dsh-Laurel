#!/usr/bin/env node
// privacy-guard — 开源前的隐私/敏感信息确定性扫描器（零依赖，Node >= 18）
// 设计目标：把"这段字符串算不算隐私"的一次性判断，固化成可复用的正则规则集，
// 之后每次提交/推送都由本机毫秒级、零 token 完成检查。
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const SEV_ORDER = { low: 1, medium: 2, high: 3 };
const MAX_DISPLAY = 200;
const REGEX_META = ['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\\\'];

const HELP = [
  'privacy-guard — 开源前隐私/敏感信息扫描器（零依赖）',
  '',
  '用法：',
  '  node privacy-guard.mjs scan   [选项]        扫描并报告（默认 --all）',
  '  node privacy-guard.mjs fix    [选项]        把可修复命中替换成占位符（改工作区文件）',
  '  node privacy-guard.mjs history [选项]       扫描全部 git 历史的新增行',
  '  node privacy-guard.mjs authors [选项]       列出历史上出现过的作者名/邮箱',
  '  node privacy-guard.mjs init   [选项]        自动探测本机身份，生成 ~/.privacy-guard/local.rules.json',
  '  node privacy-guard.mjs install-hooks --repo <路径>   安装 pre-commit / pre-push 钩子',
  '  node privacy-guard.mjs selftest             自检（在临时仓库里验证检测能力）',
  '',
  '扫描范围（互斥，默认 --all）：',
  '  --staged            只扫将要提交的内容（读 index，pre-commit 用）',
  '  --all               扫已跟踪 + 未跟踪且未被 gitignore 的文件',
  '  --range <a..b>      扫某段 git 区间改动的文件（增量）',
  '  --since <ref>       扫 <ref>..HEAD 改动的文件（增量）',
  '',
  '其它选项：',
  '  --repo <路径>       目标仓库（默认当前目录）',
  '  --fail-on <级别>    high|medium|low|none   命中该级别及以上时退出码 1（默认 medium）',
  '  --json              机器可读输出（不含命中原文）',
  '  --strict            不使用按序号基线或宽泛文件豁免',
  '  --directory         直接扫描指定目录，忽略 Git 边界（解包产物使用）',
  '  --quiet             只输出汇总',
  '  --no-baseline       忽略 .privacy-guard-baseline.json',
  '  --no-allow          忽略 allow 规则（排查"为什么没报"时用）',
  '  --max-bytes <n>     单文件扫描上限（默认 16777216）',
  '  --include-ignored   连 .gitignore 掉的文件也扫（发布前体检用）',
  '',
  '规则来源（按顺序叠加）：<工具目录>/rules/generic.rules.json',
  '  -> ~/.privacy-guard/local.rules.json -> <repo>/.privacy-guard.rules.json（后两者都不该提交）',
].join('\n');

function die(msg, code) {
  process.stderr.write('privacy-guard: ' + msg + '\n');
  process.exit(code === undefined ? 2 : code);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fix') { out.fix = true; continue; }
    if (a.slice(0, 2) === '--') {
      const eq = a.indexOf('=');
      if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && next.slice(0, 2) !== '--') { out[key] = next; i++; }
      else { out[key] = true; }
    } else { out._.push(a); }
  }
  return out;
}

function git(repo, args, opts) {
  const o = Object.assign({ cwd: repo, maxBuffer: 512 * 1024 * 1024, encoding: 'utf8' }, opts || {});
  return execFileSync('git', args, o);
}

function gitOk(repo, args) {
  try { return git(repo, args, {stdio:['ignore','pipe','pipe']}); } catch (e) { return null; }
}

function isGitRepo(dir) {
  try { return execFileSync('git', ['rev-parse', '--git-dir'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0; }
  catch (e) { return false; }
}

const FS_SKIP = ['.git', 'node_modules', '.cache', '$RECYCLE.BIN', '.pnpm-store'];

function walkFs(root, rel, out, depth) {
  if (depth > 100 || out.length > 50000) die('文件遍历超出上限，扫描未完成');
  let ents;
  try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch (e) { die('无法枚举目录：' + rel); }
  for (const e of ents) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) { if (FS_SKIP.indexOf(e.name) >= 0) continue; walkFs(root, r, out, depth + 1); }
    else if (e.isFile() || e.isSymbolicLink()) out.push(r);
  }
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function mask(s) {
  return '[REDACTED len=' + String(s).length + ']';
}
function fingerprint(s) { return createHash('sha256').update(s).digest('hex'); }

function toRegExp(pattern, flags) {
  let p = String(pattern);
  let fl = flags || '';
  if (p.slice(0, 4) === '(?i)') { p = p.slice(4); if (fl.indexOf('i') < 0) fl += 'i'; }
  return new RegExp(p, fl);
}

function regexEscape(s) {
  let out = '';
  for (const c of String(s)) out += REGEX_META.indexOf(c) >= 0 ? '\\' + c : c;
  return out;
}

// ---------- 规则 ----------
function compileRules(ruleSets) {
  const rules = [];
  const allow = [];
  for (const set of ruleSets) {
    if (!set.doc) continue;
    const list = Array.isArray(set.doc.rules) ? set.doc.rules : [];
    for (const r of list) {
      if (!r || !r.pattern) continue;
      let re;
      try {
        re = new RegExp(r.pattern, (r.flags || '').indexOf('g') >= 0 ? (r.flags || '') : (r.flags || '') + 'g');
      } catch (e) {
        die('规则 ' + (r.id || '?') + ' 正则非法（' + set.name + '）：' + e.message);
      }
      rules.push({
        id: r.id || 'unnamed',
        severity: (r.severity || 'medium').toLowerCase(),
        description: r.description || '',
        source: set.name,
        re: re,
        placeholder: r.placeholder || null,
        fixable: r.fixable === true && !!r.placeholder,
        allowPatterns: (r.allow || []).map(function (p) { return toRegExp(p, 'i'); }),
      });
    }
    const g = Array.isArray(set.doc.allowPatterns) ? set.doc.allowPatterns : [];
    for (const p of g) allow.push(toRegExp(p, 'i'));
  }
  return { rules: rules, allow: allow };
}

function privacyHome() {
  return process.env.PRIVACY_GUARD_HOME || path.join(os.homedir(), '.privacy-guard');
}

function loadRules(repo) {
  const sets = [{ name: 'generic', doc: readJson(path.join(TOOL_DIR, 'rules', 'generic.rules.json')) }];
  const localPath = path.join(privacyHome(), 'local.rules.json');
  if (fs.existsSync(localPath)) sets.push({ name: 'local', doc: readJson(localPath) });
  const repoRules = path.join(repo, '.privacy-guard.rules.json');
  if (fs.existsSync(repoRules)) sets.push({ name: 'repo', doc: readJson(repoRules) });
  const compiled = compileRules(sets);
  return { rules: compiled.rules, allow: compiled.allow, sources: sets.map(function (s) { return s.name; }) };
}

function allowFilePatterns(repo) {
  const p = path.join(repo, '.privacy-allow');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\r?\n/)
    .map(function (l) { return l.trim(); })
    .filter(function (l) { return l && l.slice(0, 1) !== '#'; })
    .map(function (l) { try { return toRegExp(l, ''); } catch (e) { return null; } })
    .filter(Boolean);
}

function exactExceptions(repo, args) {
  if (args['no-allow']) return [];
  const file = args.exceptions ? path.resolve(args.exceptions) : path.join(repo, '.privacy-exceptions.json');
  if (!fs.existsSync(file)) return [];
  const entries = readJson(file).entries;
  if (!Array.isArray(entries) || entries.some(e => !e.file || !e.rule || !/^[a-f0-9]{64}$/.test(e.sha256) || !e.reason)) die('精确例外格式不正确');
  return entries;
}

// ---------- 文件收集 ----------
function listFiles(repo, args) {
  const mode = args.staged ? 'staged' : (args.range || args.since) ? 'range' : 'all';
  const seen = new Set();
  const out = [];
  const push = function (p) { if (p && !seen.has(p)) { seen.add(p); out.push(p); } };
  const splitZ = function (raw) { return raw.split('\u0000').filter(Boolean); };
  if (!isGitRepo(repo)) {
    if (mode !== 'all') die('非 git 目录只支持 --all；当前用了 --staged / --range');
    const out2 = [];
    walkFs(repo, '', out2, 0);
    return { mode: 'fs', files: out2 };
  }

  if (mode === 'staged') {
    const raw = git(repo, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']);
    splitZ(raw).forEach(push);
    return { mode: mode, files: out };
  }
  if (mode === 'range') {
    const spec = args.range || (args.since + '..HEAD');
    let raw;
    try { raw = git(repo, ['diff', '--name-only', '--diff-filter=ACMR', '-z', spec]); }
    catch (e) { die('无效的 range：' + spec); }
    splitZ(raw).forEach(push);
    splitZ(git(repo, ['ls-files', '-o', '--exclude-standard', '-z'])).forEach(push);
    return { mode: mode, spec: spec, files: out };
  }
  const extra = args['include-ignored'] ? ['-c', '-o'] : ['-c', '-o', '--exclude-standard'];
  splitZ(git(repo, ['ls-files', '-z'].concat(extra))).forEach(push);
  return { mode: 'all', files: out };
}

function readTarget(repo, rel, args, mode) {
  const abs = path.join(repo, rel);
  const maxBytes = Number(args['max-bytes'] || 16777216);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) die('--max-bytes 必须是正整数');
  if (mode === 'staged') {
    let buf;
    try { buf = git(repo, ['show', ':' + rel], { encoding: 'buffer' }); }
    catch (e) { return { skip: 'unreadable' }; }
    if (buf.length > maxBytes) return { skip: 'too-large' };
    if (isBinary(buf)) return { skip: /\.(?:[cm]?js|json|ya?ml|md|css|html|py|sh|txt)$/i.test(rel) ? 'binary-text' : 'binary' };
    return { text: buf.toString('utf8') };
  }
  let st;
  try { st = fs.lstatSync(abs); } catch (e) {
    if (e.code === 'ENOENT' && gitOk(repo, ['ls-files', '--error-unmatch', '--', rel]) !== null) return { skip: 'worktree-deletion' };
    return { skip: 'unreadable' };
  }
  if (st.isSymbolicLink()) return { text: fs.readlinkSync(abs) };
  if (!st.isFile()) return { skip: 'not-file' };
  if (st.size > maxBytes) return { skip: 'too-large' };
  const buf = fs.readFileSync(abs);
  if (isBinary(buf)) return { skip: /\.(?:[cm]?js|json|ya?ml|md|css|html|py|sh|txt)$/i.test(rel) ? 'binary-text' : 'binary' };
  return { text: buf.toString('utf8') };
}

// ---------- 扫描 ----------
function scanText(rel, text, rules, allowGlobal, allowFile, baseline, args) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  const ordinalByRule = new Map();
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      if (m[0] === '') { rule.re.lastIndex++; continue; }
      const raw = m[0];
      let lineNo = 1;
      for (let i = 0; i < m.index; i++) if (text.charCodeAt(i) === 10) lineNo++;
      const key = rule.id + '|' + rel;
      const ord = (ordinalByRule.get(key) || 0) + 1;
      ordinalByRule.set(key, ord);
      let skipReason = null;
      if (!args['no-allow']) {
        if (!/^(?:url-credentials|url-query-secret|bearer-token|password-assign|.*token|.*key.*|jwt)$/.test(rule.id) && allowGlobal.some(function (re) { return re.test(raw); })) skipReason = 'allow';
        else if (rule.allowPatterns.some(function (re) { return re.test(raw); })) skipReason = 'rule-allow';
        else if (!args.strict && allowFile.some(function (re) { return re.test(raw); })) skipReason = 'file-allow';
      }
      if (!skipReason && !args.strict && baseline && baseline.has(key + '|' + ord)) skipReason = 'baseline';
      if (!skipReason && (args.exactExceptions || []).some(e => e.file === rel && e.rule === rule.id && e.sha256 === fingerprint(raw))) skipReason = 'exact-exception';
      const nl = text.lastIndexOf('\n', m.index - 1);
      findings.push({
        rule: rule.id,
        severity: rule.severity,
        file: rel,
        line: lineNo,
        column: m.index - nl,
        index: m.index,
        raw: raw,
        masked: mask(raw),
        lineText: (lines[lineNo - 1] || '').slice(0, 200),
        description: rule.description,
        source: rule.source,
        skipReason: skipReason,
        fixable: rule.fixable,
        placeholder: rule.placeholder,
        ordinal: ord,
      });
    }
  }
  return findings;
}

function loadBaseline(repo, args) {
  if (args['no-baseline']) return null;
  const p = path.join(repo, '.privacy-guard-baseline.json');
  if (!fs.existsSync(p)) return null;
  const doc = readJson(p);
  const set = new Set();
  (doc.entries || []).forEach(function (e) { set.add(e.rule + '|' + e.file + '|' + e.ordinal); });
  return set;
}

function severityCounts(findings) {
  const c = { high: 0, medium: 0, low: 0 };
  findings.forEach(function (f) { c[f.severity] = (c[f.severity] || 0) + 1; });
  return c;
}

function report(findings, args, meta, skipped) {
  const real = findings.filter(function (f) { return !f.skipReason; });
  const suppressed = findings.length - real.length;
  const counts = severityCounts(real);
  if (args.json) {
    process.stdout.write(JSON.stringify({
      tool: 'privacy-guard', meta: meta, counts: counts, suppressed: suppressed, skipped: skipped,
      findings: real.map(function (f) {
        return { rule: f.rule, severity: f.severity, file: f.file, line: f.line, description: f.description, masked: f.masked, sha256: fingerprint(f.raw), source: f.source };
      }),
    }, null, 2) + '\n');
    return real;
  }
  process.stdout.write('\nprivacy-guard  mode=' + meta.mode + '  files=' + meta.files + '  rules=' + meta.rules + '  repo=' + meta.repo + '\n');
  if (!args.quiet) {
    const shown = real.slice(0, MAX_DISPLAY);
    shown.sort(function (a, b) { return (SEV_ORDER[b.severity] - SEV_ORDER[a.severity]) || a.file.localeCompare(b.file) || (a.line - b.line); });
    for (const f of shown) {
      process.stdout.write('  [' + f.severity.toUpperCase() + '] ' + f.rule + '  ' + f.file + ':' + f.line + '  ' + f.masked + '\n');
      // Never print source lines containing secret values.

    }
    if (real.length > shown.length) process.stdout.write('  ... 还有 ' + (real.length - shown.length) + ' 条未显示（用 --json 取全量）\n');
  }
  process.stdout.write('合计：HIGH ' + counts.high + ' / MEDIUM ' + counts.medium + ' / LOW ' + counts.low + '   已豁免 ' + suppressed + (skipped ? ('   跳过文件 ' + skipped) : '') + '\n');
  return real;
}

function exitFor(real, args) {
  const failOn = String(args['fail-on'] || 'medium').toLowerCase();
  if (failOn === 'none') return 0;
  const threshold = SEV_ORDER[failOn];
  if (threshold === undefined) die('--fail-on 只能是 high|medium|low|none');
  return real.some(function (f) { return SEV_ORDER[f.severity] >= threshold; }) ? 1 : 0;
}

function cmdScan(repo, args) {
  args.exactExceptions = exactExceptions(repo, args);
  const loaded = loadRules(repo);
  const allowFile = allowFilePatterns(repo);
  const baseline = loadBaseline(repo, args);
  const picked = args.directory ? (() => { const files=[]; walkFs(repo,'',files,0); return {mode:'fs',files}; })() : listFiles(repo,args);
  const skipDetails = [];
  let all = [];
  for (const rel of picked.files) {
    const r = readTarget(repo, rel, args, picked.mode);
    if (r.skip) { skipDetails.push({file:rel, reason:r.skip}); continue; }
    all = all.concat(scanText(rel, r.text, loaded.rules, loaded.allow, allowFile, baseline, args));
  }
  const errors = skipDetails.filter(e => !['binary', 'worktree-deletion'].includes(e.reason));
  const meta = { mode: picked.mode, repo, files: picked.files.length - skipDetails.length, rules: loaded.rules.length, ruleSources: loaded.sources, complete: errors.length === 0, skipDetails };
  const status = exitFor(report(all, args, meta, skipDetails.length), args);
  if (errors.length && !args.json) process.stderr.write('扫描未完成：' + errors.map(e => e.file + ' (' + e.reason + ')').join(', ') + '\n');
  return errors.length ? 2 : status;
}

function cmdFix(repo, args) {
  const loaded = loadRules(repo);
  const allowFile = allowFilePatterns(repo);
  const baseline = loadBaseline(repo, args);
  const picked = args.directory ? (() => { const files=[]; walkFs(repo,'',files,0); return {mode:'fs',files}; })() : listFiles(repo,args);
  if (picked.mode === 'staged') die('fix 不能用于 --staged（index 内容无法直接改；先改工作区再 add）');
  const fixable = loaded.rules.filter(function (r) { return r.fixable; });
  if (fixable.length === 0) { process.stdout.write('没有可自动修复的规则（需要 fixable:true 且给了 placeholder）。\n'); return 0; }
  let changedFiles = 0, changedHits = 0;
  for (const rel of picked.files) {
    const abs = path.join(repo, rel);
    let buf;
    if (fs.lstatSync(abs).isSymbolicLink()) continue;
    try { buf = fs.readFileSync(abs); } catch (e) { continue; }
    if (buf.length > Number(args['max-bytes'] || 16777216) || isBinary(buf)) continue;
    let text = buf.toString('utf8');
    const before = text;
    const hits = scanText(rel, text, fixable, loaded.allow, allowFile, baseline, args)
      .filter(function (x) { return !x.skipReason; })
      .sort(function (a, b) { return (a.index - b.index) || (SEV_ORDER[b.severity] - SEV_ORDER[a.severity]) || (b.raw.length - a.raw.length); });
    let rebuilt = '', cursor = 0, applied = 0;
    for (const h of hits) {
      if (h.index < cursor) continue;
      rebuilt += text.slice(cursor, h.index) + h.placeholder;
      cursor = h.index + h.raw.length;
      applied++;
    }
    rebuilt += text.slice(cursor);
    if (applied > 0) { text = rebuilt; changedHits += applied; }
    if (text !== before) {
      fs.writeFileSync(abs, text, 'utf8');
      changedFiles++;
      process.stdout.write('已改写 ' + rel + '\n');
    }
  }
  process.stdout.write('fix 完成：改写 ' + changedFiles + ' 个文件 / ' + changedHits + ' 处。请 git diff 人工过一遍再提交。\n');
  return 0;
}

function scanHistory(repo, args) {
  args.exactExceptions = exactExceptions(repo, args);
  const loaded = loadRules(repo), allowFile = allowFilePatterns(repo), baseline = loadBaseline(repo, args);
  const maxBytes = Number(args['max-bytes'] || 16777216);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) die('--max-bytes 必须是正整数');
  const objects = git(repo, ['rev-list', '--objects', '--all']).trim().split('\n').filter(Boolean);
  const skipped = [], findings = [];
  let blobs = 0;
  for (const line of objects) {
    const at = line.indexOf(' '), oid = at < 0 ? line : line.slice(0,at), file = at < 0 ? '' : line.slice(at+1);
    const type = git(repo, ['cat-file','-t',oid]).trim();
    if (type !== 'blob') continue;
    if (Number(git(repo,['cat-file','-s',oid]).trim()) > maxBytes) { skipped.push({file,reason:'too-large'}); continue; }
    const data = git(repo,['cat-file','blob',oid],{encoding:'buffer'});
    if (isBinary(data)) { skipped.push({file,reason:/\.(?:[cm]?js|json|ya?ml|md|css|html|py|sh|txt)$/i.test(file)?'binary-text':'binary'}); continue; }
    blobs++;
    for (const f of scanText(file,data.toString('utf8'),loaded.rules,loaded.allow,allowFile,baseline,args)) {
      if (!f.skipReason) findings.push({...f,object:oid});
    }
  }
  const errors = skipped.filter(e => e.reason !== 'binary');
  const out = report(findings,args,{mode:'history',repo,files:blobs,rules:loaded.rules.length,complete:!errors.length,skipDetails:skipped},skipped.length);
  return errors.length ? 2 : exitFor(out,args);
}

function cmdAuthors(repo, args) {
  const raw = git(repo, ['log', '--all', '--format=%an <%ae>|%cn <%ce>']);
  const set = new Set();
  raw.split(/\r?\n/).filter(Boolean).forEach(function (l) { l.split('|').forEach(function (p) { set.add(p.trim()); }); });
  const list = Array.from(set).sort();
  if (args.json) process.stdout.write(JSON.stringify({ tool: 'privacy-guard', authors: list }, null, 2) + '\n');
  else {
    process.stdout.write('\n提交历史里出现过的作者/提交者身份（会随每个 commit 永久公开）：\n');
    list.forEach(function (l) { process.stdout.write('  ' + l + '\n'); });
    const cur = gitOk(repo, ['config', 'user.email']);
    if (cur) process.stdout.write('当前仓库 user.email = ' + cur.trim() + '\n');
    process.stdout.write('建议：公开仓库用 noreply 邮箱（形如 1234+login@users.noreply.github.com），别用真实邮箱。\n');
  }
  return 0;
}

function cmdInit(args) {
  const home = privacyHome();
  fs.mkdirSync(home, { recursive: true });
  const target = path.join(home, 'local.rules.json');
  if (fs.existsSync(target) && !args.force) die('已存在 ' + target + '（加 --force 覆盖）');
  const user = os.userInfo().username;
  const homedir = os.homedir();
  const host = os.hostname();
  const repo = path.resolve(args.repo || process.cwd());
  const repoRoot = ((gitOk(repo, ['rev-parse', '--show-toplevel']) || '') + '').trim();
  const name = ((gitOk(repo, ['config', 'user.name']) || '') + '').trim();
  const email = ((gitOk(repo, ['config', 'user.email']) || '') + '').trim();
  const pathish = function (s) { return regexEscape(s).split('\\\\').join('[\\\\\\\\/]{1,2}'); };
  const rules = [];
  const allowPatterns = [
    '\\b(noreply|users\\.noreply)\\.github\\.com\\b',
    '@example\\.(com|org|net)',
    '<[A-Za-z_-]*(USER|user|NAME|name|HOME|home|EMAIL|email|HOST|host|REPO|repo|PATH|path)[A-Za-z_-]*>',
    '\\bexample\\.(com|org|net)\\b',
    '\\b127\\.0\\.0\\.1\\b',
    '\\b0\\.0\\.0\\.0\\b',
    '\\blocalhost\\b',
  ];
  rules.push({ id: 'os-username', severity: 'high', fixable: true, placeholder: '<USERNAME>', description: '本机 OS 用户名：' + user, pattern: '(?<![\\w.@-])' + regexEscape(user) + '(?![\\w.-])', flags: 'gi' });
  rules.push({ id: 'home-dir', severity: 'high', fixable: true, placeholder: '<HOME>', description: '本机用户目录：' + homedir, pattern: pathish(homedir), flags: 'gi' });
  if (repoRoot) rules.push({ id: 'local-repo-path', severity: 'high', fixable: true, placeholder: '<REPO>', description: '本仓绝对路径：' + repoRoot, pattern: pathish(repoRoot), flags: 'gi' });
  const GENERIC_DIRS = ['projects', 'project', 'src', 'code', 'repos', 'repo', 'git', 'work', 'dev', 'workspace', 'documents', 'desktop', 'downloads', 'tmp', 'temp'];
  let anc = repoRoot, depth = 0;
  while (anc && depth < 4) {
    const parent = path.dirname(anc);
    if (!parent || parent === anc || parent.length <= 3) break;
    anc = parent.split('\\').join('/');
    depth++;
    if (depth < 2) continue;
    const base = path.basename(anc);
    if (GENERIC_DIRS.indexOf(base.toLowerCase()) >= 0) continue;
    rules.push({ id: 'local-ancestor-' + depth, severity: 'high', fixable: true, placeholder: '<WORKSPACE>', description: '本机上层项目路径：' + anc, pattern: pathish(anc), flags: 'gi' });
    if (/[^\x00-\x7F]/.test(base)) rules.push({ id: 'local-ancestor-name-' + depth, severity: 'medium', fixable: true, placeholder: '<WORKSPACE>', description: '本机工作区目录名：' + base, pattern: regexEscape(base), flags: 'gi' });
  }
  if (name) rules.push({ id: 'own-name', severity: 'high', fixable: true, placeholder: '<NAME>', description: 'git 提交者姓名', pattern: '(?<![\\w.@-])' + regexEscape(name) + '(?![\\w.-])', flags: 'gi' });
  if (email) {
    rules.push({ id: 'own-email', severity: 'high', fixable: true, placeholder: '<EMAIL>', description: 'git 提交者邮箱', pattern: regexEscape(email), flags: 'gi' });
    const at = email.indexOf('@');
    if (at > 0) rules.push({ id: 'own-email-localpart', severity: 'medium', description: '邮箱 @ 前缀', pattern: '(?<![\\w.@-])' + regexEscape(email.slice(0, at)) + '(?![\\w.-])', flags: 'gi' });
  }
  rules.push({ id: 'hostname', severity: 'medium', fixable: true, placeholder: '<HOST>', description: '本机主机名：' + host, pattern: '(?<![\\w.-])' + regexEscape(host) + '(?![\\w.-])', flags: 'gi' });
  const doc = { version: 1, note: '本机私有规则，永远不要提交到任何仓库。由 privacy-guard init 自动生成。', generatedAt: new Date().toISOString(), allowPatterns: allowPatterns, rules: rules };
  fs.writeFileSync(target, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  process.stdout.write('已生成 ' + target + '\n');
  rules.forEach(function (r) { process.stdout.write('  [' + r.severity + '] ' + r.id + '  ' + r.description + '\n'); });
  return 0;
}

function cmdInstallHooks(args) {
  const repo = path.resolve(args.repo || process.cwd());
  const top = gitOk(repo, ['rev-parse','--show-toplevel'])?.trim();
  if (!top) die('不是 git 仓库');
  const hookPath = git(top,['rev-parse','--path-format=absolute','--git-path','hooks']).trim();
  if (hookPath === '/dev/null') die('core.hooksPath 禁用了钩子，请先明确恢复策略');
  fs.mkdirSync(hookPath,{recursive:true});
  const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const tool = path.join(TOOL_DIR,'privacy-guard.mjs');
  for (const kind of ['pre-commit','pre-push']) {
    const target = path.join(hookPath,kind), previous = target+'.before-privacy-guard';
    if (fs.existsSync(target) && !fs.readFileSync(target,'utf8').includes('# privacy-guard managed v2')) {
      if (fs.existsSync(previous)) die('已有钩子备份，拒绝覆盖：' + previous);
      fs.copyFileSync(target,previous);
      fs.chmodSync(previous,0o755);
    }
    const scan = 'node ' + quote(tool) + ' scan ' + (kind === 'pre-commit' ? '--staged' : '--all') + ' --strict --no-baseline --repo "$ROOT" --fail-on medium';
    const lines = ['#!/bin/sh','# privacy-guard managed v2','set -eu','ROOT=$(git rev-parse --show-toplevel)',scan];
    if (kind === 'pre-push') {
      lines.push('node ' + quote(tool) + ' history --strict --no-baseline --repo "$ROOT" --fail-on medium');
      lines.push('if [ -f "$ROOT/scripts/release-check.py" ]; then python3 "$ROOT/scripts/release-check.py"; fi');
    }
    if (fs.existsSync(previous)) lines.push('exec ' + quote(previous) + ' "$@"');
    fs.writeFileSync(target,lines.join('\n')+'\n',{mode:0o755});
    fs.chmodSync(target,0o755);
  }
  process.stdout.write('已安装可执行钩子：' + hookPath + '；既有钩子保留并串联执行。\n');
  return 0;
}

function cmdSelftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-selftest-'));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const results = [];
  const check = function (name, cond) { results.push({ name: name, ok: !!cond }); };
  const user = os.userInfo().username;
  try {
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'tester@example.com']);
    git(repo, ['config', 'user.name', 'Tester']);
    fs.writeFileSync(path.join(repo, 'a.js'), 'const author = "' + user + '";\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'p.js'), 'const p = "C:\\Users\\' + 'pgselftestacct' + '\\proj";\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'b.md'), '占位符 <USERNAME> 与 <WINDOWS-USER> 不该报。\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'd.txt'), '公开联系邮箱：dev@proton' + '.me\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'clean.js'), 'const x = 1;\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'leak.json'), '{"key": "sk-' + 'abcdefghijklmnopqrstuvwxyz01"}\n', 'utf8');
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'local.rules.json'), JSON.stringify({ version: 1, rules: [{ id: 'os-username', severity: 'high', pattern: '(?<![\\w.@-])' + user + '(?![\\w.-])', flags: 'gi', fixable: true, placeholder: '<USERNAME>', description: '本机用户名' }] }), 'utf8');
    fs.writeFileSync(path.join(repo, '.privacy-allow'), '# 我故意公开的联系方式\ndev@proton\\.me\n', 'utf8');
    const env = Object.assign({}, process.env, { PRIVACY_GUARD_HOME: home });
    const run = function (sub, extra) {
      const args = [path.join(TOOL_DIR, 'privacy-guard.mjs'), sub].concat(extra || []);
      try { return { code: 0, out: execFileSync(process.execPath, args, { cwd: repo, encoding: 'utf8', env: env }) }; }
      catch (e) { return { code: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
    };
    let r = run('scan', ['--all', '--json']);
    const doc = JSON.parse(r.out);
    check('检出本机用户名', doc.findings.some(function (f) { return f.rule === 'os-username' && f.file === 'a.js'; }));
    check('generic 规则检出 sk- 密钥', doc.findings.some(function (f) { return f.file === 'leak.json' && f.rule === 'generic-api-key'; }));
    check('占位符文件不误报', !doc.findings.some(function (f) { return f.file === 'b.md'; }));
    check('仓库级 .privacy-allow 生效', !doc.findings.some(function (f) { return f.file === 'd.txt' && f.rule === 'email'; }));
    check('干净文件不误报', !doc.findings.some(function (f) { return f.file === 'clean.js'; }));
    check('命中 high 时退出码 1', r.code === 1);
    check('掩码不泄漏原文', doc.findings.every(function (f) { return f.masked.indexOf(user) < 0; }));
    r = run('scan', ['--all', '--no-allow', '--json']);
    check('--no-allow 能看见被豁免项', JSON.parse(r.out).findings.some(function (f) { return f.file === 'd.txt' && f.rule === 'email'; }));
    run('fix', ['--all']);
    const after = fs.readFileSync(path.join(repo, 'a.js'), 'utf8');
    check('fix 替换成占位符', after.indexOf('<USERNAME>') >= 0 && after.indexOf(user) < 0);
    check('fix 处理 Windows 绝对路径', fs.readFileSync(path.join(repo, 'p.js'), 'utf8').indexOf('<WINDOWS-USER>') >= 0);
    r = run('scan', ['--all', '--json']);
    check('fix 后用户名不再命中', !JSON.parse(r.out).findings.some(function (f) { return f.rule === 'os-username'; }));
    fs.writeFileSync(path.join(repo, 'a.js'), 'x = "' + user + '";\n', 'utf8');
    fs.writeFileSync(path.join(repo, '.privacy-guard-baseline.json'), JSON.stringify({ version: 1, entries: [{ rule: 'os-username', file: 'a.js', ordinal: 1 }] }), 'utf8');
    r = run('scan', ['--all', '--json']);
    check('baseline 冻结已知命中', !JSON.parse(r.out).findings.some(function (f) { return f.file === 'a.js'; }));
    r = run('scan', ['--all', '--no-baseline', '--json']);
    check('--no-baseline 复现', JSON.parse(r.out).findings.some(function (f) { return f.file === 'a.js'; }));
    fs.rmSync(path.join(repo, '.privacy-guard-baseline.json'));
    git(repo, ['add', '-A']);
    r = run('scan', ['--staged', '--json']);
    check('--staged 读 index 内容', JSON.parse(r.out).findings.some(function (f) { return f.file === 'a.js'; }));
    fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 0, 4]));
    r = run('scan', ['--all', '--json']);
    check('二进制文件被跳过', JSON.parse(r.out).findings.every(function (f) { return f.file !== 'blob.bin'; }));
    run('install-hooks', ['--repo', repo]);
    const pc = path.join(repo, '.git', 'hooks', 'pre-commit');
    check('安装 pre-commit 钩子', fs.existsSync(pc));
    const pct = fs.readFileSync(pc, 'utf8');
    check('钩子为 LF 且 #!/bin/sh', pct.indexOf('\r') < 0 && pct.slice(0, 10) === '#!/bin/sh\n');

    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain, { recursive: true });
    fs.writeFileSync(path.join(plain, 'note.md'), '作者 ' + user + '\n', 'utf8');
    const rp = execFileSync(process.execPath, [path.join(TOOL_DIR, 'privacy-guard.mjs'), 'scan', '--all', '--json', '--fail-on', 'none', '--repo', plain], { encoding: 'utf8', env: env });
    check('非 git 目录也能扫（fs 模式）', JSON.parse(rp).findings.some(function (f) { return f.file === 'note.md' && f.rule === 'os-username'; }));
    git(repo, ['add', '-A']);
    let blocked = false;
    try { git(repo, ['commit', '-q', '-m', 'should be blocked']); } catch (e) { blocked = true; }
    check('已安装的钩子真的拦截提交', blocked);
    git(repo, ['commit', '-q', '--no-verify', '-m', 'seeded ' + user + ' leak']);
    r = run('authors', []);
    check('authors 可用', r.out.indexOf('tester@example.com') >= 0);
    r = run('history', ['--json']);
    check('history 能扫到历史 blob', JSON.parse(r.out).findings.length > 0);
  } catch (e) {
    check('自检过程无异常：' + e.message, false);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
  const bad = results.filter(function (x) { return !x.ok; });
  results.forEach(function (x) { process.stdout.write((x.ok ? '  PASS  ' : '  FAIL  ') + x.name + '\n'); });
  process.stdout.write('自检：' + (results.length - bad.length) + '/' + results.length + ' 通过\n');
  return bad.length === 0 ? 0 : 1;
}

function main() {
  const argv = process.argv.slice(2);
  const hasSub = argv[0] && argv[0].slice(0, 2) !== '--';
  const sub = hasSub ? argv[0] : 'scan';
  const args = parseArgs(hasSub ? argv.slice(1) : argv);
  if (args.help || args.h || sub === 'help') { process.stdout.write(HELP + '\n'); return 0; }
  if (sub === 'selftest') return cmdSelftest();
  if (sub === 'init') return cmdInit(args);
  if (sub === 'install-hooks') return cmdInstallHooks(args);
  const repo = path.resolve(args.repo || process.cwd());
  const top = ((gitOk(repo, ['rev-parse', '--show-toplevel']) || '') + '').trim();
  if (!top && sub !== 'scan' && sub !== 'fix') die('不是 git 仓库：' + repo + '（' + sub + ' 需要 git 历史）');
  const root = args.directory ? repo : (top || repo);
  if (sub === 'scan') return cmdScan(root, args);
  if (sub === 'fix') return cmdFix(root, args);
  if (sub === 'history') return scanHistory(root, args);
  if (sub === 'authors') return cmdAuthors(root, args);
  die('未知子命令：' + sub + '\n\n' + HELP);
}

process.exitCode = main();

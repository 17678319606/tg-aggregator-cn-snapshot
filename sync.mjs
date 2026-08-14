// sync.mjs — 抓取 Telegram 公开频道，生成国内可达的纯文本 RSS 镜像（GitHub Pages 充当墙内代理）
// 依赖：cheerio、nodemailer（workflow 内 npm install）。Node 18+ ESM。
//
// 设计原则（用户明确）：不做任何媒体重托管。正文只保留文字与原文链接，
// 图片/视频由读者在 Telegram 原帖查看。仓库保持轻量，github.io 加载快，墙内可读。
//
// 同步机制（三重触发，互斥串行，绝不重复造数据）：
//   1) CF 源站（BroadcastChannel Worker）内容更新时 repository_dispatch 主动推送（内容一变立即同步）
//   2) 你的 1H1G 宝塔服务器定时调 GitHub API 触发（server/trigger-sync.sh，可精确到分钟）
//   3) GitHub 自带每 15 分钟定时兜底
//   以上三条共享 workflow 并发组 tg-aggregator-sync + cancel-in-progress:false，
//   任意时刻只跑一个，且文章以「消息ID」命名 + 全局去重，重复触发只会覆盖同一文件，绝不会生成重复文章。
//
// 存储策略（防无限堆积，双保险）：
//   - 常态：每个频道组最多保留 MAX_POSTS 篇文章页（硬上限，已恒定有界）。
//   - 应急：若仓库体积超过安全线 80%（默认 1GB 的 80% = 800MB），本次按 EMERGENCY_MAX_POSTS 保留并 git gc。
//   纯文本快照常态仅几 MB，应急分支几乎不会触发，仅作 pathological 兜底。

import * as cheerio from 'cheerio'
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const OWNER = '17678319606'
const REPO = 'tg-aggregator-cn-snapshot'
const GH_PAGES = `https://${OWNER}.github.io/${REPO}`

// —— 保留与容量策略 ——
const MAX_POSTS = 50                  // 单频道组常态保留上限（防无限堆积的核心开关，必须有界值）
const EMERGENCY_MAX_POSTS = 10        // 容量超 80% 安全线时的紧急保留上限
const CHANNEL_PAGES = 2               // 每频道抓几页（约 40-50 帖）

// 仓库体积安全线：GitHub 建议仓库 < 1GB（Pages 软上限 1GB，硬上限 5GB）。
// 本项目纯文本，常态仅数 MB；把 1GB 当「危险线」，超过 80%（800MB）即紧急裁剪。
const REPO_SAFE_LIMIT_BYTES = 1024 * 1024 * 1024
const CAPACITY_WARN_RATIO = 0.8

// —— 报警通道 ——
// 企业微信机器人 webhook（key 已内置为默认值，也可在 workflow 里用 secrets.WX_WORK_WEBHOOK 覆盖）。
const WX_WEBHOOK = process.env.WX_WORK_WEBHOOK ||
  'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=ca5e918f-8e98-4c96-9734-8e5d27b298d0'
// 邮件告警收件人（也可 secrets.ALERT_EMAIL_TO 覆盖）。发件需配置 SMTP_* 环境变量，未配置时自动跳过（微信仍推送）。
const ALERT_EMAIL_TO = process.env.ALERT_EMAIL_TO || 'weixinkaifa@jinbufenzi.work'

// 模块级：本次运行的保留上限（容量超限时会被下调）
let RETENTION = MAX_POSTS
let capacityEmergency = false

// 两个核心项目
const WORKERS = [
  {
    key: '123yunpan',
    title: '123云盘资源分享（国内镜像）',
    desc: '123云盘资源分享',
    channels: ['regeng123', 'wei_123share', 'x123panfxme'],
    fallbackWorker: 'https://123yunpan.lixuehanwork.workers.dev',
  },
  {
    key: 'zhongnianren',
    title: '精选消息（国内镜像）',
    desc: '精选消息',
    channels: ['dogdairy', 'https1024', 'inside1024', 'text1024', 'yunying23'],
    fallbackWorker: 'https://zhongnianren.lixuehanwork.workers.dev',
  },
]

// ---------- 工具 ----------
const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

async function getText(url, { retries = 3, delayMs = 5000 } = {}) {
  let lastErr
  for (let i = 1; i <= retries; i++) {
    try {
      const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' } })
      if (!r.ok) throw new Error(`${url} -> ${r.status}`)
      return await r.text()
    } catch (e) {
      lastErr = e
      if (i < retries) { console.warn(`  retry ${i}/${retries}: ${e.message}; sleep ${delayMs}ms`); await new Promise(r => setTimeout(r, delayMs)) }
    }
  }
  throw lastErr
}

function toIso(input) {
  let t
  if (/^\d+$/.test(String(input))) t = Number(input) * 1000 // unix seconds
  else t = Date.parse(input)
  return isNaN(t) ? new Date().toISOString() : new Date(t).toISOString()
}

// 去除正文中所有媒体与脚本标签，仅保留文字与链接（不重托管任何媒体）
function stripMedia(html) {
  if (!html) return ''
  const $ = cheerio.load(`<div id="__x">${html}</div>`)
  $('#__x').find('img,video,audio,source,iframe,script,style,picture,figure,canvas,embed,object').remove()
  return $('#__x').html() || ''
}

// ---------- 解析单个频道 ----------
// 分页逻辑：首屏抓取最新帖；随后以本页最小 msgId 作为 before 继续往前翻，直到翻不动或触底。
// 以 data-post 的「频道.消息ID」作为唯一键，跨频道天然不冲突，重复触发只会覆盖同一文件。
async function fetchChannel(channel, pages = CHANNEL_PAGES) {
  const posts = []
  let before = null
  let headerTitle = '', headerDesc = ''
  for (let p = 0; p < pages; p++) {
    const url = before ? `https://t.me/s/${channel}?before=${before}` : `https://t.me/s/${channel}`
    const html = await getText(url)
    const $ = cheerio.load(html)
    if (p === 0) {
      headerTitle = $('.tgme_channel_info_header_title').first().text().trim()
      headerDesc = $('.tgme_channel_info_description').first().text().trim()
    }
    const wraps = $('.tgme_channel_history .tgme_widget_message_wrap').toArray()
    let minId = Infinity
    for (const wrap of wraps) {
      const msg = $(wrap).find('.tgme_widget_message')
      const dataPost = msg.attr('data-post') || ''
      const slash = dataPost.indexOf('/')
      if (slash === -1) continue
      const ch = dataPost.slice(0, slash)
      const msgId = dataPost.slice(slash + 1)
      const numId = Number(msgId)
      if (!Number.isFinite(numId)) continue
      if (numId < minId) minId = numId
      const timeEl = msg.find('.tgme_widget_message_date time')
      const dtRaw = timeEl.attr('datetime') || timeEl.attr('data-time') || ''
      const textEl = msg.find('.tgme_widget_message_text')
      textEl.find('img,video,audio,source,iframe,script,style,picture,figure,canvas,embed,object').remove()
      const contentHtml = textEl.html() || ''
      const textText = textEl.text() || ''
      const titleRaw = (textText.trim().split(/\n/)[0] || '').replace(/http\S+/g, '').trim()
      const title = titleRaw.slice(0, 120) || `${ch} 新动态`
      const previewHref = msg.find('.tgme_widget_message_link_preview').attr('href') || ''
      posts.push({
        id: `${ch}.${msgId}`,
        channel: ch,
        msgId,
        datetime: toIso(dtRaw),
        title,
        contentHtml,
        previewHref,
        originalUrl: `https://t.me/s/${ch}/${msgId}`,
      })
    }
    if (!Number.isFinite(minId) || minId <= 1) break
    before = String(minId)
  }
  return { posts, headerTitle, headerDesc }
}

// ---------- 回退：解析原 Worker RSS（CF 源站） ----------
function parseRss(xml) {
  const chTitle = (xml.match(/<channel>[\s\S]*?<title>([\s\S]*?)<\/title>/) || [])[1] || ''
  const chDesc = (xml.match(/<channel>[\s\S]*?<description>([\s\S]*?)<\/description>/) || [])[1] || ''
  const items = []
  const re = /<item>([\s\S]*?)<\/item>/g
  let m
  while ((m = re.exec(xml))) {
    const it = m[1]
    const g = (t) => { const mm = it.match(new RegExp(`<${t}>([\\s\\S]*?)<\\/${t}>`)); return mm ? mm[1].trim() : '' }
    const link = g('link')
    const id = (link.split('/posts/')[1] || '').replace(/\.html$/, '').replace(/\/$/, '')
    if (!id) continue
    items.push({ id, title: g('title') || `${id} 新动态`, pubDate: g('pubDate'), description: g('description') })
  }
  return { chTitle, chDesc, items }
}

// ---------- HTML 生成 ----------
function articleHtml(post, channelTitle, contentHtml, homeUrl, prev, next) {
  const nav = []
  if (prev) nav.push(`<a href="${esc(prev)}" rel="prev">← 上一篇</a>`)
  if (next) nav.push(`<a href="${esc(next)}" rel="next">下一篇 →</a>`)
  const date = new Date(post.datetime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
  const orig = post.originalUrl ? `<p class="orig"><a href="${esc(post.originalUrl)}" target="_blank" rel="noopener">查看 Telegram 原帖（含图片/视频）</a></p>` : ''
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(post.title)} · ${esc(channelTitle)}</title>
<style>body{max-width:720px;margin:2rem auto;padding:0 1rem;font-family:system-ui,-apple-system,"PingFang SC",sans-serif;line-height:1.7;color:#1a1a1a}img{max-width:100%;height:auto;border-radius:8px}a{color:#2563eb}hr{border:none;border-top:1px solid #eee;margin:2rem 0}.nav{display:flex;justify-content:space-between;gap:1rem;margin-top:2rem;font-size:.9rem}.meta{color:#888;font-size:.85rem;margin:.4rem 0 1.2rem}.home{font-size:.85rem;margin-bottom:1rem}a.btn{display:inline-block;padding:.3rem .8rem;border:1px solid #ddd;border-radius:6px;text-decoration:none;color:#444}.content{word-break:break-word}.orig{margin-top:1.4rem;padding-top:1rem;border-top:1px dashed #ddd;font-size:.9rem}</style>
</head><body>
<a class="btn" href="${esc(homeUrl)}">← 返回列表</a>
<div class="meta">${esc(date)}</div>
<h1>${esc(post.title)}</h1>
<div class="content">${contentHtml}</div>
${orig}
${nav.length ? `<div class="nav">${nav.join('')}</div>` : ''}
</body></html>`
}
function indexHtml(chTitle, chDesc, items, siteBase) {
  const cards = items.slice(0, 30).map(it =>
    `<li><a href="${esc(siteBase)}posts/${esc(it.id)}.html">${esc(it.title)}</a><span class="d">${esc(new Date(it.datetime).toLocaleDateString('zh-CN'))}</span></li>`
  ).join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(chTitle)}</title><style>body{max-width:760px;margin:2rem auto;padding:0 1rem;font-family:system-ui,sans-serif;line-height:1.6}.d{color:#999;font-size:.8rem;margin-left:.6rem}li{margin:.5rem 0}a{color:#2563eb}</style></head>
<body><h1>${esc(chTitle)}</h1><p>${esc(chDesc)}</p><ul>${cards}</ul></body></html>`
}
function rootHtml() {
  const cards = WORKERS.map(w => `<div class="card"><b>${esc(w.title)}</b><br><a href="${esc(`${GH_PAGES}/${w.key}/`)}">github.io 列表</a> · <a href="${esc(`${GH_PAGES}/${w.key}/rss.xml`)}">RSS</a> · <a href="${esc(`${GH_PAGES}/${w.key}/rss.json`)}">JSON</a></div>`).join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>频道聚合 · 国内镜像</title><style>body{max-width:720px;margin:2rem auto;padding:0 1rem;font-family:system-ui,sans-serif;line-height:1.7}.card{border:1px solid #eee;border-radius:10px;padding:1rem 1.2rem;margin:1rem 0}.card a{color:#2563eb}code{background:#f3f3f3;padding:.1rem .3rem;border-radius:4px}</style></head>
<body><h1>频道聚合 · 国内镜像</h1><p>由 GitHub Actions 自动同步（直接抓取 Telegram 公开频道，不依赖第三方中转）。文章托管于 GitHub Pages，墙内可直接阅读；图片/视频请点击「原帖」在 Telegram 查看。</p>${cards}</body></html>`
}

// ---------- 仓库体积统计（含 .git，排除 node_modules） ----------
function repoSizeBytes(root = '.') {
  let total = 0
  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git' && false) { /* 仍统计 .git */ }
        if (e.name === 'node_modules') continue
        walk(p)
      } else if (e.isFile()) {
        try { total += fs.statSync(p).size } catch { /* ignore */ }
      }
    }
  }
  walk(root)
  return total
}

// ---------- 报警：企业微信机器人 + 邮件 ----------
async function wxAlert(subject, detail) {
  try {
    const content = `## ⚠️ tg-aggregator 同步告警\n> **${subject}**\n\n${detail}\n\n> 时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
    const r = await fetch(WX_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
    })
    if (!r.ok) console.warn(`[alert] 企业微信返回 HTTP ${r.status}`)
    else console.log('[alert] 企业微信告警已推送')
  } catch (e) {
    console.warn('[alert] 企业微信发送失败:', e.message)
  }
}

async function emailAlert(subject, detail) {
  const host = process.env.SMTP_HOST, user = process.env.SMTP_USER, pass = process.env.SMTP_PASS
  if (!host || !user || !pass) {
    console.log('[alert] 未配置 SMTP_* 环境变量，跳过邮件告警（企业微信仍会推送）')
    return
  }
  try {
    const nodemailer = (await import('nodemailer')).default
    const transport = nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT || 465),
      secure: process.env.SMTP_SECURE !== '0',
      auth: { user, pass },
    })
    await transport.sendMail({
      from: process.env.ALERT_EMAIL_FROM || user,
      to: ALERT_EMAIL_TO,
      subject: `[tg-aggregator告警] ${subject}`,
      text: `${detail}\n\n时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    })
    console.log(`[alert] 已发送邮件告警至 ${ALERT_EMAIL_TO}`)
  } catch (e) {
    console.warn('[alert] 邮件发送失败:', e.message)
  }
}

async function alert(subject, detail) {
  await Promise.allSettled([wxAlert(subject, detail), emailAlert(subject, detail)])
}

// ---------- 单 Worker 发布 ----------
async function publishWorker(w) {
  const log = (...a) => console.log(`[${w.key}]`, ...a)
  const siteBase = `https://${OWNER}.github.io/${REPO}/${w.key}/`
  let posts = []
  let siteTitle = w.title, siteDesc = w.desc
  let directOk = false
  const failedChannels = []

  // 主路径：直接抓 t.me/s/<channel>
  for (const ch of w.channels) {
    try {
      const { posts: cp } = await fetchChannel(ch)
      posts.push(...cp)
      directOk = true
      log(`${ch}: ${cp.length} 帖`)
    } catch (e) {
      failedChannels.push(ch)
      console.warn(`[${w.key}] ${ch} 直连失败: ${e.message}`)
    }
  }

  // 回退：全部频道直连失败 → 原 CF Worker RSS（纯文本，不重托管媒体）
  if (posts.length === 0) {
    try {
      log('直连全失败 → 回退 CF Worker RSS')
      const xml = await getText(`${w.fallbackWorker}/rss.xml`)
      const feed = parseRss(xml)
      posts = feed.items.map(it => ({
        id: it.id,
        title: it.title,
        datetime: toIso(it.pubDate),
        contentHtml: stripMedia(it.description || ''),
        previewHref: '',
        originalUrl: `${w.fallbackWorker}/posts/${it.id}`,
      }))
      directOk = true
      log(`回退得到 ${posts.length} 帖`)
    } catch (e) {
      console.error(`[${w.key}] 回退也失败: ${e.message}`)
    }
  }

  if (posts.length === 0) return { count: 0, ok: false, failedChannels, pruned: 0 }

  // 排序 + 去重（按消息ID，天然幂等）+ 截断到本次保留上限
  posts.sort((a, b) => new Date(b.datetime) - new Date(a.datetime))
  const seen = new Set()
  posts = posts.filter(p => p.id && !seen.has(p.id) && seen.add(p.id))
  posts = posts.slice(0, RETENTION)

  fs.mkdirSync(`${w.key}/posts`, { recursive: true })
  posts.forEach((it, idx) => {
    const prev = idx > 0 ? `${siteBase}posts/${posts[idx - 1].id}.html` : null
    const next = idx < posts.length - 1 ? `${siteBase}posts/${posts[idx + 1].id}.html` : null
    const html = articleHtml(it, siteTitle, it.contentHtml || '', siteBase, prev, next)
    fs.writeFileSync(`${w.key}/posts/${it.id}.html`, html)
  })
  log(`写入 ${posts.length} 篇文章页`)

  // —— 存储保留策略（防无限堆积）——
  // 只保留保留集内的文章页；掉出前 RETENTION 篇的旧文件一律删除并随 git add -A 从仓库移除。
  // 无论源站发多少帖，每个频道组的 posts/ 目录恒定为 ≤ RETENTION 个文件（正常=MAX_POSTS，应急=EMERGENCY_MAX_POSTS）。
  const keepIds = new Set(posts.map(p => p.id))
  let pruned = 0
  if (fs.existsSync(`${w.key}/posts`)) {
    for (const f of fs.readdirSync(`${w.key}/posts`)) {
      if (!f.endsWith('.html')) continue
      const id = f.slice(0, -'.html'.length)
      if (!keepIds.has(id)) {
        fs.rmSync(`${w.key}/posts/${f}`, { force: true })
        pruned++
      }
    }
  }
  if (pruned) log(`清理 ${pruned} 个孤儿文章页（仓库体积有界）`)

  const itemsXml = posts.map(it => {
    const link = `${siteBase}posts/${it.id}.html`
    const orig = it.originalUrl ? `<p><a href="${esc(it.originalUrl)}">查看 Telegram 原帖（含图片/视频）</a></p>` : ''
    return `  <item>
    <title>${esc(it.title)}</title>
    <link>${esc(link)}</link>
    <guid isPermaLink="true">${esc(link)}</guid>
    <pubDate>${esc(new Date(it.datetime).toUTCString())}</pubDate>
    <description>${esc((it.contentHtml || '') + orig)}</description>
  </item>`
  }).join('\n')
  fs.writeFileSync(`${w.key}/rss.xml`, `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>${esc(siteTitle)}</title>
  <link>${esc(siteBase)}</link>
  <description>${esc(siteDesc)}</description>
  <generator>github-actions-sync</generator>
${itemsXml}
</channel>
</rss>`)

  fs.writeFileSync(`${w.key}/rss.json`, JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: siteTitle,
    home_page_url: siteBase,
    feed_url: `${siteBase}rss.json`,
    description: siteDesc,
    items: posts.map(it => ({
      id: `${siteBase}posts/${it.id}.html`,
      url: `${siteBase}posts/${it.id}.html`,
      title: it.title,
      date_published: it.datetime,
      content_html: (it.contentHtml || '') + (it.originalUrl ? `<p><a href="${esc(it.originalUrl)}">查看 Telegram 原帖（含图片/视频）</a></p>` : ''),
    })),
  }, null, 2))
  log('写入 rss.xml + rss.json')
  fs.writeFileSync(`${w.key}/index.html`, indexHtml(siteTitle, siteDesc, posts, siteBase))

  return { count: posts.length, ok: directOk, failedChannels, pruned }
}

// ---------- 主流程 ----------
async function main() {
  fs.writeFileSync('.nojekyll', '')

  // —— 容量检测（应急裁剪前置判断）——
  const sizeBytes = repoSizeBytes('.')
  const ratio = sizeBytes / REPO_SAFE_LIMIT_BYTES
  if (ratio > CAPACITY_WARN_RATIO) {
    capacityEmergency = true
    RETENTION = EMERGENCY_MAX_POSTS
    console.warn(`⚠️ 仓库体积 ${(sizeBytes / 1048576).toFixed(1)}MB 已达安全线 ${(CAPACITY_WARN_RATIO * 100)}%（阈值 ${(CAPACITY_WARN_RATIO * REPO_SAFE_LIMIT_BYTES / 1048576).toFixed(0)}MB），本次按紧急上限 ${EMERGENCY_MAX_POSTS} 篇保留`)
  }

  const failed = []
  const details = []
  for (const w of WORKERS) {
    try {
      const r = await publishWorker(w)
      details.push({ key: w.key, count: r.count, ok: r.ok, failedChannels: r.failedChannels, pruned: r.pruned })
      if (!r.ok || r.count === 0) failed.push(w.key)
    } catch (e) {
      console.error(`[${w.key}] FATAL`, e.stack || e.message)
      failed.push(w.key)
      details.push({ key: w.key, count: 0, ok: false, error: e.message })
    }
  }
  fs.writeFileSync('index.html', rootHtml())

  // —— 容量应急：git gc 回收 .git 历史膨胀的空间 ——
  if (capacityEmergency) {
    try {
      console.log('执行 git gc --prune=now 回收空间…')
      execSync('git gc --prune=now', { stdio: 'inherit' })
    } catch (e) {
      console.warn('[gc] 执行失败(可忽略):', e.message)
    }
  }

  const status = {
    time: new Date().toISOString(),
    ok: WORKERS.map(w => w.key).filter(k => !failed.includes(k)),
    failed,
    details,
    repoSizeMB: +(sizeBytes / 1048576).toFixed(2),
    capacityEmergency,
  }
  fs.writeFileSync('/tmp/sync-status.json', JSON.stringify(status, null, 2))

  const totalPosts = details.reduce((s, d) => s + (d.count || 0), 0)
  const totalPruned = details.reduce((s, d) => s + (d.pruned || 0), 0)
  console.log(`DONE | ok=${status.ok.join(',') || 'none'} | failed=${status.failed.join(',') || 'none'} | posts=${totalPosts} | pruned=${totalPruned} | repoSize=${(sizeBytes / 1048576).toFixed(1)}MB`)

  // —— 报警 ——
  if (capacityEmergency) {
    await alert('仓库容量超阈值', `仓库体积 ${(sizeBytes / 1048576).toFixed(1)}MB 超过 ${(CAPACITY_WARN_RATIO * 100)}% 安全线，已紧急裁剪至每频道组 ${EMERGENCY_MAX_POSTS} 篇并执行 git gc。请检查是否有异常膨胀。`)
  }
  if (failed.length) {
    const detailLines = details.map(d => {
      if (d.error) return `- ${d.key}: 崩溃 ${d.error}`
      if (d.failedChannels && d.failedChannels.length) return `- ${d.key}: 直连失败频道 ${d.failedChannels.join(',')}（已尝试回退）`
      return `- ${d.key}: 无文章产出`
    }).join('\n')
    await alert('部分源站同步失败', `异常源站：${failed.join(', ')}\n\n${detailLines}\n\n源站恢复后下次成功运行将自动恢复正常。`)
  }
}

main().catch(async (e) => {
  console.error('FATAL', e.stack || e.message)
  await alert('同步进程崩溃', `主流程未捕获异常：\n${e.stack || e.message}`)
  process.exit(1)
})

// sync.mjs — 抓取 Telegram 公开频道，生成国内可达的纯文本 RSS 镜像（GitHub Pages 充当墙内代理）
// 依赖：cheerio（workflow 内 npm install）。Node 18+ ESM。
//
// 设计原则（用户明确）：不做任何媒体重托管。正文只保留文字与原文链接，
// 图片/视频由读者在 Telegram 原帖查看。仓库保持轻量，github.io 加载快，墙内可读。
//
// 同步机制：CF 源站（BroadcastChannel Worker）内容更新时通过 repository_dispatch
// 主动触发本流程即时重算；同时保留每 15 分钟定时兜底。任一通道都能让 github.io 上的
// RSS 保持新鲜，国内用户经 github.io 订阅即可。
//
// 数据来源：主路径直连 t.me/s/<频道>（海外 Runner 可直连）；若某源站全部频道失败，
// 回退该源站 CF Worker 的 rss.xml。

import * as cheerio from 'cheerio'
import fs from 'node:fs'

const OWNER = '17678319606'
const REPO = 'tg-aggregator-cn-snapshot'
const GH_PAGES = `https://${OWNER}.github.io/${REPO}`
const PAGE_SIZE = 50
const CHANNEL_PAGES = 2 // 每频道抓几页（约 40-50 帖）

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

// 把 /posts/<id>（无 .html）补成 .html，与文章页对齐
function appendHtmlToPostLinks(text) {
  return text.replace(/(https?:\/\/[^"'`\s<>]*?\/posts\/[^"'`\s<>]+)(["'`\s<>])/g, (whole, url, tail) =>
    /\.html$/i.test(url) || /\/$/.test(url) ? whole : `${url}.html${tail}`)
}

// ---------- 解析单个频道 ----------
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
    if (!isFinite(minId) || minId <= 1) break
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

// ---------- 单 Worker 发布 ----------
async function publishWorker(w) {
  const log = (...a) => console.log(`[${w.key}]`, ...a)
  const siteBase = `https://${OWNER}.github.io/${REPO}/${w.key}/`
  let posts = []
  let siteTitle = w.title, siteDesc = w.desc
  let directOk = false

  // 主路径：直接抓 t.me/s/<channel>
  for (const ch of w.channels) {
    try {
      const { posts: cp } = await fetchChannel(ch)
      posts.push(...cp)
      directOk = true
      log(`${ch}: ${cp.length} 帖`)
    } catch (e) {
      console.warn(`[${w.key}] ${ch} 直连失败: ${e.message}`)
    }
  }

  // 回退：全部频道直连失败 → 原 CF Worker RSS（纯文本，不重托管媒体）
  if (posts.length === 0) {
    try {
      log('直连全失败 → 回退 CF Worker RSS')
      const xml = await getText(`${w.fallbackWorker}/rss.xml`)
      const feed = parseRss(xml)
      siteTitle = w.title
      siteDesc = w.desc
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

  if (posts.length === 0) return { count: 0, ok: false }

  // 排序 + 去重 + 截断
  posts.sort((a, b) => new Date(b.datetime) - new Date(a.datetime))
  const seen = new Set()
  posts = posts.filter(p => p.id && !seen.has(p.id) && seen.add(p.id))
  posts = posts.slice(0, PAGE_SIZE)

  fs.mkdirSync(`${w.key}/posts`, { recursive: true })
  posts.forEach((it, idx) => {
    const prev = idx > 0 ? `${siteBase}posts/${posts[idx - 1].id}.html` : null
    const next = idx < posts.length - 1 ? `${siteBase}posts/${posts[idx + 1].id}.html` : null
    const html = articleHtml(it, siteTitle, it.contentHtml || '', siteBase, prev, next)
    fs.writeFileSync(`${w.key}/posts/${it.id}.html`, html)
  })
  log(`写入 ${posts.length} 篇文章页`)

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

  return { count: posts.length, ok: directOk }
}

// ---------- 主流程 ----------
async function main() {
  fs.writeFileSync('.nojekyll', '')
  const failed = []
  for (const w of WORKERS) {
    try {
      const r = await publishWorker(w)
      if (!r.ok || r.count === 0) failed.push(w.key)
    } catch (e) {
      console.error(`[${w.key}] FATAL`, e.message)
      failed.push(w.key)
    }
  }
  fs.writeFileSync('index.html', rootHtml())
  const status = {
    time: new Date().toISOString(),
    ok: WORKERS.map(w => w.key).filter(k => !failed.includes(k)),
    failed,
  }
  fs.writeFileSync('/tmp/sync-status.json', JSON.stringify(status, null, 2))
  console.log(`DONE | ok=${status.ok.join(',') || 'none'} | failed=${status.failed.join(',') || 'none'}`)
}
main().catch(e => { console.error('FATAL', e); process.exit(1) })

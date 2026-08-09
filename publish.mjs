// publish.mjs — 纯 GitHub Action 快照发布器（在海外 Runner 运行，能回源 CF Worker / Telegram）
// 零依赖：用 Node 18+ 自带 fetch。职责：把每个源站当前 rss.xml 抓下 → 生成文章页 + rss.xml + rss.json（链接指向 github）→
// 媒体下载进仓库走 jsDelivr → 写入仓库工作区（由 workflow 负责 git 提交推送）。
//
// 设计要点：
//  - 两个源站（123yunpan / zhongnianren）共用本脚本，仅 worker 地址与子目录不同。
//  - 文章链接统一补 .html，与生成的文章页文件名对齐，确保点开能读。
//  - 媒体走 gcore.jsdelivr.net（国内比裸 github.io 稳），下载进 <subdir>/media/ 提交到仓库。
//  - 单源失败不影响另一个；抓取失败仅告警不中断。

const OWNER = '17678319606'
const REPO = 'tg-aggregator-cn-snapshot'
const BRANCH = 'main'

const SOURCES = [
  { key: '123yunpan', worker: 'https://123yunpan.lixuehanwork.workers.dev', subdir: '123yunpan' },
  { key: 'zhongnianren', worker: 'https://zhongnianren.lixuehanwork.workers.dev', subdir: 'zhongnianren' },
]

const JSD_BASE = `https://gcore.jsdelivr.net/gh/${OWNER}/${REPO}@latest`
const MEDIA_PER_SOURCE = 50
const MEDIA_MAX_BYTES = 3 * 1024 * 1024

// ---------- 通用工具 ----------
const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
function dec(s = '') {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&amp;/g, '&')
}
async function getText(url) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0' } })
  if (!r.ok) throw new Error(`${url} -> ${r.status}`)
  return await r.text()
}
async function getBytes(url) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0' } })
  if (!r.ok) throw new Error(`${url} -> ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}
// 带重试的抓取：源站（CF Worker）偶发抖动时自愈，避免把瞬时抖动误报成故障
async function fetchWithRetry(url, { binary = false, tries = 3, delayMs = 5000 } = {}) {
  let lastErr
  for (let i = 1; i <= tries; i++) {
    try {
      return binary ? await getBytes(url) : await getText(url)
    } catch (e) {
      lastErr = e
      if (i < tries) {
        console.warn(`  retry ${i}/${tries} failed: ${e.message}; sleep ${delayMs}ms`)
        await new Promise(r => setTimeout(r, delayMs))
      }
    }
  }
  throw lastErr
}
async function sha256Hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf)
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('')
}
function toIso(rfc822) {
  const t = Date.parse(rfc822)
  return isNaN(t) ? new Date().toISOString() : new Date(t).toISOString()
}

// 把描述/正文里指向 /posts/<id>（无 .html）的链接补成 .html，与文章页文件对齐
function appendHtmlToPostLinks(text) {
  return text.replace(/(https?:\/\/[^"'`\s<>]*?\/posts\/[^"'`\s<>]+)(["'`\s<>])/g, (whole, url, tail) => {
    if (/\.html$/i.test(url) || /\/$/.test(url)) return whole
    return `${url}.html${tail}`
  })
}

// ---------- RSS 解析（轻量） ----------
function parseRss(xml) {
  const chTitle = (xml.match(/<channel>[\s\S]*?<title>([\s\S]*?)<\/title>/) || [])[1] || ''
  const chLink = (xml.match(/<channel>[\s\S]*?<link>([\s\S]*?)<\/link>/) || [])[1] || ''
  const chDesc = (xml.match(/<channel>[\s\S]*?<description>([\s\S]*?)<\/description>/) || [])[1] || ''
  const items = []
  const re = /<item>([\s\S]*?)<\/item>/g
  let m
  while ((m = re.exec(xml))) {
    const it = m[1]
    const g = (tag) => {
      const mm = it.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))
      return mm ? mm[1].trim() : ''
    }
    const link = g('link')
    const id = (link.split('/posts/')[1] || '').replace(/\/$/, '')
    if (!id) continue
    items.push({
      title: dec(g('title')),
      link, id,
      guid: g('guid') || link,
      pubDate: g('pubDate'),
      description: dec(g('description')),
    })
  }
  return { chTitle: dec(chTitle), chLink: dec(chLink), chDesc: dec(chDesc), items }
}

// ---------- 媒体处理 ----------
function collectStatic(html) {
  const set = new Set()
  const re = /(?:src|href|poster)=["'](\/static\/[^"')\s]+)["']/gi
  let m
  while ((m = re.exec(html)) !== null) set.add(m[1])
  return [...set]
}
function extFromUrl(u) {
  const m = u.match(/\.([a-z0-9]{1,5})(?:[?#]|$)/i)
  return m ? m[1].toLowerCase() : 'bin'
}

// ---------- HTML 生成 ----------
function articleHtml(post, channelTitle, contentHtml, homeUrl, prev, next) {
  const nav = []
  if (prev) nav.push(`<a href="${esc(prev)}" rel="prev">← 上一篇</a>`)
  if (next) nav.push(`<a href="${esc(next)}" rel="next">下一篇 →</a>`)
  const date = new Date(post.pubDate || Date.now()).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(post.title)} · ${esc(channelTitle)}</title>
<style>body{max-width:720px;margin:2rem auto;padding:0 1rem;font-family:system-ui,-apple-system,"PingFang SC",sans-serif;line-height:1.7;color:#1a1a1a}img{max-width:100%;height:auto;border-radius:8px}a{color:#2563eb}hr{border:none;border-top:1px solid #eee;margin:2rem 0}.nav{display:flex;justify-content:space-between;gap:1rem;margin-top:2rem;font-size:.9rem}.meta{color:#888;font-size:.85rem;margin:.4rem 0 1.2rem}.home{font-size:.85rem;margin-bottom:1rem}a.btn{display:inline-block;padding:.3rem .8rem;border:1px solid #ddd;border-radius:6px;text-decoration:none;color:#444}.content{word-break:break-word}</style>
</head><body>
<a class="btn" href="${esc(homeUrl)}">← 返回列表</a>
<h1>${esc(post.title)}</h1>
<div class="meta">${esc(date)}</div>
<div class="content">${contentHtml}</div>
${nav.length ? `<div class="nav">${nav.join('')}</div>` : ''}
</body></html>`
}

function indexHtml(channelTitle, channelDesc, items, siteBase, cdnBase) {
  const lis = items.map(it => {
    const url = `${siteBase}posts/${it.id}.html`
    return `<li><a href="${esc(url)}">${esc(it.title)}</a><span class="d"> · ${esc((it.pubDate || '').slice(0, 16))}</span></li>`
  }).join('\n')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(channelTitle)}（国内镜像）</title>
<style>body{max-width:760px;margin:2rem auto;padding:0 1rem;font-family:system-ui,-apple-system,"PingFang SC",sans-serif;line-height:1.6}.feed{margin:.6rem 0}.feed a{color:#2563eb}li{margin:.5rem 0}.d{color:#aaa;font-size:.8rem}.sub{color:#666;font-size:.9rem}code{background:#f3f3f3;padding:.1rem .3rem;border-radius:4px}</style>
</head><body>
<h1>${esc(channelTitle)} <small>· 国内镜像</small></h1>
<p class="sub">${esc(channelDesc)}</p>
<p class="sub">RSS：<code>${esc(siteBase)}rss.xml</code> ｜ JSON：<code>${esc(siteBase)}rss.json</code></p>
<p class="sub">源站（墙外）：<a href="${esc(cdnBase)}">${esc(cdnBase)}</a></p>
<ul>${lis}</ul>
</body></html>`
}

function rootHtml(sources) {
  const cards = sources.map(s => {
    const base = `https://${OWNER}.github.io/${REPO}/${s.subdir}/`
    return `<div class="card"><h2>${esc(s.key)}</h2>
<p><a href="${esc(base)}">列表/首页</a> ｜ <a href="${esc(base)}rss.xml">RSS</a> ｜ <a href="${esc(base)}rss.json">JSON</a></p></div>`
  }).join('\n')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>频道聚合国内镜像</title>
<style>body{max-width:760px;margin:2rem auto;padding:0 1rem;font-family:system-ui,-apple-system,"PingFang SC",sans-serif}.card{border:1px solid #eee;border-radius:10px;padding:1rem 1.2rem;margin:1rem 0}.card a{color:#2563eb}code{background:#f3f3f3;padding:.1rem .3rem;border-radius:4px}</style>
</head><body>
<h1>频道聚合 · 国内镜像</h1>
<p>以下两个源站原部署在 Cloudflare Workers（墙内不可达），此处为自动同步的国内镜像，由 GitHub Actions 每小时刷新。</p>
${cards}
<p class="sub">媒体经 jsDelivr 分发，文章原文点击即可在墙内阅读。</p>
</body></html>`
}

// ---------- 主流程 ----------
async function publishOne(src) {
  const log = (...a) => console.log(`[${src.key}]`, ...a)
  const siteBase = `https://${OWNER}.github.io/${REPO}/${src.subdir}/`
  log('fetch rss.xml ...')
  const xml = await fetchWithRetry(`${src.worker}/rss.xml`)
  const feed = parseRss(xml)
  log(`parsed ${feed.items.length} items`)

  // 媒体收集 + 下载（限数量/大小）
  const mediaMap = {}
  const mediaPaths = []
  for (const it of feed.items) {
    for (const p of collectStatic(it.description || '')) {
      if (!mediaMap[p] && mediaPaths.length < MEDIA_PER_SOURCE) mediaPaths.push(p)
    }
  }
  log(`media to fetch: ${mediaPaths.length}`)
  for (const p of mediaPaths) {
    try {
      const buf = await fetchWithRetry(`${src.worker}${p}`, { binary: true })
      if (buf.length > MEDIA_MAX_BYTES) { log('skip large media', p); continue }
      const hash = await sha256Hex(buf)
      const ext = extFromUrl(p)
      const rel = `${src.subdir}/media/${hash}.${ext}`
      mediaMap[p] = `${JSD_BASE}/${src.subdir}/media/${hash}.${ext}`
      const fs = await import('node:fs')
      fs.mkdirSync(`${src.subdir}/media`, { recursive: true })
      fs.writeFileSync(rel, buf)
    } catch (e) { log('media fetch fail', p, e.message) }
  }

  // 文章页
  const fs = await import('node:fs')
  fs.mkdirSync(`${src.subdir}/posts`, { recursive: true })
  feed.items.forEach((it, idx) => {
    const prev = idx > 0 ? `${siteBase}posts/${feed.items[idx - 1].id}.html` : null
    const next = idx < feed.items.length - 1 ? `${siteBase}posts/${feed.items[idx + 1].id}.html` : null
    const content = appendHtmlToPostLinks(it.description || '').replace(
      /(\/static\/[^"'`\s<>]+)/g,
      (_, u) => mediaMap[u] || u
    )
    const html = articleHtml(it, feed.chTitle, content, siteBase, prev, next)
    fs.writeFileSync(`${src.subdir}/posts/${it.id}.html`, html)
  })
  log(`wrote ${feed.items.length} article pages`)

  // RSS 2.0（链接补 .html，指向 github）
  const itemsXml = feed.items.map(it => {
    const link = `${siteBase}posts/${it.id}.html`
    const desc = appendHtmlToPostLinks(it.description || '').replace(
      /(\/static\/[^"'`\s<>]+)/g, (_, u) => mediaMap[u] || u
    )
    return `  <item>
    <title>${esc(it.title)}</title>
    <link>${esc(link)}</link>
    <guid isPermaLink="true">${esc(link)}</guid>
    <pubDate>${esc(it.pubDate)}</pubDate>
    <description>${desc}</description>
  </item>`
  }).join('\n')
  const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>${esc(feed.chTitle)}（国内镜像）</title>
  <link>${esc(siteBase)}</link>
  <description>${esc(feed.chDesc)}</description>
  <generator>github-actions-snapshot</generator>
${itemsXml}
</channel>
</rss>`
  fs.writeFileSync(`${src.subdir}/rss.xml`, rssXml)

  // JSON Feed
  const json = {
    version: 'https://jsonfeed.org/version/1.1',
    title: `${feed.chTitle}（国内镜像）`,
    home_page_url: siteBase,
    feed_url: `${siteBase}rss.json`,
    description: feed.chDesc,
    items: feed.items.map(it => ({
      id: `${siteBase}posts/${it.id}.html`,
      url: `${siteBase}posts/${it.id}.html`,
      title: it.title,
      date_published: toIso(it.pubDate),
      content_html: appendHtmlToPostLinks(it.description || '').replace(
        /(\/static\/[^"'`\s<>]+)/g, (_, u) => mediaMap[u] || u
      ),
    })),
  }
  fs.writeFileSync(`${src.subdir}/rss.json`, JSON.stringify(json, null, 2))
  log('wrote rss.xml + rss.json')

  // 子目录首页
  fs.writeFileSync(`${src.subdir}/index.html`, indexHtml(feed.chTitle, feed.chDesc, feed.items, siteBase, `${src.worker}/`))
  return feed.items.length
}

async function main() {
  const fs = await import('node:fs')
  fs.writeFileSync('.nojekyll', '')
  let total = 0
  const failed = []
  for (const src of SOURCES) {
    try { total += await publishOne(src) } catch (e) { console.error(`[${src.key}] FATAL`, e.message); failed.push(src.key) }
  }
  fs.writeFileSync('index.html', rootHtml(SOURCES))
  // 把同步状态写到 /tmp（不进仓库，避免每次 run 都产生提交），供监控步骤判读
  const status = {
    time: new Date().toISOString(),
    ok: SOURCES.map(s => s.key).filter(k => !failed.includes(k)),
    failed,
  }
  fs.writeFileSync('/tmp/sync-status.json', JSON.stringify(status, null, 2))
  console.log(`DONE total items=${total} | ok=${status.ok.join(',') || 'none'} | failed=${status.failed.join(',') || 'none'}`)
  // 源站故障是"软失败"：仍正常提交其它源站的更新，由 workflow 监控步骤据此告警，本身不退出非零
}
main().catch(e => { console.error('FATAL', e); process.exit(1) })

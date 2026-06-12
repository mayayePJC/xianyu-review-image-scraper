#!/usr/bin/env node
'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const DEFAULTS = {
  mode: 'discover-links',
  keywordsFile: 'config/xianyu_keywords.txt',
  itemUrlsFile: 'config/xianyu_item_urls.txt',
  dataDir: 'data',
  imagesRoot: 'images',
  logsDir: 'logs',
  cdpUrl: '',
  channel: 'msedge',
  userDataDir: 'browser_profile',
  maxKeywords: 3,
  maxCandidates: 10,
  maxCandidatesPerKeyword: 10,
  maxInspectPages: 10,
  maxRefreshPages: 0,
  maxOpenPages: 2,
  maxInvalidInspects: 6,
  maxConsecutiveInvalidInspects: 4,
  maxLinksPerRun: 1,
  maxImagesPerRun: 30,
  maxSellerNamesPerRun: 5,
  skipSellerNameRefresh: true,
  linkIds: '',
  keywords: '',
  scrollSteps: 16,
  minDelayMs: 1200,
  maxDelayMs: 2500,
  navigationTimeoutMs: 45000,
  downloadTimeoutMs: 30000,
  debugSearch: false,
};

const LINK_STATE_HEADERS = [
  'link_id',
  'keyword',
  'item_url',
  'seller_url',
  'review_url',
  'seller_name',
  'item_title',
  'card_text',
  'has_images',
  'total_images',
  'images_downloaded',
  'images_remaining',
  'link_status',
  'image_status',
  'last_link_crawl_at',
  'last_image_crawl_at',
  'notes',
];

const IMAGE_STATE_HEADERS = [
  'image_id',
  'seller_id',
  'link_id',
  'keyword',
  'seller_url',
  'review_url',
  'thumb_url',
  'original_url',
  'local_path',
  'source',
  'width',
  'height',
  'content_type',
  'bytes',
  'sha256',
  'status',
  'downloaded_at',
  'notes',
  'uid',
  'usable',
];

function loadPlaywright() {
  try {
    return require('playwright-core');
  } catch {
    console.error('Missing dependency: playwright-core');
    console.error('Run: npm install --no-audit --no-fund');
    process.exit(1);
  }
}

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [rawKey, inlineValue] = arg.slice(2).split(/=(.*)/s).filter((x) => x !== undefined);
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const consumesNext = inlineValue === undefined && argv[i + 1] && !argv[i + 1].startsWith('--');
    const nextValue = inlineValue !== undefined ? inlineValue : consumesNext ? argv[i + 1] : '';
    if (key === 'debugSearch') opts.debugSearch = true;
    else if (key === 'noDebugSearch') opts.debugSearch = false;
    else if (key === 'skipSellerNameRefresh') opts.skipSellerNameRefresh = true;
    else if (key === 'noSkipSellerNameRefresh') opts.skipSellerNameRefresh = false;
    else if (key in opts) {
      const current = opts[key];
      opts[key] = typeof current === 'number' ? Number(nextValue) : String(nextValue);
      if (consumesNext) i += 1;
    }
  }
  if (opts.mode === 'images') opts.mode = 'download-images';
  return opts;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseList(value) {
  return String(value || '')
    .split(/[,\s|]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function randomDelay(opts) {
  const min = Math.max(0, opts.minDelayMs);
  const max = Math.max(min, opts.maxDelayMs);
  await sleep(min + Math.floor(Math.random() * (max - min + 1)));
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function nowIso() {
  return new Date().toISOString();
}

function hasImagesStatus(row) {
  return String(row?.has_images || '').trim().toLowerCase();
}

function imageStatus(row) {
  return String(row?.image_status || '').trim().toLowerCase();
}

function timestampMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : 0;
}

function sanitizeSegment(value, fallback = 'unknown') {
  const s = String(value || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 90)
    .replace(/^_+|_+$/g, '');
  return s || fallback;
}

function normalizeUrl(raw, baseUrl) {
  if (!raw) return '';
  let url = String(raw).trim();
  if (!url || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:')) return '';
  if (url.startsWith('//')) url = `https:${url}`;
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return '';
  }
}

async function readLinesIfExists(file) {
  try {
    const raw = await fs.readFile(path.resolve(file), 'utf8');
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  } catch {
    return [];
  }
}

async function loadKeywords(opts) {
  const explicitKeywords = parseList(opts.keywords);
  if (explicitKeywords.length) return [...new Set(explicitKeywords)];
  const lines = await readLinesIfExists(opts.keywordsFile);
  return [...new Set(lines.flatMap((line) => line.split(/[，,|]/)).map((x) => x.trim()).filter(Boolean))];
}

function clampDiscoverOptions(opts) {
  if (opts.mode !== 'discover-links') return opts;
  opts.maxCandidatesPerKeyword = Math.max(1, Math.min(10, Number(opts.maxCandidatesPerKeyword) || DEFAULTS.maxCandidatesPerKeyword));
  opts.maxCandidates = Math.max(1, Math.min(30, Number(opts.maxCandidates) || DEFAULTS.maxCandidates));
  opts.maxInspectPages = Math.max(0, Math.min(12, Number(opts.maxInspectPages) || DEFAULTS.maxInspectPages));
  opts.maxRefreshPages = Math.max(0, Math.min(5, Number(opts.maxRefreshPages) || DEFAULTS.maxRefreshPages));
  opts.maxOpenPages = Math.max(1, Math.min(2, Number(opts.maxOpenPages) || DEFAULTS.maxOpenPages));
  opts.maxInvalidInspects = Math.max(1, Math.min(12, Number(opts.maxInvalidInspects) || DEFAULTS.maxInvalidInspects));
  opts.maxConsecutiveInvalidInspects = Math.max(1, Math.min(6, Number(opts.maxConsecutiveInvalidInspects) || DEFAULTS.maxConsecutiveInvalidInspects));
  return opts;
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

function parseCsvText(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((line) => line.length);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? '';
    });
    return row;
  });
  return { headers, rows };
}

async function readCsvRows(file, headers = []) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = parseCsvText(raw);
    return parsed.rows.map((row) => {
      const out = {};
      headers.forEach((header) => {
        out[header] = row[header] ?? '';
      });
      for (const [key, value] of Object.entries(row)) out[key] = value;
      return out;
    });
  } catch {
    return [];
  }
}

async function writeCsvRows(file, headers, rows) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body = [
    headers.map(csvEscape).join(','),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header] ?? '')).join(',')),
  ].join('\n');
  const tempFile = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tempFile, `\uFEFF${body}\n`, 'utf8');
  await fs.rename(tempFile, file);
}

async function appendCsv(file, row) {
  await fs.appendFile(file, `${row.map(csvEscape).join(',')}\n`, 'utf8');
}

async function initCsv(file, header) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `\uFEFF${header.map(csvEscape).join(',')}\n`, 'utf8');
}

function linkStatePath(opts) {
  return path.resolve(opts.dataDir, 'link_state.csv');
}

function imageStatePath(opts) {
  return path.resolve(opts.dataDir, 'image_state.csv');
}

function userIdFromUrl(raw) {
  try {
    return new URL(raw).searchParams.get('userId') || '';
  } catch {
    return '';
  }
}

function itemKeyFromUrl(raw) {
  try {
    const url = new URL(raw);
    return (
      url.searchParams.get('id') ||
      url.searchParams.get('itemId') ||
      url.searchParams.get('item_id') ||
      (url.pathname.match(/(\d{6,})/) || [])[1] ||
      ''
    );
  } catch {
    return '';
  }
}

function linkIdFrom(record) {
  const sellerId = userIdFromUrl(record.sellerUrl || record.reviewUrl || '');
  if (sellerId) return `seller_${sellerId}`;
  const itemId = itemKeyFromUrl(record.itemUrl || '');
  if (itemId) return `item_${itemId}`;
  return `link_${crypto.createHash('sha1').update(record.sellerUrl || record.itemUrl || JSON.stringify(record)).digest('hex').slice(0, 16)}`;
}

function sellerIdFromLinkRow(row) {
  const userId = userIdFromUrl(row.seller_url || row.review_url || '');
  if (userId) return `seller_${userId}`;
  const linkId = String(row.link_id || '').trim();
  if (linkId.startsWith('seller_')) return linkId;
  return linkId || 'unknown';
}

function imageIdFrom(sellerId, originalUrl, thumbUrl) {
  return crypto.createHash('sha1').update(`${sellerId}|${originalUrl || thumbUrl}`).digest('hex');
}

function imageDedupKey(row) {
  return String(row.sha256 || row.original_url || row.thumb_url || row.image_id || '').trim();
}

function imageDedupKeys(row) {
  return [row.sha256, row.original_url, row.thumb_url, row.image_id]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function isHandledImage(row) {
  const status = String(row?.status || '').trim();
  return status.startsWith('saved') || status === 'discarded_no_uid';
}

function syncSellerImageStateToLinks(sourceRow, linkRows, imageRows) {
  const sellerId = sellerIdFromLinkRow(sourceRow);
  const sellerImages = imageRows.filter((row) => (row.seller_id || sellerIdFromLinkRow(row)) === sellerId && isHandledImage(row));
  const downloaded = sellerImages.length;
  const total = Math.max(Number(sourceRow.total_images || 0), downloaded);
  const hasImages = downloaded > 0 || sourceRow.has_images === 'yes' ? 'yes' : sourceRow.has_images;
  const imagesRemaining = hasImages === 'yes' ? String(Math.max(0, total - downloaded)) : '0';
  const imageStatusValue = hasImages === 'yes'
    ? (Number(imagesRemaining) > 0 ? 'partial' : 'complete')
    : sourceRow.image_status;
  for (const row of linkRows) {
    if (sellerIdFromLinkRow(row) !== sellerId) continue;
    row.has_images = hasImages || row.has_images;
    row.total_images = String(total || Number(row.total_images || 0) || 0);
    row.images_downloaded = String(downloaded);
    row.images_remaining = imagesRemaining;
    row.image_status = imageStatusValue || row.image_status;
    row.last_image_crawl_at = sourceRow.last_image_crawl_at || nowIso();
    if (sourceRow.review_url && !row.review_url) row.review_url = sourceRow.review_url;
  }
}

async function safeBodyText(page) {
  try {
    return await page.locator('body').innerText({ timeout: 3000 });
  } catch {
    return '';
  }
}

async function isHardBlocked(page) {
  const text = await safeBodyText(page);
  const compact = text.replace(/\s+/g, '');
  return (
    /非法访问|请使用正常浏览器|安全验证|滑块验证|访问受限|风险验证|账号异常/.test(compact) ||
    /请输入验证码|请完成验证|拖动滑块|验证失败|验证通过后继续/.test(compact)
  );
}

async function closeLoginPopups(page) {
  for (let i = 0; i < 6; i += 1) {
    const clicked = await page
      .evaluate(() => {
        function visible(el) {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        }
        const candidates = Array.from(document.querySelectorAll('button,a,span,div,i,svg'))
          .filter((el) => {
            if (!visible(el)) return false;
            const text = (el.innerText || el.textContent || '').trim();
            const label = el.getAttribute('aria-label') || el.getAttribute('title') || '';
            const cls = el.className && typeof el.className === 'string' ? el.className : '';
            return (
              /^(关闭|取消|以后再说|暂不登录|我知道了)$/.test(text) ||
              /关闭|close/i.test(label) ||
              /close|modal-close|dialog-close|icon-close|rax-icon-close/i.test(cls)
            );
          })
          .sort((a, b) => (Number(getComputedStyle(b).zIndex) || 0) - (Number(getComputedStyle(a).zIndex) || 0));
        if (!candidates[0]) return false;
        candidates[0].click();
        return true;
      })
      .catch(() => false);
    if (!clicked) {
      await page.keyboard.press('Escape').catch(() => {});
      break;
    }
    await sleep(350);
  }
}

async function cleanAfterAction(page, opts) {
  await sleep(700);
  await closeLoginPopups(page);
  await randomDelay(opts);
}

async function closeExtraPages(context, keepPages = [], opts = {}) {
  const keep = new Set(keepPages.filter((page) => page && !page.isClosed()));
  const openPages = context.pages().filter((page) => !page.isClosed());
  const maxOpenPages = Math.max(1, Number(opts.maxOpenPages || DEFAULTS.maxOpenPages));
  const closeList = openPages.filter((page) => !keep.has(page));
  const allowedNonKeep = Math.max(0, maxOpenPages - keep.size);
  const closeCount = Math.max(0, closeList.length - allowedNonKeep);
  for (const page of closeList.slice(0, closeCount)) {
    await page.close().catch(() => {});
  }
}

async function newManagedPage(context, opts, keepPages = []) {
  const maxOpenPages = Math.max(1, Number(opts.maxOpenPages || DEFAULTS.maxOpenPages));
  const keep = keepPages.filter((page) => page && !page.isClosed()).slice(-(maxOpenPages - 1));
  const beforePages = context.pages().filter((page) => !page.isClosed());
  const beforeKeep = new Set(keep);
  const allowedBeforeOpen = Math.max(0, maxOpenPages - keep.length - 1);
  const closeBeforeOpen = beforePages.filter((page) => !beforeKeep.has(page)).slice(allowedBeforeOpen);
  for (const page of closeBeforeOpen) {
    await page.close().catch(() => {});
  }
  const page = await context.newPage();
  await closeExtraPages(context, [...keep, page], opts);
  return page;
}

async function closeAllOpenPages(context, label = 'browser pages') {
  const pages = context.pages().filter((page) => !page.isClosed());
  for (const page of pages) {
    await page.close().catch(() => {});
  }
  if (pages.length) console.log(`Closed ${pages.length} restored ${label}.`);
  return pages.length;
}

async function clearSessionRestoreFiles(userDataDir) {
  const profileDir = path.resolve(userDataDir, 'Default');
  const targets = [
    path.join(profileDir, 'Sessions'),
    path.join(profileDir, 'Current Session'),
    path.join(profileDir, 'Current Tabs'),
    path.join(profileDir, 'Last Session'),
    path.join(profileDir, 'Last Tabs'),
  ];
  let removed = 0;
  for (const target of targets) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Session restore cleanup is best-effort; cookies and login data stay intact.
    }
  }
  if (removed) console.log(`Cleared browser session-restore records from ${profileDir}.`);
}

async function gotoPage(page, url, opts) {
  console.log(`    goto: ${url}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.navigationTimeoutMs });
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
    await cleanAfterAction(page, opts);
    return !(await isHardBlocked(page));
  } catch (error) {
    console.warn(`    navigation failed: ${error.message}`);
    return false;
  }
}

function isLikelyItemUrl(raw) {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const pathname = url.pathname.toLowerCase();
    if (!/(^|\.)goofish\.com$|(^|\.)2\.taobao\.com$|(^|\.)taobao\.com$/.test(host)) return false;
    if (/search|login|help|about|market\/list|\/im\b|publish|feedback/.test(pathname)) return false;
    const params = ['id', 'itemId', 'item_id', 'goodsId', 'goods_id']
      .map((name) => url.searchParams.get(name))
      .filter(Boolean);
    return (
      host.startsWith('item.') ||
      /(^|\/)(item|detail|goods)(\/|\.|$)/.test(pathname) ||
      params.some((value) => /^\d{5,}$/.test(String(value)))
    );
  } catch {
    return false;
  }
}

async function collectItemLinks(page, maxItems) {
  const rawLinks = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]')).flatMap((a) => {
      const card = a.closest('[class*="item"],[class*="card"],[class*="feeds"],[class*="feed"],li,section,article,div') || a;
      const link = {
        href: a.href,
        text: (a.innerText || a.getAttribute('title') || card.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 800),
      };
      const dataHrefs = Array.from(a.attributes || [])
        .filter((attr) => /url|href|link|target/i.test(attr.name) && /^https?:\/\//i.test(attr.value))
        .map((attr) => ({ href: attr.value, text: link.text }));
      return [link, ...dataHrefs];
    })
  );
  const pageTextLinks = await page
    .evaluate(() => {
      const html = document.documentElement.innerHTML || '';
      const urls = new Set();
      for (const match of html.matchAll(/https?:\\?\/\\?\/[^"'<>\\\s]+/g)) {
        urls.add(match[0].replace(/\\\//g, '/').replace(/&amp;/g, '&'));
      }
      return Array.from(urls).slice(0, 300).map((href) => ({ href, text: '' }));
    })
    .catch(() => []);
  const byUrl = new Map();
  for (const link of [...rawLinks, ...pageTextLinks]) {
    const url = normalizeUrl(link.href, page.url());
    if (!url || !isLikelyItemUrl(url)) continue;
    const text = String(link.text || '').trim();
    const existing = byUrl.get(url);
    if (!existing || text.length > existing.listTitle.length) byUrl.set(url, { url, listTitle: text });
  }
  return Array.from(byUrl.values()).slice(0, maxItems);
}

function buildKeywordTerms(keyword) {
  const compact = String(keyword || '').replace(/\s+/g, '');
  const terms = new Set();
  if (compact) terms.add(compact);
  for (const part of compact.split(/[，,|/\\_\-]+/)) {
    if (part && part.length >= 2) terms.add(part);
  }
  return [...terms];
}

function normalizeMatchText(value) {
  return String(value || '').replace(/\s+/g, '');
}

function buildKeywordCoreTerms(keyword) {
  const generic = new Set(['account', 'service', 'shop', 'sale', 'game', 'item']);
  return buildKeywordTerms(keyword).filter((term) => term.length >= 2 && !generic.has(term));
}

function isRelevantItem(link, keyword) {
  const displayText = normalizeMatchText(link.text || link.listTitle || '');
  const terms = buildKeywordTerms(keyword);
  const coreTerms = buildKeywordCoreTerms(keyword);
  if (!terms.length) return true;
  if (coreTerms.length && coreTerms.some((term) => displayText.includes(term))) return true;
  return terms.some((term) => displayText.includes(term));
}

function fallbackRelevantItems(rawItems, keyword) {
  const compactKeyword = normalizeMatchText(keyword);
  const core = compactKeyword.length >= 2 ? compactKeyword.slice(0, 2) : compactKeyword;
  if (!core) return [];
  return rawItems.filter((item) => normalizeMatchText(item.text || item.listTitle || '').includes(core));
}

async function scrollPage(page, opts, steps = opts.scrollSteps) {
  for (let i = 0; i < steps; i += 1) {
    await closeLoginPopups(page);
    await page.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.85))).catch(() => {});
    await sleep(650 + Math.floor(Math.random() * 650));
  }
}

async function searchKeyword(page, keyword, opts, run) {
  const urls = [
    `https://www.goofish.com/search?q=${encodeURIComponent(keyword)}`,
    `https://www.goofish.com/search?keyword=${encodeURIComponent(keyword)}`,
    `https://www.goofish.com/search?spm=a21ybx.seo.sitemap.2&q=${encodeURIComponent(keyword)}`,
  ];
  for (const url of urls) {
    const ok = await gotoPage(page, url, opts);
    if (!ok) continue;
    await scrollPage(page, opts, Math.max(4, Math.ceil(opts.scrollSteps / 2)));
    const rawItems = await collectItemLinks(page, Math.max(opts.maxCandidatesPerKeyword * 5, 30));
    let relevantItems = rawItems.filter((item) => isRelevantItem(item, keyword));
    if (!relevantItems.length) relevantItems = fallbackRelevantItems(rawItems, keyword);
    console.log(`    raw item links: ${rawItems.length}, relevant: ${relevantItems.length}`);
    if (relevantItems.length) return relevantItems.slice(0, opts.maxCandidatesPerKeyword);
    if (opts.debugSearch && run?.runDir) {
      const debugDir = path.join(run.runDir, 'debug_search_pages');
      await fs.mkdir(debugDir, { recursive: true });
      await fs.writeFile(path.join(debugDir, `${sanitizeSegment(keyword)}_${stamp()}_items.json`), JSON.stringify(rawItems.slice(0, 80), null, 2), 'utf8');
    }
  }
  return [];
}

function isPersonalPage(raw) {
  try {
    const url = new URL(raw);
    return /(^|\.)goofish\.com$/.test(url.hostname.toLowerCase()) && /\/personal\b/.test(url.pathname.toLowerCase());
  } catch {
    return false;
  }
}

function isLikelySellerUrl(raw) {
  return isPersonalPage(raw);
}

function compactSellerProfileName(text) {
  const markerIndex = text.search(/\s+(?:[\u4e00-\u9fff]{2,12}\s+)?(?:刚刚(?:来过|擦亮)|\d+\s*(?:分钟|小时|天)前来过|来闲鱼|卖出|好评率)/);
  const realMarkerIndex = text.search(/\s+(?:[\u4e00-\u9fff]{2,12}\s+)?(?:\u521a\u521a(?:\u6765\u8fc7|\u64e6\u4eae)|\d+\s*(?:\u5206\u949f|\u5c0f\u65f6|\u5929)\u524d\u6765\u8fc7|\u6765\u95f2\u9c7c|\u5356\u51fa|\u597d\u8bc4\u7387)/);
  const effectiveMarkerIndex = realMarkerIndex >= 0 ? realMarkerIndex : markerIndex;
  const compact = effectiveMarkerIndex > 0 ? text.slice(0, effectiveMarkerIndex).trim() : text;
  if (compact && compact.length <= 60) return compact;
  return compact.split(/\s+/)[0] || '';
}

function cleanSellerName(value) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  if (/^(登录|注册|立即登录|去登录|我想要|联系卖家|评价|信用及评价|信用和评价|查看更多)$/i.test(text)) return '';
  if (/安全验证|请输入验证码|拖动滑块|访问受限|风险验证|账号异常/.test(text)) return '';
  const compact = compactSellerProfileName(text);
  if (compact.length < 2 || compact.length > 120) return '';
  return compact;
}

function titleFromCardText(value) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  return text.split(/\s+¥|\s+￥|¥|￥/)[0].trim().slice(0, 120);
}

async function extractSellerProfileFromPage(page) {
  const links = await page
    .evaluate(() =>
      Array.from(document.querySelectorAll('a[href]')).map((a) => ({
        href: a.href || '',
        text: (a.innerText || a.getAttribute('title') || a.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 160),
      }))
    )
    .catch(() => []);
  const sellerLinks = links
    .map((link) => ({ ...link, href: normalizeUrl(link.href, page.url()) }))
    .filter((link) => link.href && isLikelySellerUrl(link.href));
  const withUserId = sellerLinks.find((link) => {
    try {
      return Boolean(new URL(link.href).searchParams.get('userId'));
    } catch {
      return false;
    }
  });
  const selected = withUserId || sellerLinks[0] || {};
  return { sellerUrl: selected.href || '', sellerName: cleanSellerName(selected.text) };
}

async function extractSellerNameFromPersonalPage(page) {
  return page
    .evaluate(() => {
      const selectors = [
        '[class*="nick"]',
        '[class*="name"]',
        '[class*="user"]',
        'h1',
        'h2',
      ];
      const values = [];
      for (const selector of selectors) {
        for (const el of document.querySelectorAll(selector)) {
          const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
          if (text && text.length >= 2 && text.length <= 120) values.push(text);
        }
      }
      const bodyText = (document.body.innerText || '').split(/\n+/).map((line) => line.trim().replace(/\s+/g, ' ')).filter(Boolean);
      values.push(...bodyText.slice(0, 8));
      return [...new Set(values)];
      return values.find((text) => /来闲鱼|卖出|好评率|分钟前来过|小时前来过|刚刚来过|刚刚擦亮/.test(text)) || values[0] || '';
    })
    .then((values) => (Array.isArray(values) ? values.map(cleanSellerName).find(Boolean) || '' : cleanSellerName(values)))
    .catch(() => '');
}

async function clickTextLike(context, page, regexSource, label, opts) {
  await closeLoginPopups(page);
  const beforePages = new Set(context.pages());
  const clicked = await page
    .evaluate((source) => {
      const re = new RegExp(source, 'i');
      function visible(el) {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      }
      const nodes = Array.from(document.querySelectorAll('a,button,[role="button"],span,div'))
        .map((el) => {
          const ownText = Array.from(el.childNodes)
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent || '')
            .join('')
            .trim()
            .replace(/\s+/g, ' ');
          const text = (ownText || el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.textContent || '')
            .trim()
            .replace(/\s+/g, ' ');
          return { el, text };
        })
        .filter(({ el, text }) => {
          if (!visible(el) || !text || text.length > 50 || !re.test(text)) return false;
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role') || '';
          const cls = typeof el.className === 'string' ? el.className : '';
          return tag === 'a' || tag === 'button' || role === 'button' || /tab|btn|button|link|rate|credit|evaluate|comment/i.test(cls) || text.length <= 12;
        })
        .sort((a, b) => {
          const ar = a.el.getBoundingClientRect();
          const br = b.el.getBoundingClientRect();
          return ar.top - br.top || ar.left - br.left;
        });
      const first = nodes[0];
      if (!first) return '';
      const target = first.el.closest('a,button,[role="button"]') || first.el;
      target.scrollIntoView({ block: 'center', inline: 'center' });
      target.click();
      return first.text.slice(0, 80);
    }, regexSource)
    .catch(() => '');
  if (!clicked) {
    console.warn(`    click not found: ${label}`);
    return { page, clicked: false };
  }
  console.log(`    clicked ${label}: ${clicked}`);
  await cleanAfterAction(page, opts);
  const newPages = context.pages().filter((p) => !beforePages.has(p) && !p.isClosed());
  if (newPages.length) {
    const newPage = newPages[newPages.length - 1];
    for (const extraPage of newPages.slice(0, -1)) {
      await extraPage.close().catch(() => {});
    }
    await newPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await cleanAfterAction(newPage, opts);
    await closeExtraPages(context, [newPage], opts);
    return { page: newPage, clicked: true };
  }
  await closeExtraPages(context, [page], opts);
  return { page, clicked: true };
}

async function navigateToImageReviews(context, page, opts) {
  await closeLoginPopups(page);
  await scrollPage(page, opts, 2);
  let active = page;
  let step = await clickTextLike(context, active, '好评率|卖家信用|信用分|芝麻信用', 'seller good-rate / reputation', opts);
  if (!step.clicked) return { page: active, status: 'good_rate_not_found', reviewUrl: active.url() };
  active = step.page;
  if (await isHardBlocked(active)) return { page: active, status: 'hard_blocked_after_good_rate', reviewUrl: active.url() };
  return navigatePersonalToImageReviews(context, active, opts);
}

async function navigatePersonalToImageReviews(context, page, opts) {
  await closeLoginPopups(page);
  await scrollPage(page, opts, 2);
  let active = page;
  let step = await clickTextLike(context, active, '信用及评价|信用和评价|信用评价', 'credit and reviews', opts);
  if (!step.clicked) step = await clickTextLike(context, active, '^评价$|^评价\\s*\\d*$', 'reviews tab', opts);
  if (!step.clicked) return { page: active, status: 'credit_reviews_not_found', reviewUrl: active.url() };
  active = step.page;
  const reviewUrl = active.url();
  if (await isHardBlocked(active)) return { page: active, status: 'hard_blocked_after_reviews', reviewUrl };
  await scrollPage(active, opts, 2);
  step = await clickTextLike(context, active, '^有图$|^有图\\s*\\d*$|^晒图$|^带图$', 'with pictures', opts);
  if (!step.clicked) return { page: active, status: 'with_pictures_not_found', reviewUrl };
  active = step.page;
  if (await isHardBlocked(active)) return { page: active, status: 'hard_blocked_after_has_image', reviewUrl: active.url() };
  return { page: active, status: 'ok', reviewUrl: active.url() };
}

async function extractImages(page) {
  return page.evaluate(() => {
    function abs(raw) {
      if (!raw) return '';
      let url = String(raw).trim();
      if (!url || url.startsWith('data:') || url.startsWith('blob:')) return '';
      if (url.startsWith('//')) url = `https:${url}`;
      try {
        return new URL(url, location.href).toString();
      } catch {
        return '';
      }
    }
    function visible(el) {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    }
    const tabCandidates = Array.from(document.querySelectorAll('a,button,[role="button"],span,div')).filter((el) => {
      if (!visible(el)) return false;
      const text = (el.innerText || el.textContent || '').trim();
      return /^有图(\s*\d+)?$|晒图|带图/.test(text);
    });
    const tabY = tabCandidates.length ? Math.min(...tabCandidates.map((el) => el.getBoundingClientRect().top + window.scrollY)) : 0;
    const out = [];
    for (const img of Array.from(document.querySelectorAll('img'))) {
      if (!visible(img)) continue;
      const rect = img.getBoundingClientRect();
      const docY = rect.top + window.scrollY;
      const alt = img.getAttribute('alt') || '';
      if (/头像|avatar|icon|logo|店铺|卖家/i.test(alt)) continue;
      if (rect.width < 90 || rect.height < 90) continue;
      if (tabY && docY < tabY - 40) continue;
      let parent = img;
      let contextText = '';
      for (let i = 0; i < 5 && parent; i += 1) {
        contextText = `${contextText} ${(parent.innerText || parent.textContent || '').trim()}`.slice(0, 1200);
        parent = parent.parentElement;
      }
      if (!/评价|有图|买家|卖家|信用|交易|满意|好评|差评|中评|追评|天前|小时前|分钟前|刚刚|\d{4}[-/年]\d{1,2}|\d+月\d+日/.test(contextText)) continue;
      const candidates = [];
      for (const attr of ['data-original', 'data-src', 'data-ks-lazyload', 'src', 'currentSrc']) {
        const value = attr === 'currentSrc' ? img.currentSrc : img.getAttribute(attr);
        const url = abs(value);
        if (url) candidates.push(url);
      }
      const srcset = img.getAttribute('srcset') || '';
      for (const part of srcset.split(',')) {
        const url = abs(part.trim().split(/\s+/)[0]);
        if (url) candidates.push(url);
      }
      const parentLink = img.closest('a[href]');
      const parentUrl = abs(parentLink?.getAttribute('href') || '');
      if (parentUrl && /\.(jpg|jpeg|png|webp)(_|$|\?)/i.test(parentUrl)) candidates.push(parentUrl);
      const url = candidates[0] || '';
      if (url) out.push({ url, candidates, source: 'strict-review-image', width: Math.round(rect.width), height: Math.round(rect.height), alt });
    }
    const seen = new Set();
    return out.filter((img) => {
      if (!img.url || seen.has(img.url)) return false;
      seen.add(img.url);
      return true;
    });
  });
}

async function collectReviewImagesByScrolling(page, opts) {
  const images = [];
  const seen = new Set();
  for (let i = 0; i <= opts.scrollSteps; i += 1) {
    await closeLoginPopups(page);
    const batch = await extractImages(page).catch(() => []);
    for (const image of batch) {
      if (!image.url || seen.has(image.url)) continue;
      seen.add(image.url);
      images.push(image);
    }
    if (i < opts.scrollSteps) {
      await page.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.82))).catch(() => {});
      await sleep(800 + Math.floor(Math.random() * 600));
    }
  }
  return images;
}

function originalImageCandidates(raw) {
  const url = normalizeUrl(raw);
  if (!url) return [];
  const out = [];
  try {
    const u = new URL(url);
    const originalMarker = u.pathname.match(/^(.+?-0-fleamarket\.(?:jpg|jpeg|png|webp))/i);
    if (originalMarker) {
      const clean = new URL(u.toString());
      clean.pathname = originalMarker[1];
      clean.search = '';
      out.push(clean.toString());
    }
    const firstExt = u.pathname.match(/^(.+?\.(?:jpg|jpeg|png|webp))_/i);
    if (firstExt) {
      const clean = new URL(u.toString());
      clean.pathname = firstExt[1];
      clean.search = '';
      out.push(clean.toString());
    }
    out.push(u.toString().replace(/_(?:\d+x\d+|Q\d+|\.webp|[^/?#]+)+/i, ''));
  } catch {
    // Ignore.
  }
  out.push(url);
  return [...new Set(out.filter(Boolean))];
}

function extensionFrom(url, contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('png')) return '.png';
  if (ct.includes('webp')) return '.webp';
  if (ct.includes('gif')) return '.gif';
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg';
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (/^\.(jpg|jpeg|png|webp|gif)$/.test(ext)) return ext === '.jpeg' ? '.jpg' : ext;
  } catch {
    // Ignore.
  }
  return '.jpg';
}

async function downloadImageFromCandidates(context, urls, tempPath, opts) {
  let lastError = '';
  for (const imageUrl of urls) {
    try {
      const response = await context.request.get(imageUrl, { timeout: opts.downloadTimeoutMs });
      if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
      const body = await response.body();
      await fs.writeFile(tempPath, body);
      return {
        imageUrl,
        hash: crypto.createHash('sha256').update(body).digest('hex'),
        bytes: body.length,
        contentType: response.headers()['content-type'] || '',
      };
    } catch (error) {
      lastError = `${imageUrl}: ${error.message}`;
    }
  }
  throw new Error(lastError || 'download failed');
}

async function inspectCandidatePage(context, item, keyword, opts) {
  const pagesBeforeInspect = new Set(context.pages());
  const keepPages = Array.from(pagesBeforeInspect).filter((itemPage) => !itemPage.isClosed());
  const page = await newManagedPage(context, opts, keepPages);
  try {
    const ok = await gotoPage(page, item.url, opts);
    if (!ok) {
      return { inspectStatus: 'open_item_failed_or_blocked', pageTitle: '', finalUrl: item.url, sellerUrl: '', sellerName: '', reviewUrl: '', hasImages: '', totalImages: 0 };
    }
    const pageTitle = titleFromCardText(item.listTitle) || await page.title().catch(() => '');
    const profile = await extractSellerProfileFromPage(page);
    let sellerName = profile.sellerName || '';
    let nav;
    if (profile.sellerUrl) {
      const opened = await gotoPage(page, profile.sellerUrl, opts);
      if (opened) {
        if (!sellerName) sellerName = await extractSellerNameFromPersonalPage(page);
        nav = await navigatePersonalToImageReviews(context, page, opts);
      } else {
        nav = { page, status: 'seller_open_failed', reviewUrl: profile.sellerUrl };
      }
    } else {
      nav = await navigateToImageReviews(context, page, opts);
    }
    const images = nav.status === 'ok' ? await collectReviewImagesByScrolling(nav.page, { ...opts, scrollSteps: Math.min(opts.scrollSteps, 8) }) : [];
    const sellerUrl = profile.sellerUrl || (isPersonalPage(nav.reviewUrl || '') ? nav.reviewUrl : '');
    if (!sellerName && sellerUrl) sellerName = await extractSellerNameFromPersonalPage(nav.page || page);
    return {
      inspectStatus: nav.status,
      pageTitle,
      finalUrl: page.url(),
      sellerUrl,
      sellerName,
      reviewUrl: nav.reviewUrl || sellerUrl || page.url(),
      hasImages: images.length > 0 ? 'yes' : 'no',
      totalImages: images.length,
    };
  } finally {
    for (const openedPage of context.pages()) {
      if (!pagesBeforeInspect.has(openedPage)) await openedPage.close().catch(() => {});
    }
  }
}

async function inspectExistingLinkRow(context, row, opts) {
  const pagesBeforeInspect = new Set(context.pages());
  const keepPages = Array.from(pagesBeforeInspect).filter((itemPage) => !itemPage.isClosed());
  const page = await newManagedPage(context, opts, keepPages);
  try {
    const knownSellerUrl = row.seller_url || (isPersonalPage(row.review_url) ? row.review_url : '');
    const startUrl = knownSellerUrl || row.item_url || row.review_url;
    if (!startUrl) return { status: 'missing_url', reviewUrl: '', hasImages: '', totalImages: 0 };
    const ok = await gotoPage(page, startUrl, opts);
    if (!ok) return { status: 'open_failed_or_blocked', reviewUrl: startUrl, hasImages: '', totalImages: 0 };
    const profile = !row.seller_url && !isPersonalPage(startUrl) ? await extractSellerProfileFromPage(page) : { sellerUrl: '', sellerName: '' };
    const sellerUrl = row.seller_url || profile.sellerUrl || (isPersonalPage(startUrl) ? startUrl : '');
    let sellerName = cleanSellerName(row.seller_name) || profile.sellerName || '';
    if (!sellerName && isPersonalPage(startUrl)) {
      sellerName = await extractSellerNameFromPersonalPage(page);
    }
    const nav = isPersonalPage(startUrl)
      ? await navigatePersonalToImageReviews(context, page, opts)
      : await navigateToImageReviews(context, page, opts);
    if (!sellerName && isPersonalPage(sellerUrl || nav.reviewUrl || startUrl)) {
      sellerName = await extractSellerNameFromPersonalPage(nav.page || page);
    }
    if (nav.status !== 'ok') {
      return { status: nav.status, sellerUrl, sellerName, reviewUrl: nav.reviewUrl || sellerUrl || startUrl, hasImages: 'no', totalImages: 0 };
    }
    const images = await collectReviewImagesByScrolling(nav.page, { ...opts, scrollSteps: Math.min(opts.scrollSteps, 8) });
    return {
      status: nav.status,
      sellerUrl,
      sellerName,
      reviewUrl: nav.reviewUrl || sellerUrl || nav.page.url(),
      hasImages: images.length ? 'yes' : 'no',
      totalImages: images.length,
    };
  } finally {
    for (const openedPage of context.pages()) {
      if (!pagesBeforeInspect.has(openedPage)) await openedPage.close().catch(() => {});
    }
  }
}

async function extractSellerNameForLinkRow(context, row, opts) {
  const page = await newManagedPage(context, opts);
  try {
    const knownSellerUrl = row.seller_url || (isPersonalPage(row.review_url) ? row.review_url : '');
    const startUrl = knownSellerUrl || row.item_url || row.review_url;
    if (!startUrl) return { status: 'missing_url', sellerUrl: '', sellerName: '' };
    const ok = await gotoPage(page, startUrl, opts);
    if (!ok) return { status: 'open_failed_or_blocked', sellerUrl: startUrl, sellerName: '' };

    if (isPersonalPage(startUrl)) {
      return {
        status: 'ok',
        sellerUrl: startUrl,
        sellerName: await extractSellerNameFromPersonalPage(page),
      };
    }

    const profile = await extractSellerProfileFromPage(page);
    const sellerUrl = row.seller_url || profile.sellerUrl || '';
    let sellerName = profile.sellerName || '';
    if (!sellerName && sellerUrl) {
      const sellerOk = await gotoPage(page, sellerUrl, opts);
      if (sellerOk) sellerName = await extractSellerNameFromPersonalPage(page);
    }
    return { status: sellerName ? 'ok' : 'seller_name_not_found', sellerUrl, sellerName };
  } finally {
    await page.close().catch(() => {});
  }
}

function mergeLinkRow(existing, update) {
  return {
    ...existing,
    ...update,
    images_downloaded: existing?.images_downloaded || update.images_downloaded || '0',
    images_remaining: update.images_remaining ?? existing?.images_remaining ?? '',
    image_status: existing?.image_status || update.image_status || (update.has_images === 'yes' ? 'pending' : 'skipped_no_images'),
  };
}

function buildSellerNameByUserId(rows) {
  const out = new Map();
  for (const row of rows) {
    const sellerId = userIdFromUrl(row.seller_url || row.review_url || '');
    const sellerName = cleanSellerName(row.seller_name);
    if (sellerId && sellerName && !out.has(sellerId)) out.set(sellerId, sellerName);
  }
  return out;
}

function fillSellerNamesFromKnownSellers(rows) {
  const bySellerId = buildSellerNameByUserId(rows);
  let filled = 0;
  for (const row of rows) {
    if (cleanSellerName(row.seller_name)) continue;
    const sellerId = userIdFromUrl(row.seller_url || row.review_url || '');
    const sellerName = sellerId ? bySellerId.get(sellerId) : '';
    if (sellerName) {
      row.seller_name = sellerName;
      filled += 1;
    }
  }
  return filled;
}

async function discoverLinks(context, keywords, opts, run) {
  const linkFile = linkStatePath(opts);
  const rows = await readCsvRows(linkFile, LINK_STATE_HEADERS);
  fillSellerNamesFromKnownSellers(rows);
  const byId = new Map(rows.map((row) => [row.link_id, row]));
  const seenCandidateKeys = new Set(rows.flatMap((row) => [row.link_id, itemKeyFromUrl(row.item_url), userIdFromUrl(row.seller_url)].filter(Boolean)));
  const batchCsv = path.join(run.runDir, 'candidate_links_batch.csv');
  await initCsv(batchCsv, LINK_STATE_HEADERS);
  const searchPage = await newManagedPage(context, opts);
  let written = 0;
  let inspected = 0;
  let invalidInspects = 0;
  let consecutiveInvalidInspects = 0;
  let refreshed = 0;
  const summary = [];
  const selectedKeywordSet = new Set(keywords.map((keyword) => String(keyword || '').trim().toLowerCase()).filter(Boolean));
  try {
    const refreshChecks = rows
      .filter((row) => row.seller_url || row.item_url || row.review_url)
      .filter((row) => !selectedKeywordSet.size || selectedKeywordSet.has(String(row.keyword || '').trim().toLowerCase()))
      .sort((a, b) => {
        const rank = (row) => {
          if (!String(row.seller_name || '').trim()) return -1;
          const status = hasImagesStatus(row);
          if (!['yes', 'no'].includes(status)) return 0;
          if (status === 'no') return 1;
          return 2;
        };
        const ra = rank(a);
        const rb = rank(b);
        if (ra !== rb) return ra - rb;
        return timestampMs(a.last_link_crawl_at) - timestampMs(b.last_link_crawl_at);
      });
    for (const row of refreshChecks) {
      if (refreshed >= opts.maxRefreshPages) break;
      refreshed += 1;
      console.log(`  refresh [${refreshed}/${opts.maxRefreshPages}]: ${row.link_id}`);
      const previousHasImages = hasImagesStatus(row);
      const result = await inspectExistingLinkRow(context, row, opts);
      row.seller_url = row.seller_url || result.sellerUrl || (isPersonalPage(row.review_url) ? row.review_url : '');
      row.seller_name = cleanSellerName(row.seller_name) || result.sellerName || '';
      row.review_url = result.reviewUrl || row.review_url || row.seller_url || row.item_url;
      row.has_images = result.hasImages || row.has_images || '';
      if (result.hasImages) row.total_images = String(result.totalImages || 0);
      row.images_downloaded = row.images_downloaded || '0';
      row.images_remaining = row.has_images === 'yes' ? String(Math.max(0, Number(row.total_images || 0) - Number(row.images_downloaded || 0))) : '0';
      row.link_status = result.status || row.link_status;
      if (row.has_images === 'yes') {
        const remaining = Number(row.images_remaining || 0);
        const downloaded = Number(row.images_downloaded || 0);
        if (remaining > 0) row.image_status = downloaded > 0 ? 'partial' : 'pending';
        else row.image_status = 'complete';
      } else if (row.has_images === 'no') {
        row.image_status = 'skipped_no_images';
      } else {
        row.image_status = row.image_status || 'unknown';
      }
      row.last_link_crawl_at = nowIso();
      byId.set(row.link_id, row);
      await closeExtraPages(context, [searchPage], opts);
      await randomDelay(opts);
    }

    for (const keyword of keywords.slice(0, opts.maxKeywords)) {
      if (written >= opts.maxCandidates) break;
      console.log(`\n== Discover keyword: ${keyword} ==`);
      const items = await searchKeyword(searchPage, keyword, opts, run);
      const current = { keyword, found: items.length, written: 0, skippedExisting: 0, inspected: 0 };
      summary.push(current);
      for (const item of items) {
        if (written >= opts.maxCandidates) break;
        const itemKey = itemKeyFromUrl(item.url);
        if (itemKey && seenCandidateKeys.has(itemKey)) {
          current.skippedExisting += 1;
          continue;
        }
        let inspection = { inspectStatus: 'not_inspected', pageTitle: '', sellerUrl: '', sellerName: '', reviewUrl: '', hasImages: '', totalImages: '' };
        const canInspect = inspected < opts.maxInspectPages
          && invalidInspects < opts.maxInvalidInspects
          && consecutiveInvalidInspects < opts.maxConsecutiveInvalidInspects;
        if (canInspect) {
          inspected += 1;
          current.inspected += 1;
          console.log(`  inspect [${inspected}/${opts.maxInspectPages}]: ${item.url}`);
          inspection = await inspectCandidatePage(context, item, keyword, opts);
          const invalid = inspection.hasImages !== 'yes';
          if (invalid) {
            invalidInspects += 1;
            consecutiveInvalidInspects += 1;
            console.log(`  invalid inspect streak: ${consecutiveInvalidInspects}/${opts.maxConsecutiveInvalidInspects}, total: ${invalidInspects}/${opts.maxInvalidInspects}`);
          } else {
            consecutiveInvalidInspects = 0;
          }
          await closeExtraPages(context, [searchPage], opts);
          await randomDelay(opts);
        } else if (inspected >= opts.maxInspectPages) {
          console.log(`  inspect limit reached: ${opts.maxInspectPages}`);
        } else {
          console.log(`  invalid inspect limit reached: total ${invalidInspects}/${opts.maxInvalidInspects}, streak ${consecutiveInvalidInspects}/${opts.maxConsecutiveInvalidInspects}`);
          break;
        }
        const linkId = linkIdFrom({ itemUrl: item.url, sellerUrl: inspection.sellerUrl, reviewUrl: inspection.reviewUrl });
        if (byId.has(linkId)) {
          current.skippedExisting += 1;
          continue;
        }
        const totalImages = String(inspection.totalImages || 0);
        const row = {
          link_id: linkId,
          keyword,
          item_url: item.url,
          seller_url: inspection.sellerUrl || '',
          review_url: inspection.reviewUrl || inspection.sellerUrl || item.url,
          seller_name: cleanSellerName(inspection.sellerName) || '',
          item_title: titleFromCardText(inspection.pageTitle || item.listTitle) || '',
          card_text: item.listTitle || '',
          has_images: inspection.hasImages || '',
          total_images: totalImages,
          images_downloaded: '0',
          images_remaining: inspection.hasImages === 'yes' ? totalImages : '0',
          link_status: inspection.inspectStatus || 'not_inspected',
          image_status: inspection.hasImages === 'yes' ? 'pending' : inspection.hasImages === 'no' ? 'skipped_no_images' : 'unknown',
          last_link_crawl_at: nowIso(),
          last_image_crawl_at: '',
          notes: '',
        };
        byId.set(linkId, mergeLinkRow(byId.get(linkId), row));
        seenCandidateKeys.add(linkId);
        if (itemKey) seenCandidateKeys.add(itemKey);
        const sellerId = userIdFromUrl(row.seller_url);
        if (sellerId) seenCandidateKeys.add(sellerId);
        written += 1;
        current.written += 1;
        await appendCsv(batchCsv, LINK_STATE_HEADERS.map((header) => row[header] ?? ''));
        await writeCsvRows(linkFile, LINK_STATE_HEADERS, Array.from(byId.values()));
      }
    }
  } finally {
    await searchPage.close().catch(() => {});
  }
  await writeCsvRows(linkFile, LINK_STATE_HEADERS, Array.from(byId.values()));
  return { linkFile, batchCsv, summary, written, inspected };
}

async function refreshSellerNames(context, opts, run) {
  const linkFile = linkStatePath(opts);
  const rows = await readCsvRows(linkFile, LINK_STATE_HEADERS);
  const filledFromKnown = fillSellerNamesFromKnownSellers(rows);
  const selectedKeywordSet = new Set(parseList(opts.keywords).map((keyword) => keyword.toLowerCase()));
  const bySellerId = new Map();
  for (const row of rows) {
    if (selectedKeywordSet.size && !selectedKeywordSet.has(String(row.keyword || '').trim().toLowerCase())) continue;
    const sellerId = sellerIdFromLinkRow(row);
    if (!sellerId || sellerId === 'unknown') continue;
    if (!bySellerId.has(sellerId)) bySellerId.set(sellerId, []);
    bySellerId.get(sellerId).push(row);
  }

  const candidates = Array.from(bySellerId.entries())
    .filter(([, sellerRows]) => !sellerRows.some((row) => cleanSellerName(row.seller_name)))
    .map(([sellerId, sellerRows]) => ({
      sellerId,
      sellerRows,
      row: sellerRows.find((item) => item.seller_url || isPersonalPage(item.review_url)) || sellerRows[0],
    }))
    .filter((item) => item.row && (item.row.seller_url || item.row.review_url || item.row.item_url))
    .slice(0, Math.max(1, opts.maxSellerNamesPerRun));

  const batchCsv = path.join(run.runDir, 'seller_name_refresh_batch.csv');
  await initCsv(batchCsv, ['crawled_at', 'seller_id', 'link_id', 'seller_url', 'seller_name', 'status']);
  let updatedSellers = 0;
  let updatedLinks = filledFromKnown;

  for (const item of candidates) {
    console.log(`\n== Refresh seller name: ${item.sellerId} ==`);
    const result = await extractSellerNameForLinkRow(context, item.row, opts);
    const sellerName = cleanSellerName(result.sellerName);
    const sellerUrl = result.sellerUrl || item.row.seller_url || item.row.review_url || '';
    if (sellerName) {
      updatedSellers += 1;
      for (const row of item.sellerRows) {
        if (!cleanSellerName(row.seller_name)) {
          row.seller_name = sellerName;
          updatedLinks += 1;
        }
        if (!row.seller_url && sellerUrl) row.seller_url = sellerUrl;
        row.last_link_crawl_at = nowIso();
      }
    }
    await appendCsv(batchCsv, [nowIso(), item.sellerId, item.row.link_id, sellerUrl, sellerName, result.status]);
    await writeCsvRows(linkFile, LINK_STATE_HEADERS, rows);
    await randomDelay(opts);
  }

  await writeCsvRows(linkFile, LINK_STATE_HEADERS, rows);
  return {
    linkFile,
    batchCsv,
    candidates: candidates.length,
    filledFromKnown,
    updatedSellers,
    updatedLinks,
  };
}

async function downloadImagesForLink(context, linkRow, opts, run, linkRows, imageRows) {
  const page = await newManagedPage(context, opts);
  const linkId = linkRow.link_id;
  const sellerId = sellerIdFromLinkRow(linkRow);
  const byImageId = new Map(imageRows.map((row) => [row.image_id, row]));
  const bySellerDedupKey = new Map();
  for (const row of imageRows) {
    const rowSellerId = row.seller_id || sellerIdFromLinkRow(row);
    if (rowSellerId !== sellerId) continue;
    for (const key of imageDedupKeys(row)) {
      if (!bySellerDedupKey.has(key)) bySellerDedupKey.set(key, row);
    }
  }
  const savedCount = () => imageRows.filter((row) => (row.seller_id || sellerIdFromLinkRow(row)) === sellerId && isHandledImage(row)).length;
  let downloadedThisLink = 0;
  try {
    const startUrl = linkRow.seller_url || linkRow.item_url || linkRow.review_url;
    const ok = await gotoPage(page, startUrl, opts);
    if (!ok) {
      linkRow.link_status = 'open_failed_or_blocked';
      linkRow.image_status = 'open_failed_or_blocked';
      linkRow.last_image_crawl_at = nowIso();
      return { found: 0, downloaded: 0, status: linkRow.image_status };
    }
    const nav = isPersonalPage(startUrl)
      ? await navigatePersonalToImageReviews(context, page, opts)
      : await navigateToImageReviews(context, page, opts);
    linkRow.review_url = nav.reviewUrl || linkRow.review_url || page.url();
    if (nav.status !== 'ok') {
      linkRow.has_images = 'no';
      linkRow.link_status = nav.status;
      linkRow.image_status = nav.status;
      linkRow.last_image_crawl_at = nowIso();
      return { found: 0, downloaded: 0, status: nav.status };
    }
    const images = await collectReviewImagesByScrolling(nav.page, opts);
    linkRow.has_images = images.length ? 'yes' : 'no';
    linkRow.total_images = String(images.length);
    const itemDir = path.resolve(opts.imagesRoot, sanitizeSegment(sellerId));
    await fs.mkdir(itemDir, { recursive: true });
    for (let index = 0; index < images.length; index += 1) {
      if (run.imagesDownloaded >= opts.maxImagesPerRun) break;
      const image = images[index];
      const thumbUrl = normalizeUrl(image.url, nav.page.url());
      if (!thumbUrl) continue;
      const candidates = [...new Set([...(image.candidates || []), thumbUrl].flatMap(originalImageCandidates))];
      const originalUrl = candidates[0] || thumbUrl;
      const imageId = imageIdFrom(sellerId, originalUrl, thumbUrl);
      const urlDedup = bySellerDedupKey.get(originalUrl) || bySellerDedupKey.get(thumbUrl);
      if (isHandledImage(urlDedup)) {
        urlDedup.seller_id = urlDedup.seller_id || sellerId;
        continue;
      }
      const existing = byImageId.get(imageId);
      if (isHandledImage(existing)) continue;
      const tempPath = path.join(itemDir, `${String(index + 1).padStart(3, '0')}_${imageId.slice(0, 12)}.tmp`);
      let row = {
        image_id: imageId,
        seller_id: sellerId,
        link_id: linkId,
        keyword: linkRow.keyword,
        seller_url: linkRow.seller_url,
        review_url: linkRow.review_url,
        thumb_url: thumbUrl,
        original_url: originalUrl,
        local_path: '',
        source: image.source || '',
        width: String(image.width || ''),
        height: String(image.height || ''),
        content_type: '',
        bytes: '',
        sha256: '',
        status: 'pending',
        downloaded_at: '',
        notes: '',
      };
      try {
        const downloaded = await downloadImageFromCandidates(context, candidates, tempPath, opts);
        const finalPath = path.join(itemDir, `${String(index + 1).padStart(3, '0')}_${downloaded.hash.slice(0, 16)}${extensionFrom(downloaded.imageUrl, downloaded.contentType)}`);
        await fs.rename(tempPath, finalPath).catch(async () => {
          await fs.copyFile(tempPath, finalPath);
          await fs.unlink(tempPath).catch(() => {});
        });
        row = {
          ...row,
          original_url: downloaded.imageUrl,
          local_path: finalPath,
          content_type: downloaded.contentType,
          bytes: String(downloaded.bytes),
          sha256: downloaded.hash,
          status: downloaded.imageUrl === thumbUrl ? 'saved_fallback_thumb' : 'saved_original',
          downloaded_at: nowIso(),
        };
        const shaDedup = bySellerDedupKey.get(downloaded.hash);
        if (isHandledImage(shaDedup)) {
          shaDedup.seller_id = shaDedup.seller_id || sellerId;
          await fs.unlink(finalPath).catch(() => {});
          continue;
        }
        bySellerDedupKey.set(downloaded.hash, row);
        bySellerDedupKey.set(downloaded.imageUrl, row);
        downloadedThisLink += 1;
        run.imagesDownloaded += 1;
      } catch (error) {
        row.status = 'download_failed';
        row.notes = error.message;
        await fs.unlink(tempPath).catch(() => {});
      }
      if (byImageId.has(imageId)) Object.assign(byImageId.get(imageId), row);
      else {
        byImageId.set(imageId, row);
        imageRows.push(row);
      }
      bySellerDedupKey.set(originalUrl, row);
      bySellerDedupKey.set(thumbUrl, row);
      const downloadedCount = savedCount();
      linkRow.images_downloaded = String(downloadedCount);
      linkRow.images_remaining = String(Math.max(0, Number(linkRow.total_images || images.length) - downloadedCount));
      linkRow.image_status = Number(linkRow.images_remaining) > 0 ? 'partial' : 'complete';
      linkRow.last_image_crawl_at = nowIso();
      await writeCsvRows(imageStatePath(opts), IMAGE_STATE_HEADERS, imageRows);
      await writeCsvRows(linkStatePath(opts), LINK_STATE_HEADERS, linkRows);
      await randomDelay(opts);
    }
    const downloadedCount = savedCount();
    linkRow.images_downloaded = String(downloadedCount);
    linkRow.images_remaining = String(Math.max(0, Number(linkRow.total_images || images.length) - downloadedCount));
    linkRow.has_images = images.length ? 'yes' : 'no';
    linkRow.image_status = images.length && Number(linkRow.images_remaining) <= 0 ? 'complete' : images.length ? 'partial' : 'skipped_no_images';
    linkRow.link_status = images.length ? 'review_images_found' : 'with_pictures_not_found';
    linkRow.last_image_crawl_at = nowIso();
    syncSellerImageStateToLinks(linkRow, linkRows, imageRows);
    return { found: images.length, downloaded: downloadedThisLink, status: linkRow.image_status };
  } finally {
    await page.close().catch(() => {});
  }
}

async function downloadImages(context, opts, run) {
  const linkFile = linkStatePath(opts);
  const imageFile = imageStatePath(opts);
  const linkRows = await readCsvRows(linkFile, LINK_STATE_HEADERS);
  const imageRows = await readCsvRows(imageFile, IMAGE_STATE_HEADERS);
  if (!linkRows.length) {
    console.log(`No link state found: ${linkFile}`);
    return { processedLinks: 0, downloadedImages: 0 };
  }
  const selectedIds = new Set(parseList(opts.linkIds));
  const manualSelection = selectedIds.size > 0;
  const requestedRows = selectedIds.size ? linkRows.filter((row) => selectedIds.has(row.link_id)) : linkRows;
  const skippedNoImages = requestedRows.filter((row) => manualSelection ? hasImagesStatus(row) === 'no' : hasImagesStatus(row) !== 'yes').length;
  const candidatesBeforeSellerDedupe = requestedRows.filter((row) => {
    const hasImages = hasImagesStatus(row);
    const status = imageStatus(row);
    if (manualSelection) {
      if (hasImages === 'no') return false;
    } else if (hasImages !== 'yes') {
      return false;
    }
    if (hasImages === 'yes' && status === 'complete') return false;
    const total = Number(row.total_images || 0);
    const done = Number(row.images_downloaded || 0);
    return hasImages !== 'yes' || !total || done < total || status === 'pending' || status === 'partial';
  });
  const bySeller = new Map();
  for (const row of candidatesBeforeSellerDedupe) {
    const sellerId = sellerIdFromLinkRow(row);
    if (!bySeller.has(sellerId)) bySeller.set(sellerId, row);
  }
  const candidates = Array.from(bySeller.values());
  const selected = candidates.slice(0, opts.maxLinksPerRun);
  const batchCsv = path.join(run.runDir, 'image_download_batch.csv');
  await initCsv(batchCsv, ['crawled_at', 'link_id', 'seller_url', 'review_url', 'found', 'downloaded', 'status']);
  if (skippedNoImages) {
    console.log(manualSelection
      ? `Skip ${skippedNoImages} selected links because they are confirmed no-images.`
      : `Skip ${skippedNoImages} links because has_images is not yes.`);
  }
  if (!selected.length && requestedRows.length) {
    console.log('No links need image download after filtering has_images=yes and incomplete status.');
  }
  for (const row of selected) {
    if (run.imagesDownloaded >= opts.maxImagesPerRun) break;
    console.log(`\n== Download review images: ${row.link_id} ==`);
    const result = await downloadImagesForLink(context, row, opts, run, linkRows, imageRows);
    await appendCsv(batchCsv, [nowIso(), row.link_id, row.seller_url, row.review_url, result.found, result.downloaded, result.status]);
    await writeCsvRows(linkFile, LINK_STATE_HEADERS, linkRows);
    await writeCsvRows(imageFile, IMAGE_STATE_HEADERS, imageRows);
  }
  return { processedLinks: selected.length, skippedNoImages, downloadedImages: run.imagesDownloaded, batchCsv };
}

async function getContext(chromium, opts) {
  if (opts.cdpUrl) {
    try {
      const browser = await chromium.connectOverCDP(opts.cdpUrl);
      const context = browser.contexts()[0] || (await browser.newContext());
      return { browser, context, ownsContext: false };
    } catch (error) {
      console.warn(`CDP connect failed: ${error.message}`);
      console.warn('Fallback to launching Edge through Playwright.');
    }
  }
  await clearSessionRestoreFiles(opts.userDataDir);
  const context = await chromium.launchPersistentContext(path.resolve(opts.userDataDir), {
    channel: opts.channel,
    headless: false,
    viewport: { width: 1440, height: 1000 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    acceptDownloads: false,
  });
  return { browser: null, context, ownsContext: true };
}

async function main() {
  const opts = clampDiscoverOptions(parseArgs(process.argv.slice(2)));
  if (!['discover-links', 'download-images', 'refresh-seller-names'].includes(opts.mode)) {
    throw new Error(`Unsupported mode: ${opts.mode}. Use --mode discover-links, download-images, or refresh-seller-names.`);
  }
  await fs.mkdir(path.resolve(opts.dataDir), { recursive: true });
  await fs.mkdir(path.resolve(opts.imagesRoot), { recursive: true });
  const runDir = path.resolve(opts.logsDir, `run_${stamp()}_${opts.mode}`);
  await fs.mkdir(runDir, { recursive: true });
  const run = { runDir, imagesDownloaded: 0 };
  const { chromium } = loadPlaywright();
  const { browser, context, ownsContext } = await getContext(chromium, opts);
  context.setDefaultTimeout(15000);
  if (ownsContext) {
    await sleep(1000);
    await closeAllOpenPages(context, 'browser pages');
  }
  console.log(`Mode: ${opts.mode}`);
  console.log(`Run folder: ${runDir}`);
  try {
    if (opts.mode === 'discover-links') {
      const keywords = await loadKeywords(opts);
      console.log(`Keywords: ${keywords.join(', ') || '(none)'}`);
      const result = await discoverLinks(context, keywords, opts, run);
      const sellerNameResult = opts.skipSellerNameRefresh
        ? { skipped: true, updatedSellers: 0, updatedLinks: 0 }
        : await refreshSellerNames(context, opts, run);
      result.sellerNameRefresh = sellerNameResult;
      await fs.writeFile(path.join(runDir, 'summary.json'), JSON.stringify(result.summary, null, 2), 'utf8');
      await fs.writeFile(path.join(runDir, 'run_config.json'), JSON.stringify(opts, null, 2), 'utf8');
      console.log('\nDone.');
      console.log(`Link state: ${result.linkFile}`);
      console.log(`Batch CSV: ${result.batchCsv}`);
      console.log(`Links written this run: ${result.written}`);
      console.log(opts.skipSellerNameRefresh ? 'Seller name refresh skipped.' : `Seller names updated: ${sellerNameResult.updatedSellers}`);
      return;
    }
    if (opts.mode === 'refresh-seller-names') {
      const result = await refreshSellerNames(context, opts, run);
      await fs.writeFile(path.join(runDir, 'run_config.json'), JSON.stringify(opts, null, 2), 'utf8');
      await fs.writeFile(path.join(runDir, 'summary.json'), JSON.stringify(result, null, 2), 'utf8');
      console.log('\nDone.');
      console.log(`Link state: ${result.linkFile}`);
      console.log(`Batch CSV: ${result.batchCsv}`);
      console.log(`Seller names updated: ${result.updatedSellers}`);
      return;
    }
    const result = await downloadImages(context, opts, run);
    await fs.writeFile(path.join(runDir, 'run_config.json'), JSON.stringify(opts, null, 2), 'utf8');
    console.log('\nDone.');
    console.log(`Link state: ${linkStatePath(opts)}`);
    console.log(`Image state: ${imageStatePath(opts)}`);
    console.log(`Downloaded images this run: ${result.downloadedImages}`);
  } finally {
    await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

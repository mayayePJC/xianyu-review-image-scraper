#!/usr/bin/env node
'use strict';

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');

const ROOT_DIR = path.basename(__dirname).toLowerCase() === '_internal' ? path.resolve(__dirname, '..') : __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const SITE_DIR = path.join(ROOT_DIR, 'site');
const ASSETS_DIR = path.join(SITE_DIR, 'assets');
const LINK_STATE_FILE = path.join(DATA_DIR, 'link_state.csv');
const IMAGE_STATE_FILE = path.join(DATA_DIR, 'image_state.csv');
const KEYWORD_STATE_FILE = path.join(DATA_DIR, 'keyword_state.csv');
const IMAGE_UID_EXPORT_FILE = path.join(SITE_DIR, 'image_uid_export.csv');
const KEYWORD_CONFIG_FILE = path.join(ROOT_DIR, 'config', 'xianyu_keywords.txt');
const LOCAL_DEFAULTS_FILE = path.join(ROOT_DIR, 'config', 'xianyu_local_defaults.json');
function loadLocalDefaults() {
  try {
    const raw = fsSync.readFileSync(LOCAL_DEFAULTS_FILE, 'utf8');
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
const LOCAL_DEFAULTS = loadLocalDefaults();
const DEFAULT_KEYWORD_TYPE = String(LOCAL_DEFAULTS.keyword_type || LOCAL_DEFAULTS.keywordType || 'general').trim() || 'general';
const DEFAULT_GAME_NAME = String(LOCAL_DEFAULTS.game_name || LOCAL_DEFAULTS.gameName || 'default').trim() || 'default';

function parseCsv(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '');
  const records = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      records.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }

  if (cell.length || row.length) {
    row.push(cell);
    records.push(row);
  }

  if (!records.length) return [];
  const headers = records[0].map((header) => String(header || '').trim());
  return records.slice(1).filter((record) => record.some((value) => String(value || '').length)).map((record) => {
    const out = {};
    headers.forEach((header, index) => {
      out[header] = record[index] ?? '';
    });
    return out;
  });
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function readCsv(file) {
  try {
    return parseCsv(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
}

async function writeCsv(file, headers, rows) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body = [headers.join(','), ...rows.map((row) => headers.map((header) => csvEscape(row[header] ?? '')).join(','))].join('\r\n');
  await fs.writeFile(file, `${body}\r\n`, 'utf8');
}

async function writeImageUidExport(images) {
  const headers = ['image_id', 'updated_at', 'uid'];
  const rows = images
    .filter((image) => statusValue(image.usable) === 'yes' && cleanText(image.uid))
    .map((image, index) => ({
      image_id: cleanText(image.image_id || image.sha256 || String(index + 1)),
      updated_at: cleanText(image.updated_at || image.downloaded_at),
      uid: cleanText(image.uid),
    }));
  await writeCsv(IMAGE_UID_EXPORT_FILE, headers, rows);
}

async function readKeywordLines(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return raw
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeDomPart(value) {
  const safe = String(value || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');
  return safe.replace(/^_+|_+$/g, '') || 'unknown';
}

function linkAnchor(linkId) {
  return `link-${safeDomPart(linkId)}`;
}

function sellerAnchor(sellerId) {
  return `seller-${safeDomPart(sellerId)}`;
}

function imageGroupAnchor(linkId) {
  return `images-${safeDomPart(linkId)}`;
}

function sellerImageGroupAnchor(sellerId) {
  return `images-${safeDomPart(sellerId)}`;
}

function imageAnchor(imageId, index) {
  return `image-${safeDomPart(imageId || index + 1)}`;
}

function imagePageHref(linkId) {
  const encodedLinkId = encodeURIComponent(String(linkId || ''));
  return `images.html?link_id=${encodedLinkId}#${imageGroupAnchor(linkId)}`;
}

function sellerPageHref(sellerId) {
  return `sellers.html#${sellerAnchor(sellerId)}`;
}

function sellerImagePageHref(sellerId) {
  const encodedSellerId = encodeURIComponent(String(sellerId || ''));
  return `images.html?seller_id=${encodedSellerId}#${sellerImageGroupAnchor(sellerId)}`;
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function shortText(value, maxLength) {
  const text = cleanText(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}...`;
}

function numberValue(value) {
  const parsed = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function timestampMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : 0;
}

function statusValue(value, fallback = 'unknown') {
  return cleanText(value || fallback).toLowerCase() || fallback;
}

const STATUS_LABELS = {
  yes: '有图',
  no: '无图',
  unknown: '未知',
  pending: '待爬图',
  partial: '部分完成',
  complete: '已完成',
  skipped_no_images: '无图跳过',
  has_images: '有图片',
  review_images_found: '找到带图评价',
  not_inspected: '未检查',
  imported_unchecked: '导入未检查',
  with_pictures_not_found: '未找到带图评价',
  open_failed_or_blocked: '打开失败/受限',
  open_item_failed_or_blocked: '商品打开失败/受限',
  seller_open_failed: '卖家页打开失败',
  missing_url: '缺少链接',
  saved_original: '已存原图',
  saved_fallback_thumb: '已存缩略图',
  discarded_no_uid: '无 UID 已清理',
  download_failed: '下载失败',
  local_path_missing: '本地缺失',
  high_confidence: '高置信',
  low_confidence: '低置信',
  none: '无',
};

function statusLabel(value) {
  const key = statusValue(value);
  return STATUS_LABELS[key] || cleanText(value || '未知');
}

function badge(value) {
  const raw = cleanText(value || 'unknown');
  const klass = statusValue(raw).replace(/[^a-z0-9_-]/g, '-');
  const label = statusLabel(raw);
  const title = label === raw ? '' : ` title="${escapeHtml(raw)}"`;
  return `<span class="badge badge-${escapeHtml(klass)}"${title}>${escapeHtml(label)}</span>`;
}

function uidUsableLabel(value) {
  const key = statusValue(value);
  if (key === 'yes') return 'UID 可用';
  if (key === 'no') return 'UID 不可用';
  return '未判断';
}

function uidUsableBadge(value) {
  const raw = statusValue(value);
  const klass = raw.replace(/[^a-z0-9_-]/g, '-');
  return `<span class="badge badge-${escapeHtml(klass)}" title="${escapeHtml(raw)}">${escapeHtml(uidUsableLabel(raw))}</span>`;
}

function safeExternalHref(rawUrl) {
  const url = cleanText(rawUrl);
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function externalLink(rawUrl, label) {
  const href = safeExternalHref(rawUrl);
  if (!href) return '<span class="muted">-</span>';
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`;
}

function userIdFromUrl(rawUrl) {
  try {
    return new URL(cleanText(rawUrl)).searchParams.get('userId') || '';
  } catch {
    return '';
  }
}

function sellerIdFromLink(link) {
  const explicit = cleanText(link.seller_id);
  if (explicit) return explicit;
  const userId = userIdFromUrl(link.seller_url || link.review_url || '');
  if (userId) return `seller_${userId}`;
  const linkId = cleanText(link.link_id);
  if (linkId.startsWith('seller_')) return linkId;
  return linkId || 'unknown';
}

function sellerIdFromImage(image, linkById) {
  const explicit = cleanText(image.seller_id);
  if (explicit) return explicit;
  const linkId = cleanText(image.link_id);
  const link = linkById.get(linkId);
  if (link) return sellerIdFromLink(link);
  const userId = userIdFromUrl(image.seller_url || image.review_url || '');
  if (userId) return `seller_${userId}`;
  if (linkId.startsWith('seller_')) return linkId;
  return linkId || 'unknown';
}

function imageDedupKey(image) {
  return cleanText(image.sha256) || cleanText(image.original_url) || cleanText(image.thumb_url) || cleanText(image.image_id);
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
  const text = cleanText(value);
  if (/^(登录|注册|立即登录|去登录|我想要|联系卖家|评价|信用及评价|信用和评价|查看更多)$/i.test(text)) return '';
  return compactSellerProfileName(text);
}

function normalizeLinkSellerNames(links) {
  const known = new Map();
  for (const link of links) {
    const sellerId = userIdFromUrl(link.seller_url || link.review_url);
    const sellerName = cleanSellerName(link.seller_name);
    if (sellerId && sellerName && !known.has(sellerId)) known.set(sellerId, sellerName);
  }
  for (const link of links) {
    const sellerId = userIdFromUrl(link.seller_url || link.review_url);
    const sellerName = cleanSellerName(link.seller_name);
    link.seller_name = sellerName || (sellerId ? known.get(sellerId) || '' : '');
  }
}

function sellerDisplayName(link) {
  const name = cleanSellerName(link.seller_name);
  if (name) return shortText(name, 42);
  return '待抓卖家名';
}

function sellerNameCell(link) {
  const label = sellerDisplayName(link);
  const href = safeExternalHref(link.seller_url || link.review_url);
  const content = href && label !== '-'
    ? `<a class="strong seller-name-link" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`
    : `<span class="strong">${escapeHtml(label)}</span>`;
  return `${content}<div class="small">${escapeHtml(cleanText(link.keyword) || '-')}</div>`;
}

function localImageHref(localPath) {
  const input = cleanText(localPath);
  if (!input) return '';
  const absolute = path.isAbsolute(input) ? input : path.resolve(ROOT_DIR, input);
  const relative = path.relative(SITE_DIR, absolute).replace(/\\/g, '/');
  if (!relative || relative.startsWith('..\\')) return '';
  return encodeURI(relative).replace(/#/g, '%23');
}

function formatBytes(value) {
  const bytes = numberValue(value);
  if (!bytes) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatDate(value) {
  const raw = cleanText(value);
  if (!raw) return '-';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function groupImagesByLink(images) {
  const groups = new Map();
  for (const image of images) {
    const linkId = cleanText(image.link_id || 'unknown');
    if (!groups.has(linkId)) groups.set(linkId, []);
    groups.get(linkId).push(image);
  }
  return groups;
}

function groupImagesBySeller(images, links) {
  const linkById = new Map(links.map((link) => [cleanText(link.link_id), link]));
  const groups = new Map();
  for (const image of images) {
    const sellerId = sellerIdFromImage(image, linkById);
    if (!groups.has(sellerId)) groups.set(sellerId, []);
    groups.get(sellerId).push(image);
  }
  return groups;
}

function dedupeImages(images) {
  const byKey = new Map();
  const score = (image) => {
    let value = 0;
    if (localImageHref(image.local_path)) value += 8;
    if (statusValue(image.status).startsWith('saved')) value += 4;
    if (statusValue(image.usable) === 'yes') value += 3;
    if (cleanText(image.uid)) value += 2;
    if (cleanText(image.sha256)) value += 1;
    return value;
  };
  for (const image of images) {
    const key = imageDedupKey(image);
    if (!key) continue;
    const previous = byKey.get(key);
    if (!previous || score(image) > score(previous)) byKey.set(key, image);
  }
  return Array.from(byKey.values());
}

function buildSellerRows(links, imagesBySeller, keywordByText) {
  const sellers = new Map();
  for (const link of links) {
    const sellerId = sellerIdFromLink(link);
    if (!sellers.has(sellerId)) {
      sellers.set(sellerId, {
        seller_id: sellerId,
        links: [],
        images: [],
        keywords: new Set(),
        keywordTypes: new Set(),
        gameNames: new Set(),
      });
    }
    const seller = sellers.get(sellerId);
    seller.links.push(link);
    const keyword = cleanText(link.keyword);
    if (keyword) seller.keywords.add(keyword);
    seller.keywordTypes.add(keywordTypeOf(keyword, keywordByText));
    seller.gameNames.add(gameNameOf(keyword, keywordByText));
  }
  for (const [sellerId, sellerImages] of imagesBySeller.entries()) {
    if (!sellers.has(sellerId)) {
      sellers.set(sellerId, {
        seller_id: sellerId,
        links: [],
        images: [],
        keywords: new Set(),
        keywordTypes: new Set(),
        gameNames: new Set(),
      });
    }
    sellers.get(sellerId).images = dedupeImages(sellerImages);
    sellers.get(sellerId).rawImageCount = sellerImages.length;
  }
  for (const seller of sellers.values()) {
    seller.images = seller.images.length ? seller.images : dedupeImages(imagesBySeller.get(seller.seller_id) || []);
    seller.rawImageCount = seller.rawImageCount || (imagesBySeller.get(seller.seller_id) || []).length;
    seller.links.sort((a, b) => timestampMs(b.last_link_crawl_at || b.last_image_crawl_at) - timestampMs(a.last_link_crawl_at || a.last_image_crawl_at));
    seller.primaryLink = seller.links.find((link) => cleanSellerName(link.seller_name)) || seller.links[0] || {};
    seller.lastLinkCrawlAt = seller.links.reduce((latest, link) => {
      const value = timestampMs(link.last_link_crawl_at);
      return value > timestampMs(latest) ? link.last_link_crawl_at : latest;
    }, '');
    seller.lastImageCrawlAt = seller.links.reduce((latest, link) => {
      const value = timestampMs(link.last_image_crawl_at);
      return value > timestampMs(latest) ? link.last_image_crawl_at : latest;
    }, '');
    seller.hasImages = seller.links.some((link) => statusValue(link.has_images) === 'yes') || seller.images.length ? 'yes'
      : seller.links.some((link) => statusValue(link.has_images) === 'no') ? 'no'
        : 'unknown';
    seller.imageStatus = seller.images.length ? (seller.links.some((link) => statusValue(link.image_status) !== 'complete') ? 'partial' : 'complete')
      : seller.links.some((link) => statusValue(link.image_status) === 'skipped_no_images') ? 'skipped_no_images'
        : 'unknown';
  }
  return Array.from(sellers.values()).sort((a, b) => {
    const byImages = b.images.length - a.images.length;
    if (byImages) return byImages;
    const byLinks = b.links.length - a.links.length;
    if (byLinks) return byLinks;
    return a.seller_id.localeCompare(b.seller_id, 'zh-CN');
  });
}

function keywordKey(value) {
  return cleanText(value).toLowerCase();
}

function keywordTypeOf(keyword, keywordByText) {
  const row = keywordByText.get(keywordKey(keyword));
  return cleanText(row?.keyword_type) || DEFAULT_KEYWORD_TYPE;
}

function gameNameOf(keyword, keywordByText) {
  const row = keywordByText.get(keywordKey(keyword));
  return cleanText(row?.game_name) || DEFAULT_GAME_NAME;
}

function keywordTypeOptions(keywords) {
  return [...new Set(keywords.map((row) => cleanText(row.keyword_type) || DEFAULT_KEYWORD_TYPE))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function gameNameOptions(keywords) {
  return [...new Set(keywords.map((row) => cleanText(row.game_name) || DEFAULT_GAME_NAME))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function buildKeywordStats(keywords, links, images) {
  const imageCountsByKeyword = new Map();
  for (const image of images) {
    const key = keywordKey(image.keyword);
    if (!key) continue;
    imageCountsByKeyword.set(key, (imageCountsByKeyword.get(key) || 0) + 1);
  }
  return keywords.map((keyword) => {
    const key = keywordKey(keyword.keyword);
    const hitLinks = links.filter((link) => keywordKey(link.keyword) === key);
    return {
      ...keyword,
      links_hit: hitLinks.length,
      images_hit: imageCountsByKeyword.get(key) || 0,
    };
  });
}

function makeSearchText(values) {
  return escapeHtml(values.map(cleanText).filter(Boolean).join(' ').toLowerCase());
}

function rowImageCount(images) {
  return images.filter((image) => cleanText(image.local_path) || statusValue(image.status).startsWith('saved')).length;
}

function imageUsabilityCounts(images) {
  let usable = 0;
  let unusable = 0;
  let ocrDone = 0;
  for (const image of images) {
    const value = statusValue(image.usable || (cleanText(image.uid) ? 'yes' : 'no'));
    if (value === 'yes') usable += 1;
    else unusable += 1;
    if (cleanText(image.notes).toLowerCase().includes('uid_ocr:')) ocrDone += 1;
  }
  return { usable, unusable, ocrDone, total: images.length };
}

function imageOcrConfidence(image) {
  const notes = cleanText(image.notes).toLowerCase();
  if (notes.includes('uid_ocr:low_confidence:')) return 'low_confidence';
  if (notes.includes('uid_ocr:template_avg=')) return 'high_confidence';
  if (cleanText(image.uid)) return statusValue(image.usable) === 'yes' ? 'high_confidence' : 'low_confidence';
  return 'none';
}

function imageRecordStatus(image) {
  const status = statusValue(image.status);
  if (status.startsWith('saved')) return status;
  if (status === 'download_failed' || status === 'pending') return status;
  if (!cleanText(image.local_path)) return 'local_path_missing';
  return status;
}

function refreshIconSvg() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M20 6v5h-5"></path>
    <path d="M4 18v-5h5"></path>
    <path d="M18.8 10.2A7 7 0 0 0 6.4 7.6L4 10"></path>
    <path d="M5.2 13.8A7 7 0 0 0 17.6 16.4L20 14"></path>
  </svg>`;
}

function downloadIconSvg() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M12 3v11"></path>
    <path d="M7 10l5 5 5-5"></path>
    <path d="M5 20h14"></path>
  </svg>`;
}

function renderImageAction(linkId, sellerId, imagesForLink) {
  const localCount = rowImageCount(imagesForLink);
  if (!localCount) {
    return `<span class="text-action text-action-disabled" title="暂无本地图片" aria-disabled="true">看图片</span>`;
  }
  return `<a class="text-action" href="${escapeHtml(sellerImagePageHref(sellerId || linkId))}" title="查看这个卖家的图片">看图片</a>`;
}

function renderDownloadAction(linkId) {
  return `<button class="text-action" type="button" data-run-link="${escapeHtml(linkId)}" title="爬取这个 link 的图片并更新状态">爬取图片</button>`;
}

function renderOcrAction(linkId, imagesForLink) {
  const localCount = rowImageCount(imagesForLink);
  if (!localCount) {
    return `<span class="text-action text-action-disabled" title="暂无本地图片可识别" aria-disabled="true">识别UID</span>`;
  }
  return `<button class="text-action" type="button" data-run-link-ocr="${escapeHtml(linkId)}" title="只识别这个 link 下的图片 UID">识别UID</button>`;
}

function linkProgress(link, imagesForLink) {
  const totalFromState = numberValue(link.total_images);
  const downloadedFromState = numberValue(link.images_downloaded);
  const localCount = rowImageCount(imagesForLink);
  const total = Math.max(totalFromState, localCount);
  const downloaded = Math.max(downloadedFromState, localCount);
  const remainingFromState = cleanText(link.images_remaining) === '' ? Math.max(0, total - downloaded) : numberValue(link.images_remaining);
  const remaining = Math.max(0, remainingFromState);
  const percent = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
  return { total, downloaded, remaining, percent };
}

function renderPreviewImages(imagesForLink) {
  const localImages = imagesForLink.filter((image) => localImageHref(image.local_path));
  if (!localImages.length) return '<span class="muted">暂无本地图片</span>';
  const shown = localImages.slice(0, 4).map((image) => {
    const href = localImageHref(image.local_path);
    const alt = cleanText(image.image_id || image.sha256 || 'review image');
    return `<img src="${escapeHtml(href)}" alt="${escapeHtml(alt)}" loading="lazy">`;
  }).join('');
  const rest = localImages.length > 4 ? `<span class="preview-more">+${localImages.length - 4}</span>` : '';
  return `<div class="preview-strip">${shown}${rest}</div>`;
}

function progressHtml(progress) {
  if (!progress.total) return '<span class="muted">0 / 0</span>';
  return `
    <div class="progress-line">
      <span>${progress.downloaded} / ${progress.total}</span>
      <span class="muted">剩余 ${progress.remaining}</span>
    </div>
    <div class="progress-bar" aria-hidden="true"><span style="width:${progress.percent}%"></span></div>
  `;
}

function linkProcessStatus(link, progress, usability) {
  const hasImages = statusValue(link.has_images);
  const imageState = statusValue(link.image_status);
  const linkState = statusValue(link.link_status);
  const raw = [link.link_status, link.image_status].map(cleanText).filter(Boolean).join(' / ');
  let key = 'needs_check';
  let label = '待检查';

  if (linkState.includes('failed') || imageState.includes('failed') || linkState.includes('blocked') || imageState.includes('blocked')) {
    key = 'check_failed';
    label = '检查失败/受限';
  } else if (hasImages === 'no' || imageState === 'skipped_no_images' || imageState === 'with_pictures_not_found') {
    key = 'no_images';
    label = '无图跳过';
  } else if (progress.downloaded > 0 && imageState === 'complete') {
    if (usability.usable > 0) {
      key = 'uid_found';
      label = '已识别 UID';
    } else if (usability.ocrDone >= progress.downloaded) {
      key = 'uid_not_found';
      label = '未识别到 UID';
    } else {
      key = 'needs_ocr';
      label = '待识别 UID';
    }
  } else if (progress.downloaded > 0) {
    key = usability.usable > 0 ? 'uid_found_partial' : 'images_partial';
    label = usability.usable > 0 ? '有 UID，图片未完' : '图片部分完成';
  } else if (hasImages === 'yes') {
    key = 'needs_images';
    label = '待爬图片';
  }

  const title = raw ? ` title="${escapeHtml(raw)}"` : '';
  return `<span class="badge badge-${escapeHtml(key)}"${title}>${escapeHtml(label)}</span>`;
}

function statCard(label, value, subValue = '', statKey = '') {
  const statAttr = statKey ? ` data-stat-card="${escapeHtml(statKey)}"` : '';
  const valueAttr = statKey ? ' data-stat-value' : '';
  const subAttr = statKey ? ' data-stat-sub' : '';
  return `
    <div class="stat-card"${statAttr}>
      <div class="stat-label">${escapeHtml(label)}</div>
      <div class="stat-value"${valueAttr}>${escapeHtml(value)}</div>
      ${subValue ? `<div class="stat-sub"${subAttr}>${escapeHtml(subValue)}</div>` : ''}
    </div>
  `;
}

function layout({ title, active, subtitle, body, generatedAt }) {
  const sellersActive = active === 'sellers' ? 'active' : '';
  const linksActive = active === 'links' ? 'active' : '';
  const imagesActive = active === 'images' ? 'active' : '';
  const keywordsActive = active === 'keywords' ? 'active' : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="assets/app.css">
</head>
<body>
  <header class="topbar">
    <div>
      <div class="eyebrow">Xianyu Review Image Index</div>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(subtitle)}</p>
    </div>
    <nav class="tabs" aria-label="pages">
      <a class="${sellersActive}" href="sellers.html">卖家</a>
      <a class="${linksActive}" href="links.html">商品线索</a>
      <a class="${imagesActive}" href="images.html">图片</a>
      <a class="${keywordsActive}" href="keywords.html">关键词</a>
    </nav>
  </header>
  ${body}
  <footer class="footer">
    <span>生成时间：${escapeHtml(generatedAt)}</span>
    <span>数据源：data/link_state.csv, data/image_state.csv</span>
  </footer>
  <button class="back-to-top" type="button" data-back-to-top aria-label="回到顶部" title="回到顶部">↑</button>
  <script src="assets/app.js"></script>
</body>
</html>
`;
}

function renderKeywordTypeFilterOptions(keywordTypes) {
  return keywordTypes.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join('');
}

function renderGameNameFilterOptions(gameNames) {
  return gameNames.map((gameName) => `<option value="${escapeHtml(gameName)}">${escapeHtml(gameName)}</option>`).join('');
}

function sellerProgress(seller) {
  const total = Math.max(
    seller.images.length,
    ...seller.links.map((link) => numberValue(link.total_images)),
    0,
  );
  const downloaded = seller.images.length;
  const remaining = Math.max(0, total - downloaded);
  const percent = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
  return { total, downloaded, remaining, percent };
}

function sellerProcessStatus(seller, progress, usability) {
  const hasImages = statusValue(seller.hasImages);
  const imageState = statusValue(seller.imageStatus);
  let key = 'needs_check';
  let label = '待检查';

  if (hasImages === 'no' || imageState === 'skipped_no_images') {
    key = 'no_images';
    label = '无图';
  } else if (progress.downloaded > 0) {
    if (usability.usable > 0) {
      key = 'uid_found';
      label = '已识别 UID';
    } else if (usability.ocrDone >= progress.downloaded) {
      key = 'uid_not_found';
      label = '未识别到 UID';
    } else {
      key = 'needs_ocr';
      label = '待识别 UID';
    }
  } else if (hasImages === 'yes') {
    key = 'needs_images';
    label = '待爬图片';
  }

  return `<span class="badge badge-${escapeHtml(key)}">${escapeHtml(label)}</span>`;
}

function renderSellerImageAction(sellerId, imagesForSeller) {
  const localCount = rowImageCount(imagesForSeller);
  if (!localCount) {
    return `<span class="text-action text-action-disabled" title="暂无本地图片" aria-disabled="true">看图片</span>`;
  }
  return `<a class="text-action" href="${escapeHtml(sellerImagePageHref(sellerId))}" title="查看这个卖家的去重图片">看图片</a>`;
}

function renderSellerDownloadAction(sellerId, linkIds) {
  const ids = Array.isArray(linkIds) ? linkIds.map(cleanText).filter(Boolean) : [];
  if (!ids.length) {
    return `<span class="text-action text-action-disabled" title="暂无可爬取的商品线索" aria-disabled="true">爬取图片</span>`;
  }
  return `<button class="text-action" type="button" data-run-seller="${escapeHtml(sellerId)}" data-run-seller-links="${escapeHtml(ids.join(','))}" title="爬取这个卖家的评价图；同卖家多商品只抓一次">爬取图片</button>`;
}

function renderSellerOcrAction(sellerId, imagesForSeller, linkIds) {
  const localCount = rowImageCount(imagesForSeller);
  if (!localCount) {
    return `<span class="text-action text-action-disabled" title="暂无本地图片可识别" aria-disabled="true">识别UID</span>`;
  }
  const ids = Array.isArray(linkIds) ? linkIds.map(cleanText).filter(Boolean) : [];
  return `<button class="text-action" type="button" data-run-seller-ocr="${escapeHtml(sellerId)}" data-run-seller-ocr-links="${escapeHtml(ids.join(','))}" title="只识别这个卖家下的图片 UID">识别UID</button>`;
}

function renderSellerLinksDetail(seller) {
  if (!seller.links.length) return '<span class="muted">暂无商品线索</span>';
  const rows = seller.links.map((link) => {
    const linkId = cleanText(link.link_id || 'unknown');
    const sellerId = sellerIdFromLink(link);
    return `
      <li>
        <a class="mono" href="links.html#${linkAnchor(linkId)}">${escapeHtml(linkId)}</a>
        <span>${escapeHtml(shortText(link.item_title || link.card_text || '-', 90))}</span>
        ${externalLink(link.item_url, '商品')}
      </li>
    `;
  }).join('');
  return `
    <details class="seller-links-detail">
      <summary>${seller.links.length} 条商品线索</summary>
      <ul>${rows}</ul>
    </details>
  `;
}

function renderSellersPage(sellers, keywords, generatedAt) {
  const totalSellers = sellers.length;
  const multiLinkSellers = sellers.filter((seller) => seller.links.length > 1).length;
  const sellersWithImages = sellers.filter((seller) => seller.images.length > 0).length;
  let usableImages = 0;
  let duplicateSavedImages = 0;
  for (const seller of sellers) {
    usableImages += imageUsabilityCounts(seller.images).usable;
    const rawCount = seller.rawImageCount || seller.images.length;
    duplicateSavedImages += Math.max(0, rawCount - seller.images.length);
  }

  const keywordTypes = keywordTypeOptions(keywords);
  const gameNames = gameNameOptions(keywords);
  const rows = sellers.map((seller) => {
    const sellerId = cleanText(seller.seller_id || 'unknown');
    const primaryLink = seller.primaryLink || {};
    const imagesForSeller = seller.images;
    const progress = sellerProgress(seller);
    const usability = imageUsabilityCounts(imagesForSeller);
    const status = sellerProcessStatus(seller, progress, usability);
    const sellerName = sellerDisplayName(primaryLink);
    const sellerUrl = safeExternalHref(primaryLink.seller_url || primaryLink.review_url);
    const keywordText = Array.from(seller.keywords).slice(0, 4).join(' / ');
    const keywordType = Array.from(seller.keywordTypes).filter(Boolean).join('|');
    const gameName = Array.from(seller.gameNames).filter(Boolean).join('|');
    const sellerLinkIds = seller.links.map((link) => cleanText(link.link_id)).filter(Boolean);
    const rawImageCount = seller.rawImageCount || imagesForSeller.length;
    const searchText = makeSearchText([
      sellerId,
      sellerName,
      keywordText,
      keywordType,
      gameName,
      ...seller.links.flatMap((link) => [link.link_id, link.item_title, link.card_text, link.seller_name]),
      ...imagesForSeller.map((image) => image.uid),
    ]);
    const uidUsable = usability.usable > 0 ? 'yes' : (usability.unusable > 0 ? 'no' : 'unknown');
    const nameHtml = sellerUrl
      ? `<a class="strong seller-name-link" href="${escapeHtml(sellerUrl)}" target="_blank" rel="noreferrer">${escapeHtml(sellerName)}</a>`
      : `<span class="strong">${escapeHtml(sellerName)}</span>`;

    return `
      <tr id="${sellerAnchor(sellerId)}"
          data-filter-target
          data-seller-id="${escapeHtml(sellerId)}"
          data-seller-link-ids="${escapeHtml(sellerLinkIds.join(','))}"
          data-seller-link-count="${escapeHtml(String(seller.links.length))}"
          data-seller-image-count="${escapeHtml(String(imagesForSeller.length))}"
          data-seller-raw-image-count="${escapeHtml(String(rawImageCount))}"
          data-seller-usable-count="${escapeHtml(String(usability.usable))}"
          data-search="${searchText}"
          data-usable="${escapeHtml(uidUsable)}"
          data-keyword-type="${escapeHtml(keywordType)}"
          data-game-name="${escapeHtml(gameName)}">
        <td class="select-cell">
          <input type="checkbox" data-seller-check value="${escapeHtml(sellerId)}" aria-label="选择 ${escapeHtml(sellerId)}">
        </td>
        <td class="id-cell">
          <a class="mono strong" href="${escapeHtml(sellerPageHref(sellerId))}">${escapeHtml(sellerId)}</a>
          <div class="small">${escapeHtml(keywordText || '-')}</div>
        </td>
        <td>
          ${nameHtml}
          <div class="small">${escapeHtml(Array.from(seller.keywordTypes).filter(Boolean).join(' / ') || '-')}</div>
        </td>
        <td class="text-cell">${renderSellerLinksDetail(seller)}</td>
        <td class="progress-cell">${progressHtml(progress)}</td>
        <td class="progress-cell">
          <div class="progress-line"><span>可用 ${usability.usable}</span><span class="muted">不可用 ${usability.unusable}</span></div>
        </td>
        <td class="status-cell">${status}</td>
        <td class="time-cell">
          <div>${escapeHtml(formatDate(seller.lastLinkCrawlAt))}</div>
          <div class="small">图片：${escapeHtml(formatDate(seller.lastImageCrawlAt))}</div>
        </td>
        <td class="preview-cell">${renderPreviewImages(imagesForSeller)}</td>
        <td class="actions-cell">
          ${renderSellerImageAction(sellerId, imagesForSeller)}
          ${renderSellerDownloadAction(sellerId, sellerLinkIds)}
          ${renderSellerOcrAction(sellerId, imagesForSeller, sellerLinkIds)}
        </td>
      </tr>
    `;
  }).join('');

  const body = `
  <main class="page">
    <section class="workflow-strip">
      <span>1 关键词页抓商品线索</span>
      <span>2 卖家页按卖家爬评价图</span>
      <span>3 图片页筛 UID，下载 CSV</span>
    </section>

    <section class="stats-grid">
      ${statCard('卖家总数', String(totalSellers), `多商品卖家 ${multiLinkSellers}`, 'sellerRecords')}
      ${statCard('有图片卖家', String(sellersWithImages), `已隐藏重复图片 ${duplicateSavedImages}`, 'sellerWithImages')}
      ${statCard('UID 可用图片', String(usableImages), '按卖家去重后统计', 'sellerUsableImages')}
      ${statCard('当前可见', String(totalSellers), '随筛选变化', 'visibleSellers')}
    </section>

    <section class="toolbar">
      <label class="search-box">
        <span>搜索</span>
        <input data-filter-search type="search" placeholder="seller_id / 卖家 / UID / link / 商品 / 关键词">
      </label>
      <label>
        <span>UID 可用</span>
        <select data-filter-select data-field="usable">
          <option value="">全部</option>
          <option value="yes">有可用 UID</option>
          <option value="no">无可用 UID</option>
          <option value="unknown">未识别</option>
        </select>
      </label>
      <label>
        <span>关键词类型</span>
        <select data-filter-select data-field="keywordType">
          <option value="">全部</option>
          ${renderKeywordTypeFilterOptions(keywordTypes)}
        </select>
      </label>
      <label>
        <span>游戏名称</span>
        <select data-filter-select data-field="gameName">
          <option value="">全部</option>
          ${renderGameNameFilterOptions(gameNames)}
        </select>
      </label>
      <div class="visible-count"><span data-visible-count>${totalSellers}</span> 个卖家</div>
    </section>

    <section class="run-panel">
      <button type="button" data-run-selected-sellers disabled>${downloadIconSvg()}<span>爬取已勾选卖家的图片</span></button>
      <button type="button" data-run-ocr>识别全部UID</button>
      <div class="run-status" data-run-status>本地 dashboard 启动后可运行任务；按卖家爬图会自动跳过同卖家的重复商品线索。</div>
    </section>

    <section class="table-shell">
      <table class="data-table sellers-table">
        <thead>
          <tr>
            <th class="select-cell"><input type="checkbox" data-check-all-sellers aria-label="全选当前可见卖家"></th>
            <th>Seller ID</th>
            <th>卖家</th>
            <th>商品线索</th>
            <th>图片进度</th>
            <th>UID 结果</th>
            <th>处理状态</th>
            <th>最后抓取</th>
            <th>图片预览</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="10" class="empty-cell">暂无卖家</td></tr>'}</tbody>
      </table>
      <div class="empty-state" data-empty-state hidden>没有匹配的卖家</div>
    </section>
  </main>
  `;

  return layout({
    title: '卖家',
    active: 'sellers',
    subtitle: '以卖家为主表；商品 links 只是线索，同卖家的评价图只保留一组',
    body,
    generatedAt,
  });
}

function renderLinksPage(links, imagesByLink, keywords, keywordByText, generatedAt) {
  const totalLinks = links.length;
  const hasImages = links.filter((link) => statusValue(link.has_images) === 'yes').length;
  const noImages = links.filter((link) => statusValue(link.has_images) === 'no').length;
  const unknownImages = totalLinks - hasImages - noImages;
  const downloadedLinks = links.filter((link) => {
    const imagesForLink = imagesByLink.get(cleanText(link.link_id)) || [];
    return linkProgress(link, imagesForLink).downloaded > 0;
  }).length;
  let totalUsableImages = 0;
  let totalUnusableImages = 0;
  for (const imagesForLink of imagesByLink.values()) {
    const counts = imageUsabilityCounts(imagesForLink);
    totalUsableImages += counts.usable;
    totalUnusableImages += counts.unusable;
  }

  const keywordTypes = keywordTypeOptions(keywords);
  const gameNames = gameNameOptions(keywords);
  const rows = links.map((link) => {
    const linkId = cleanText(link.link_id || 'unknown');
    const sellerId = sellerIdFromLink(link);
    const imagesForLink = imagesByLink.get(linkId) || [];
    const progress = linkProgress(link, imagesForLink);
    const usability = imageUsabilityCounts(imagesForLink);
    const hasImagesStatus = statusValue(link.has_images);
    const linkStatus = statusValue(link.link_status);
    const imageStatus = statusValue(link.image_status);
    const keywordType = keywordTypeOf(link.keyword, keywordByText);
    const gameName = gameNameOf(link.keyword, keywordByText);
    const processStatus = linkProcessStatus(link, progress, usability);
    const searchText = makeSearchText([
      linkId,
      link.keyword,
      keywordType,
      gameName,
      link.seller_name,
      sellerDisplayName(link),
      link.item_title,
      link.card_text,
      link.has_images,
      link.link_status,
      link.image_status,
      link.notes,
    ]);

    return `
      <tr id="${linkAnchor(linkId)}"
          data-filter-target
          data-link-id="${escapeHtml(linkId)}"
          data-local-images="${rowImageCount(imagesForLink)}"
          data-search="${searchText}"
          data-has-images="${escapeHtml(hasImagesStatus)}"
          data-link-status="${escapeHtml(linkStatus)}"
          data-image-status="${escapeHtml(imageStatus)}"
          data-keyword-type="${escapeHtml(keywordType)}"
          data-game-name="${escapeHtml(gameName)}">
        <td class="select-cell">
          <input type="checkbox" data-link-check value="${escapeHtml(linkId)}" aria-label="选择 ${escapeHtml(linkId)}">
        </td>
        <td class="id-cell">
          ${rowImageCount(imagesForLink) ? `<a class="mono strong" href="${escapeHtml(sellerImagePageHref(sellerId))}">${escapeHtml(linkId)}</a>` : `<span class="mono strong">${escapeHtml(linkId)}</span>`}
          <div class="small">${escapeHtml(cleanText(link.keyword) || '-')}</div>
          <div class="small">${escapeHtml(keywordType)} / ${escapeHtml(gameName)}</div>
        </td>
        <td>
          ${sellerNameCell(link)}
        </td>
        <td class="text-cell">
          <div class="strong">${escapeHtml(shortText(link.item_title, 70) || '-')}</div>
          <div class="snippet">${escapeHtml(shortText(link.card_text, 140) || '-')}</div>
        </td>
        <td class="progress-cell">${progressHtml(progress)}</td>
        <td class="progress-cell">
          <div class="progress-line"><span>可用 ${usability.usable}</span><span class="muted">不可用 ${usability.unusable}</span></div>
        </td>
        <td class="status-cell">${processStatus}</td>
        <td class="time-cell">
          <div>${escapeHtml(formatDate(link.last_link_crawl_at))}</div>
          <div class="small">图片：${escapeHtml(formatDate(link.last_image_crawl_at))}</div>
        </td>
        <td class="preview-cell">${renderPreviewImages(imagesForLink)}</td>
        <td class="actions-cell">
          ${renderImageAction(linkId, sellerId, imagesForLink)}
          ${renderDownloadAction(linkId)}
          ${renderOcrAction(linkId, imagesForLink)}
        </td>
      </tr>
    `;
  }).join('');

  const body = `
  <main class="page">
    <section class="workflow-strip">
      <span>1 抓 links：发现并复查是否有图</span>
      <span>2 爬图片：只处理有图 links</span>
      <span>3 识别 UID：更新图片页和 CSV</span>
    </section>

    <section class="stats-grid">
      ${statCard('links 总数', String(totalLinks), `有图 ${hasImages}`)}
      ${statCard('已下载图片的 links', String(downloadedLinks), `未确认 ${unknownImages}`)}
      ${statCard('UID 可用图片', String(totalUsableImages), `不可用 ${totalUnusableImages}`)}
      ${statCard('当前可见', String(totalLinks), '随筛选变化')}
    </section>

    <section class="toolbar">
      <label class="search-box">
        <span>搜索</span>
        <input data-filter-search type="search" placeholder="link_id / 卖家 / 关键词 / 状态">
      </label>
      <label>
        <span>有图</span>
        <select data-filter-select data-field="hasImages">
          <option value="">全部</option>
          <option value="yes">有图</option>
          <option value="no">无图</option>
          <option value="unknown">未知</option>
        </select>
      </label>
      <label>
        <span>图片状态</span>
        <select data-filter-select data-field="imageStatus">
          <option value="">全部</option>
          <option value="pending">待爬图</option>
          <option value="partial">部分完成</option>
          <option value="complete">已完成</option>
          <option value="skipped_no_images">无图跳过</option>
          <option value="unknown">未知</option>
        </select>
      </label>
      <label>
        <span>关键词类型</span>
        <select data-filter-select data-field="keywordType">
          <option value="">全部</option>
          ${renderKeywordTypeFilterOptions(keywordTypes)}
        </select>
      </label>
      <label>
        <span>游戏名称</span>
        <select data-filter-select data-field="gameName">
          <option value="">全部</option>
          ${renderGameNameFilterOptions(gameNames)}
        </select>
      </label>
      <div class="visible-count"><span data-visible-count>${totalLinks}</span> 条</div>
    </section>

    <section class="run-panel">
      <button type="button" data-run-selected disabled>${downloadIconSvg()}<span>爬取已勾选 links 的图片</span></button>
      <button type="button" data-run-ocr>识别UID</button>
      <div class="run-status" data-run-status>本地 dashboard 启动后可直接运行爬虫任务。</div>
    </section>

    <section class="table-shell">
      <table class="data-table">
        <thead>
          <tr>
            <th class="select-cell"><input type="checkbox" data-check-all aria-label="全选当前可见 links"></th>
            <th>Link ID</th>
            <th>卖家</th>
            <th>商品摘要</th>
            <th>图片进度</th>
            <th>图片可用性</th>
            <th>处理状态</th>
            <th>最后爬取</th>
            <th>图片预览</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="10" class="empty-cell">暂无 links</td></tr>'}</tbody>
      </table>
      <div class="empty-state" data-empty-state hidden>没有匹配的 links</div>
    </section>
  </main>
  `;

  return layout({
    title: '商品线索',
    active: 'links',
    subtitle: '这些是发现卖家的商品入口；日常抓图和 UID 判断请优先用卖家页',
    body,
    generatedAt,
  });
}

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

const KEYWORD_STATE_HEADERS = ['keyword', 'keyword_type', 'game_name', 'created_at', 'updated_at', 'notes'];

async function loadKeywords() {
  const rows = await readCsv(KEYWORD_STATE_FILE);
  const configKeywords = await readKeywordLines(KEYWORD_CONFIG_FILE);
  const now = new Date().toISOString();
  const byKeyword = new Map();
  for (const row of rows) {
    const keyword = cleanText(row.keyword);
    if (!keyword) continue;
    byKeyword.set(keywordKey(keyword), {
      keyword,
      keyword_type: cleanText(row.keyword_type) === '未分类' ? DEFAULT_KEYWORD_TYPE : cleanText(row.keyword_type) || DEFAULT_KEYWORD_TYPE,
      game_name: cleanText(row.game_name) || DEFAULT_GAME_NAME,
      created_at: row.created_at || now,
      updated_at: row.updated_at || row.created_at || now,
      notes: row.notes || '',
    });
  }
  for (const keyword of configKeywords) {
    const key = keywordKey(keyword);
    if (!byKeyword.has(key)) {
      byKeyword.set(key, {
        keyword,
        keyword_type: DEFAULT_KEYWORD_TYPE,
        game_name: DEFAULT_GAME_NAME,
        created_at: now,
        updated_at: now,
        notes: 'imported from config/xianyu_keywords.txt',
      });
    }
  }
  const out = Array.from(byKeyword.values());
  await writeCsv(KEYWORD_STATE_FILE, KEYWORD_STATE_HEADERS, out);
  return out;
}

function imageListRow(image, index, link, sellerId) {
  const href = localImageHref(image.local_path);
  const imageId = cleanText(image.image_id || image.sha256 || String(index + 1));
  const linkId = cleanText(image.link_id || link.link_id || 'unknown');
  const imageSellerId = cleanText(image.seller_id || sellerId || sellerIdFromLink(link));
  const usable = statusValue(image.usable || (cleanText(image.uid) ? 'yes' : 'no'));
  const ocrConfidence = imageOcrConfidence(image);
  const imageStatus = imageRecordStatus(image);
  const saved = statusValue(image.status).startsWith('saved') ? 'yes' : 'no';
  const local = href ? 'yes' : 'no';
  const updatedAt = cleanText(image.updated_at || image.downloaded_at);
  const uid = cleanText(image.uid);
  const searchText = makeSearchText([
    imageId,
    image.sha256,
    imageSellerId,
    linkId,
    image.keyword,
    image.uid,
    image.usable,
    image.status,
    imageStatus,
    statusLabel(imageStatus),
    ocrConfidence,
    image.downloaded_at,
    image.thumb_url,
    image.original_url,
    image.local_path,
    image.notes,
  ]);
  const preview = href
    ? `<a class="list-preview" href="${escapeHtml(href)}" target="_blank"><img src="${escapeHtml(href)}" alt="${escapeHtml(imageId)}" loading="lazy"></a>`
    : '<div class="list-preview missing-frame">无预览</div>';

  return `
    <tr id="${imageAnchor(imageId, index)}"
        data-image-row
        data-image-id="${escapeHtml(imageId)}"
        data-seller-id="${escapeHtml(imageSellerId)}"
        data-updated-at="${escapeHtml(updatedAt)}"
        data-uid="${escapeHtml(uid)}"
        data-search="${searchText}"
        data-image-status="${escapeHtml(imageStatus)}"
        data-usable="${escapeHtml(usable)}"
        data-local-image="${escapeHtml(local)}"
        data-saved-image="${escapeHtml(saved)}"
        data-ocr-confidence="${escapeHtml(ocrConfidence)}">
      <td>${preview}</td>
      <td class="mono break">${escapeHtml(imageId)}</td>
      <td class="mono break"><a href="sellers.html#${sellerAnchor(imageSellerId)}">${escapeHtml(imageSellerId)}</a></td>
      <td class="mono break"><a href="links.html#${linkAnchor(linkId)}">${escapeHtml(linkId)}</a></td>
      <td>${escapeHtml(formatDate(image.downloaded_at))}</td>
      <td class="mono break">${escapeHtml(uid || '-')}</td>
      <td>${uidUsableBadge(usable)}</td>
      <td>${badge(ocrConfidence)}</td>
    </tr>
  `;
}

function imageUidPriority(image) {
  const uid = cleanText(image.uid);
  if (/^2\d{11}$/.test(uid)) return 0;
  if (uid) return 1;
  return 2;
}

function sortImagesWithUidFirst(images) {
  return images
    .map((image, index) => ({ image, index }))
    .sort((a, b) => {
      const au = imageUidPriority(a.image);
      const bu = imageUidPriority(b.image);
      if (au !== bu) return au - bu;
      return a.index - b.index;
    })
    .map((item) => item.image);
}

function renderImagesPage(links, images, imagesBySeller, keywords, keywordByText, generatedAt) {
  const linksById = new Map(links.map((link) => [cleanText(link.link_id || 'unknown'), link]));
  const sellers = buildSellerRows(links, imagesBySeller, keywordByText);
  const sellerById = new Map(sellers.map((seller) => [cleanText(seller.seller_id), seller]));
  const sellerOrder = new Map(sellers.map((seller, index) => [cleanText(seller.seller_id), index]));
  const keywordTypes = keywordTypeOptions(keywords);
  const gameNames = gameNameOptions(keywords);
  const groupIds = Array.from(imagesBySeller.keys()).sort((a, b) => {
    const aUidPriority = Math.min(...(imagesBySeller.get(a) || []).map(imageUidPriority), 2);
    const bUidPriority = Math.min(...(imagesBySeller.get(b) || []).map(imageUidPriority), 2);
    if (aUidPriority !== bUidPriority) return aUidPriority - bUidPriority;
    const ai = sellerOrder.has(a) ? sellerOrder.get(a) : Number.MAX_SAFE_INTEGER;
    const bi = sellerOrder.has(b) ? sellerOrder.get(b) : Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.localeCompare(b, 'zh-CN');
  });

  const downloadedImages = images.filter((image) => localImageHref(image.local_path)).length;
  const savedImages = images.filter((image) => statusValue(image.status).startsWith('saved')).length;
  const overallUsability = imageUsabilityCounts(images);
  const uniqueUsableUidCount = new Set(images
    .filter((image) => statusValue(image.usable || (cleanText(image.uid) ? 'yes' : 'no')) === 'yes')
    .map((image) => cleanText(image.uid))
    .filter(Boolean)).size;

  const groups = groupIds.map((sellerId) => {
    const rawGroupImages = imagesBySeller.get(sellerId) || [];
    const seller = sellerById.get(sellerId) || { seller_id: sellerId, links: [], images: rawGroupImages, keywords: new Set(), keywordTypes: new Set(), gameNames: new Set(), primaryLink: {} };
    const link = seller.primaryLink || {};
    const groupImages = sortImagesWithUidFirst(rawGroupImages.length ? rawGroupImages : seller.images);
    const progress = sellerProgress({ ...seller, images: groupImages });
    const groupKeyword = Array.from(seller.keywords || [])[0] || link.keyword || groupImages.find((image) => cleanText(image.keyword))?.keyword || '';
    const keywordType = keywordTypeOf(groupKeyword, keywordByText);
    const gameName = gameNameOf(groupKeyword, keywordByText);
    const groupUsability = imageUsabilityCounts(groupImages);
    const groupUsableFilter = groupUsability.usable > 0 ? 'yes' : (groupUsability.unusable > 0 ? 'no' : 'unknown');
    const groupSearch = makeSearchText([
      sellerId,
      ...seller.links.map((sellerLink) => sellerLink.link_id),
      link.keyword,
      keywordType,
      gameName,
      link.seller_name,
      link.item_title,
      link.card_text,
      link.has_images,
      link.link_status,
      link.image_status,
    ]);
    const imageStatus = statusValue(seller.imageStatus || link.image_status || (groupImages.length ? 'has_images' : 'unknown'));

    return `
      <section class="image-group"
               id="${sellerImageGroupAnchor(sellerId)}"
               data-filter-target
               data-seller-id="${escapeHtml(sellerId)}"
               data-search="${groupSearch}"
               data-image-status="${escapeHtml(imageStatus)}"
               data-has-images="${escapeHtml(statusValue(seller.hasImages || link.has_images || 'yes'))}"
               data-usable="${escapeHtml(groupUsableFilter)}"
               data-keyword-type="${escapeHtml(keywordType)}"
               data-game-name="${escapeHtml(gameName)}">
        <header class="group-header">
          <div>
            <a class="mono group-id" href="sellers.html#${sellerAnchor(sellerId)}">${escapeHtml(sellerId)}</a>
            <h2>${escapeHtml(shortText(sellerDisplayName(link), 80))}</h2>
            <p>${escapeHtml(shortText(link.item_title || link.card_text || `${seller.links.length || 0} 条商品线索`, 120))}</p>
            <p class="small">关键词类型：${escapeHtml(keywordType)}　游戏名称：${escapeHtml(gameName)}</p>
          </div>
          <div class="group-side">
            <div class="group-count">${groupImages.length} 张</div>
            <div class="small">${progress.downloaded} / ${progress.total || groupImages.length || 0} 已下载</div>
            <div class="small">可用 ${groupUsability.usable} / 不可用 ${groupUsability.unusable}</div>
            <div class="group-links">
              <a href="sellers.html#${sellerAnchor(sellerId)}">看卖家</a>
              ${seller.links[0] ? `<a href="links.html#${linkAnchor(cleanText(seller.links[0].link_id))}">看线索</a>` : ''}
              ${externalLink(link.seller_url || link.review_url, '闲鱼卖家')}
            </div>
          </div>
        </header>
        <div class="image-list-shell">
          <table class="image-list-table">
            <thead>
              <tr>
                <th>预览</th>
                <th>image_id</th>
                <th>seller_id</th>
                <th>link_id</th>
                <th>下载时间</th>
                <th>uid</th>
                <th>UID 可用</th>
                <th>OCR</th>
              </tr>
            </thead>
            <tbody>
              ${groupImages.map((image, index) => imageListRow(image, index, linksById.get(cleanText(image.link_id)) || link, sellerId)).join('')}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }).join('');

  const body = `
  <main class="page">
    <section class="stats-grid">
      ${statCard('图片记录', String(images.length), `本地图片 ${downloadedImages}`, 'imageRecords')}
      ${statCard('已保存原图', String(savedImages), 'status starts with saved', 'savedImages')}
      ${statCard('UID 可用图片', String(overallUsability.usable), `不可用 ${overallUsability.unusable}`, 'uidUsableImages')}
      ${statCard('可用 UID 去重数', String(uniqueUsableUidCount), '按 usable=yes 去重', 'uniqueUsableUids')}
      ${statCard('当前可见', String(images.length), '随筛选变化', 'visibleImages')}
    </section>

    <section class="toolbar">
      <label class="search-box">
        <span>搜索</span>
        <input data-filter-search type="search" placeholder="seller_id / link_id / UID / 卖家 / 图片 URL">
      </label>
      <label>
        <span>UID 可用</span>
        <select data-filter-select data-field="usable">
          <option value="">全部</option>
          <option value="yes">UID 可用</option>
          <option value="no">UID 不可用</option>
        </select>
      </label>
      <label>
        <span>关键词类型</span>
        <select data-filter-select data-field="keywordType">
          <option value="">全部</option>
          ${renderKeywordTypeFilterOptions(keywordTypes)}
        </select>
      </label>
      <label>
        <span>游戏名称</span>
        <select data-filter-select data-field="gameName">
          <option value="">全部</option>
          ${renderGameNameFilterOptions(gameNames)}
        </select>
      </label>
      <div class="visible-count"><span data-visible-count>${images.length}</span> 张</div>
    </section>
    <div class="run-status image-run-status" data-run-status>清理无 UID 图片会先预估空间，确认后才执行。</div>

    <section class="gallery">
      ${groups || '<div class="empty-state always-visible">暂无图片记录</div>'}
      <div class="empty-state" data-empty-state hidden>没有匹配的图片分组</div>
    </section>
  </main>
  `;

  return layout({
    title: '图片',
    active: 'images',
    subtitle: '按卖家聚合并去重展示；link_id 只作为来源线索保留',
    body,
    generatedAt,
  });
}

function renderKeywordsPage(keywords, links, images, generatedAt) {
  const rowsWithStats = buildKeywordStats(keywords, links, images);
  const totalKeywords = rowsWithStats.length;
  const typeCount = keywordTypeOptions(rowsWithStats).length;
  const gameCount = gameNameOptions(rowsWithStats).length;
  const linkedKeywords = rowsWithStats.filter((row) => row.links_hit > 0).length;
  const imageKeywords = rowsWithStats.filter((row) => row.images_hit > 0).length;

  const rows = rowsWithStats.map((row) => {
    const keyword = cleanText(row.keyword);
    const keywordType = cleanText(row.keyword_type) || DEFAULT_KEYWORD_TYPE;
    const gameName = cleanText(row.game_name) || DEFAULT_GAME_NAME;
    const searchText = makeSearchText([keyword, keywordType, gameName, row.links_hit, row.images_hit, row.notes]);
    return `
      <tr data-filter-target
          data-keyword="${escapeHtml(keyword)}"
          data-search="${searchText}"
          data-keyword-type="${escapeHtml(keywordType)}"
          data-game-name="${escapeHtml(gameName)}">
        <td class="strong">${escapeHtml(keyword)}</td>
        <td><input class="inline-edit-input" data-edit-keyword-type value="${escapeHtml(keywordType)}" maxlength="80" aria-label="修改关键词类型"></td>
        <td><input class="inline-edit-input" data-edit-game-name value="${escapeHtml(gameName)}" maxlength="80" aria-label="修改游戏名称"></td>
        <td>${escapeHtml(String(row.links_hit || 0))}</td>
        <td>${escapeHtml(String(row.images_hit || 0))}</td>
        <td>${escapeHtml(formatDate(row.created_at))}</td>
        <td>${escapeHtml(formatDate(row.updated_at))}</td>
        <td class="notes-cell">${escapeHtml(cleanText(row.notes) || '-')}</td>
        <td class="row-actions">
          <button class="text-action" type="button" data-save-keyword="${escapeHtml(keyword)}">保存</button>
          <button class="text-action danger-action" type="button" data-delete-keyword="${escapeHtml(keyword)}">删除</button>
        </td>
      </tr>
    `;
  }).join('');

  const body = `
  <main class="page">
    <section class="stats-grid">
      ${statCard('关键词总数', String(totalKeywords), `类型 ${typeCount}`)}
      ${statCard('游戏数', String(gameCount), 'game_name')}
      ${statCard('命中 links 的关键词', String(linkedKeywords), 'links_hit > 0')}
      ${statCard('命中图片的关键词', String(imageKeywords), 'images_hit > 0')}
    </section>

    <section class="keyword-form-panel">
      <form data-keyword-form>
        <label>
          <span>关键词</span>
          <input name="keyword" required maxlength="120" placeholder="例如：sample keyword">
        </label>
        <label>
          <span>关键词类型</span>
          <input name="keywordType" required maxlength="80" value="${escapeHtml(DEFAULT_KEYWORD_TYPE)}">
        </label>
        <label>
          <span>游戏名称</span>
          <input name="gameName" required maxlength="80" value="${escapeHtml(DEFAULT_GAME_NAME)}">
        </label>
        <button type="submit">新增关键词</button>
      </form>
      <div class="keyword-actions">
        <button type="button" data-run-discover>${refreshIconSvg()}<span>抓筛选关键词</span></button>
      </div>
      <div class="run-status" data-run-status>先筛选关键词类型，再抓筛选出的关键词 links；抓图片请到卖家页或商品线索页单独执行。</div>
    </section>

    <section class="toolbar">
      <label class="search-box">
        <span>搜索</span>
        <input data-filter-search type="search" placeholder="关键词 / 类型 / 备注">
      </label>
      <label>
        <span>关键词类型</span>
        <select data-filter-select data-field="keywordType">
          <option value="">全部</option>
          ${renderKeywordTypeFilterOptions(keywordTypeOptions(rowsWithStats))}
        </select>
      </label>
      <label>
        <span>游戏名称</span>
        <select data-filter-select data-field="gameName">
          <option value="">全部</option>
          ${renderGameNameFilterOptions(gameNameOptions(rowsWithStats))}
        </select>
      </label>
      <div class="visible-count"><span data-visible-count>${totalKeywords}</span> 条</div>
    </section>

    <section class="table-shell">
      <table class="data-table keyword-table">
        <thead>
          <tr>
            <th>关键词</th>
            <th>关键词类型</th>
            <th>游戏名称</th>
            <th>命中 links</th>
            <th>图片数</th>
            <th>创建时间</th>
            <th>更新时间</th>
            <th>备注</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="9" class="empty-cell">暂无关键词</td></tr>'}</tbody>
      </table>
      <div class="empty-state" data-empty-state hidden>没有匹配的关键词</div>
    </section>
  </main>
  `;

  return layout({
    title: '关键词',
    active: 'keywords',
    subtitle: '管理搜索关键词和关键词类型',
    body,
    generatedAt,
  });
}

function css() {
  return `:root {
  color-scheme: light;
  --bg: #f5f7fa;
  --panel: #ffffff;
  --panel-soft: #f9fafb;
  --text: #17202a;
  --muted: #64748b;
  --line: #d9e1ea;
  --accent: #0f766e;
  --accent-soft: #d9f2ed;
  --blue: #1d4ed8;
  --amber: #a16207;
  --red: #b42318;
  --green: #16794c;
  --shadow: 0 8px 24px rgba(15, 23, 42, 0.08);
}

* {
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: "Microsoft YaHei", "Segoe UI", Arial, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  letter-spacing: 0;
}

a {
  color: var(--blue);
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
}

button,
input,
select {
  font: inherit;
  letter-spacing: 0;
}

.topbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  padding: 24px 32px 18px;
  background: #ffffff;
  border-bottom: 1px solid var(--line);
  position: sticky;
  top: 0;
  z-index: 10;
}

.topbar h1 {
  margin: 4px 0 2px;
  font-size: 26px;
  line-height: 1.2;
}

.topbar p {
  margin: 0;
  color: var(--muted);
}

.eyebrow {
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
}

.tabs {
  display: flex;
  gap: 8px;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel-soft);
}

.tabs a {
  display: inline-flex;
  min-width: 92px;
  justify-content: center;
  padding: 8px 12px;
  border-radius: 6px;
  color: var(--text);
  font-weight: 700;
}

.tabs a.active {
  background: var(--accent);
  color: #ffffff;
}

.page {
  width: min(1560px, calc(100% - 40px));
  margin: 20px auto 40px;
}

.workflow-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 14px;
}

.workflow-strip span {
  display: inline-flex;
  align-items: center;
  min-height: 30px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel-soft);
  color: #475569;
  font-size: 12px;
  font-weight: 700;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 14px;
}

.stat-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 14px 16px;
  box-shadow: var(--shadow);
  min-height: 96px;
}

.stat-label {
  color: var(--muted);
  font-size: 13px;
}

.stat-value {
  margin-top: 6px;
  font-size: 28px;
  font-weight: 800;
  line-height: 1.1;
}

.stat-sub {
  margin-top: 8px;
  color: var(--muted);
  font-size: 12px;
}

.toolbar {
  display: flex;
  align-items: end;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
  padding: 12px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
}

.toolbar label {
  display: grid;
  gap: 5px;
  min-width: 160px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
}

.toolbar .search-box {
  flex: 1 1 360px;
}

.toolbar input,
.toolbar select {
  width: 100%;
  height: 38px;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 0 10px;
  color: var(--text);
  background: #ffffff;
}

.run-panel {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 14px;
  padding: 12px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: var(--shadow);
}

.run-panel button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 34px;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  background: #ffffff;
  color: var(--text);
  cursor: pointer;
  font-weight: 700;
}

.run-panel button {
  padding: 0 11px;
}

.run-panel button:hover {
  border-color: #a7d9d0;
  background: var(--accent-soft);
  color: var(--accent);
}

.run-panel button:disabled {
  color: #9aa6b5;
  background: #eef2f6;
  cursor: not-allowed;
}

.run-panel svg {
  width: 17px;
  height: 17px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.run-status {
  flex: 1 1 260px;
  color: var(--muted);
  font-size: 12px;
}

.run-status-bad {
  color: var(--red);
}

.keyword-form-panel {
  margin-bottom: 14px;
  padding: 12px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: var(--shadow);
}

.keyword-form-panel form {
  display: flex;
  align-items: end;
  gap: 12px;
  flex-wrap: wrap;
}

.keyword-form-panel label {
  display: grid;
  gap: 5px;
  min-width: 220px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
}

.keyword-form-panel input {
  height: 38px;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 0 10px;
  color: var(--text);
}

.inline-edit-input {
  width: min(180px, 100%);
  height: 32px;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 0 8px;
  color: var(--text);
  background: #ffffff;
}

.row-actions {
  white-space: nowrap;
}

.row-actions .text-action + .text-action {
  margin-left: 8px;
}

.keyword-form-panel button {
  height: 38px;
  padding: 0 14px;
  border: 1px solid #a7d9d0;
  border-radius: 6px;
  background: var(--accent);
  color: #ffffff;
  font-weight: 800;
  cursor: pointer;
}

.keyword-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 10px;
}

.keyword-actions button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.keyword-actions svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.keyword-form-panel .run-status {
  margin-top: 8px;
}

.visible-count {
  margin-left: auto;
  height: 38px;
  display: inline-flex;
  align-items: center;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel-soft);
  color: var(--muted);
  font-weight: 700;
}

.table-shell {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: auto;
  box-shadow: var(--shadow);
}

.data-table {
  width: 100%;
  min-width: 1180px;
  border-collapse: collapse;
}

.data-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  text-align: left;
  padding: 11px 12px;
  background: #eef3f7;
  color: #334155;
  font-size: 12px;
  border-bottom: 1px solid var(--line);
}

.data-table td {
  vertical-align: top;
  padding: 12px;
  border-bottom: 1px solid #edf2f7;
}

.data-table tr:hover td {
  background: #fbfdff;
}

.select-cell {
  width: 44px;
  text-align: center;
}

.select-cell input {
  width: 16px;
  height: 16px;
}

.id-cell {
  width: 170px;
}

.text-cell {
  min-width: 320px;
  max-width: 520px;
}

.progress-cell {
  width: 170px;
}

.status-cell {
  width: 140px;
}

.time-cell {
  width: 190px;
  color: var(--muted);
}

.preview-cell {
  width: 200px;
}

.actions-cell {
  width: 190px;
}

.actions-cell,
.image-links,
.group-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
}

.text-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 30px;
  padding: 0 9px;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  background: #ffffff;
  color: var(--blue);
  cursor: pointer;
  font-size: 12px;
  font-weight: 800;
  white-space: nowrap;
}

.text-action:hover {
  text-decoration: none;
  border-color: #a7d9d0;
  background: var(--accent-soft);
  color: var(--accent);
}

.text-action-running,
.text-action-running:hover {
  border-color: #7dd3fc;
  background: #e0f2fe;
  color: #0369a1;
  cursor: progress;
}

.text-action-running[disabled] {
  opacity: 1;
}

.danger-action {
  border-color: #fecaca;
  background: #fff5f5;
  color: var(--red);
}

.danger-action:hover {
  border-color: #fca5a5;
  background: #fee2e2;
  color: var(--red);
}

.text-action-disabled {
  color: #9aa6b5;
  background: #eef2f6;
  cursor: not-allowed;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.mono {
  font-family: Consolas, "SFMono-Regular", Menlo, monospace;
}

.strong {
  font-weight: 800;
}

.small,
.muted {
  color: var(--muted);
  font-size: 12px;
}

.snippet {
  margin-top: 4px;
  color: var(--muted);
  font-size: 12px;
}

.badge {
  display: inline-flex;
  align-items: center;
  max-width: 180px;
  min-height: 22px;
  margin: 2px 4px 2px 0;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid #d4dde7;
  background: #f8fafc;
  color: #334155;
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}

.badge-yes,
.badge-ok,
.badge-complete,
.badge-saved_original,
.badge-uid_found,
.badge-uid_found_partial {
  border-color: #bde7d4;
  background: #e8f8f0;
  color: var(--green);
}

.badge-no,
.badge-failed,
.badge-skipped_no_images,
.badge-check_failed {
  border-color: #f1c7c2;
  background: #fff0ee;
  color: var(--red);
}

.badge-partial,
.badge-needs_images,
.badge-images_partial,
.badge-needs_ocr {
  border-color: #f4dfaa;
  background: #fff7df;
  color: var(--amber);
}

.badge-unknown,
.badge-imported_unchecked,
.badge-needs_check,
.badge-no_images {
  border-color: #d5dce7;
  background: #f2f5f9;
  color: #526070;
}

.badge-images_done {
  border-color: #bfdbfe;
  background: #eff6ff;
  color: #1d4ed8;
}

.badge-uid_not_found {
  border-color: #e0d2fe;
  background: #f5f3ff;
  color: #6d28d9;
}

.progress-line {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  font-weight: 800;
}

.progress-bar {
  width: 100%;
  height: 8px;
  margin-top: 7px;
  border-radius: 999px;
  overflow: hidden;
  background: #e4eaf1;
}

.progress-bar span {
  display: block;
  height: 100%;
  background: var(--accent);
}

.preview-strip {
  display: grid;
  grid-template-columns: repeat(5, 32px);
  gap: 6px;
  align-items: center;
  min-height: 38px;
}

.preview-strip img {
  width: 32px;
  height: 32px;
  border-radius: 6px;
  object-fit: cover;
  border: 1px solid var(--line);
  background: #edf2f7;
}

.preview-more {
  display: inline-flex;
  width: 32px;
  height: 32px;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background: #eef3f7;
  color: var(--muted);
  font-size: 12px;
  font-weight: 800;
}

.gallery {
  display: grid;
  gap: 16px;
}

.image-group {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: var(--shadow);
}

.group-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 16px;
  padding: 16px;
  border-bottom: 1px solid var(--line);
  background: #fbfcfe;
}

.group-header h2 {
  margin: 4px 0;
  font-size: 18px;
  line-height: 1.3;
}

.group-header p {
  margin: 0;
  color: var(--muted);
}

.group-id {
  font-weight: 800;
}

.group-side {
  min-width: 190px;
  text-align: right;
}

.group-count {
  font-size: 24px;
  line-height: 1.1;
  font-weight: 900;
}

.group-links {
  justify-content: flex-end;
  margin-top: 8px;
}

.image-list-shell {
  overflow: auto;
}

.image-list-table {
  width: 100%;
  min-width: 760px;
  border-collapse: collapse;
}

.image-list-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 10px;
  text-align: left;
  background: #eef3f7;
  border-bottom: 1px solid var(--line);
  color: #334155;
  font-size: 12px;
}

.image-list-table td {
  vertical-align: top;
  padding: 10px;
  border-bottom: 1px solid #edf2f7;
  font-size: 12px;
}

.image-list-table tr:hover td {
  background: #fbfdff;
}

.list-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 120px;
  height: 90px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #eef3f7;
  color: var(--muted);
  font-weight: 700;
}

.list-preview img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #f8fafc;
}

.url-cell,
.path-cell,
.notes-cell,
.break {
  max-width: 260px;
  overflow-wrap: anywhere;
}

.empty-state,
.empty-cell {
  padding: 28px;
  text-align: center;
  color: var(--muted);
}

.empty-state.always-visible {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
}

[hidden] {
  display: none !important;
}

:target,
.target-hit {
  outline: 3px solid rgba(15, 118, 110, 0.35);
  outline-offset: 3px;
}

.image-missing img {
  display: none;
}

.footer {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  width: min(1560px, calc(100% - 40px));
  margin: 0 auto 28px;
  color: var(--muted);
  font-size: 12px;
}

.back-to-top {
  position: fixed;
  right: 22px;
  bottom: 22px;
  z-index: 30;
  width: 44px;
  height: 44px;
  border: 1px solid #a7d9d0;
  border-radius: 8px;
  background: var(--accent);
  color: #ffffff;
  font-size: 24px;
  font-weight: 800;
  line-height: 1;
  box-shadow: var(--shadow);
  cursor: pointer;
  opacity: 0;
  transform: translateY(10px);
  pointer-events: none;
  transition: opacity 0.16s ease, transform 0.16s ease, background 0.16s ease;
}

.back-to-top:hover {
  background: #0b615b;
}

.back-to-top.is-visible {
  opacity: 1;
  transform: translateY(0);
  pointer-events: auto;
}

@media (max-width: 900px) {
  .topbar {
    position: static;
    display: grid;
    padding: 18px;
  }

  .tabs {
    width: 100%;
  }

  .tabs a {
    flex: 1;
  }

  .page,
  .footer {
    width: calc(100% - 24px);
  }

  .stats-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .group-header {
    grid-template-columns: 1fr;
  }

  .group-side {
    text-align: left;
  }

  .group-links {
    justify-content: flex-start;
  }
}

@media (max-width: 560px) {
  .stats-grid {
    grid-template-columns: 1fr;
  }

  .toolbar label,
  .toolbar .search-box,
  .visible-count {
    flex: 1 1 100%;
    width: 100%;
  }

  .footer {
    display: grid;
  }

  .back-to-top {
    right: 14px;
    bottom: 14px;
    width: 40px;
    height: 40px;
    font-size: 22px;
  }
}
`;
}

function appJs() {
  return `(function () {
  function apiAvailable() {
    return location.protocol === 'http:' || location.protocol === 'https:';
  }

  function setStatus(text, bad) {
    const status = document.querySelector('[data-run-status]');
    if (!status) return;
    status.textContent = text;
    status.classList.toggle('run-status-bad', Boolean(bad));
  }

  function compactLogLine(line) {
    return String(line || '').replace(/\\s+/g, ' ').trim().slice(0, 180);
  }

  function setActionPending(action, text) {
    if (!action) return;
    if (!action.dataset.originalText) action.dataset.originalText = action.textContent;
    action.textContent = text || '正在进行中';
    action.classList.add('text-action-running');
    action.setAttribute('aria-busy', 'true');
    if ('disabled' in action) action.disabled = true;
  }

  function clearActionPending(action) {
    if (!action) return;
    if (action.dataset.originalText) action.textContent = action.dataset.originalText;
    action.classList.remove('text-action-running');
    action.removeAttribute('aria-busy');
    if ('disabled' in action) action.disabled = false;
  }

  async function postJson(url, payload) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    const data = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(data.error || data.message || ('HTTP ' + response.status));
    return data;
  }

  async function deleteJson(url, payload) {
    const response = await fetch(url, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    const data = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(data.error || data.message || ('HTTP ' + response.status));
    return data;
  }

  async function getJson(url) {
    const response = await fetch(url, { cache: 'no-store' });
    const data = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(data.error || data.message || ('HTTP ' + response.status));
    return data;
  }

  function checkedLinkIds() {
    return Array.from(document.querySelectorAll('[data-link-check]:checked')).map(function (input) {
      return input.value;
    }).filter(Boolean);
  }

  function listFromCsv(value) {
    return String(value || '').split(',').map(function (item) {
      return item.trim();
    }).filter(Boolean);
  }

  function linkIdsForCheckedSellers() {
    const ids = [];
    const seen = new Set();
    document.querySelectorAll('[data-seller-check]:checked').forEach(function (input) {
      const row = input.closest('[data-filter-target]');
      listFromCsv(row ? row.dataset.sellerLinkIds : '').forEach(function (linkId) {
        if (seen.has(linkId)) return;
        seen.add(linkId);
        ids.push(linkId);
      });
    });
    return ids;
  }

  function checkedSellerIds() {
    return Array.from(document.querySelectorAll('[data-seller-check]:checked')).map(function (input) {
      return input.value;
    }).filter(Boolean);
  }

  function visibleKeywords() {
    const scope = document.querySelector('.keyword-table tbody') || document;
    return Array.from(scope.querySelectorAll('[data-filter-target]:not([hidden])'))
      .map(function (row) { return row.dataset.keyword || ''; })
      .filter(Boolean);
  }

  function keywordFilterPayload() {
    const typeSelect = document.querySelector('[data-filter-select][data-field="keywordType"]');
    const gameSelect = document.querySelector('[data-filter-select][data-field="gameName"]');
    return {
      keywordType: typeSelect ? typeSelect.value : '',
      gameName: gameSelect ? gameSelect.value : '',
    };
  }

  function updateSelectionState() {
    const button = document.querySelector('[data-run-selected]');
    const sellerButton = document.querySelector('[data-run-selected-sellers]');
    const checkAll = document.querySelector('[data-check-all]');
    const checkAllSellers = document.querySelector('[data-check-all-sellers]');
    const count = checkedLinkIds().length;
    if (button) {
      button.disabled = count === 0;
      const text = button.querySelector('span');
      if (text) text.textContent = count ? ('爬取已勾选 links 的图片（' + count + '）') : '爬取已勾选 links 的图片';
    }
    const sellerCount = checkedSellerIds().length;
    if (sellerButton) {
      sellerButton.disabled = sellerCount === 0;
      const text = sellerButton.querySelector('span');
      if (text) text.textContent = sellerCount ? ('爬取已勾选卖家的图片（' + sellerCount + '）') : '爬取已勾选卖家的图片';
    }
    if (checkAll) {
      const visibleInputs = Array.from(document.querySelectorAll('[data-filter-target]:not([hidden]) [data-link-check]'));
      const checkedVisible = visibleInputs.filter(function (input) { return input.checked; }).length;
      checkAll.checked = visibleInputs.length > 0 && checkedVisible === visibleInputs.length;
      checkAll.indeterminate = checkedVisible > 0 && checkedVisible < visibleInputs.length;
    }
    if (checkAllSellers) {
      const visibleInputs = Array.from(document.querySelectorAll('[data-filter-target]:not([hidden]) [data-seller-check]'));
      const checkedVisible = visibleInputs.filter(function (input) { return input.checked; }).length;
      checkAllSellers.checked = visibleInputs.length > 0 && checkedVisible === visibleInputs.length;
      checkAllSellers.indeterminate = checkedVisible > 0 && checkedVisible < visibleInputs.length;
    }
  }

  async function refreshTaskStatus() {
    if (!apiAvailable() || !document.querySelector('[data-run-status]')) return;
    try {
      const response = await fetch('/api/status', { cache: 'no-store' });
      const data = await response.json();
      const activeTasks = Array.isArray(data.currentTasks) && data.currentTasks.length ? data.currentTasks : (data.currentTask ? [data.currentTask] : []);
      if (activeTasks.length) {
        const taskTexts = activeTasks.map(function (task) {
          const seconds = Number(task.elapsedSeconds || 0);
          const timeText = Math.floor(seconds / 60) + '分' + (seconds % 60) + '秒';
          if (task.progress && task.progress.kind === 'download-images') {
            return task.label + '，已爬取 ' + task.progress.done + ' / ' + task.progress.total + '，剩余 ' + task.progress.remaining + '，已运行 ' + timeText;
          }
          return task.label + '，已运行 ' + timeText;
        });
        const latestTask = activeTasks[activeTasks.length - 1];
        const recent = latestTask.progress && latestTask.progress.kind === 'download-images'
          ? []
          : Array.isArray(latestTask.lastOutputLines) ? latestTask.lastOutputLines.map(compactLogLine).filter(Boolean).slice(-3) : [];
        const suffix = recent.length ? '；最近：' + recent.join(' / ') : '';
        setStatus('正在运行：' + taskTexts.join('；') + suffix);
        return;
      }
      if (data.history && data.history.length) {
        const last = data.history[0];
        setStatus('最近任务：' + last.label + ' / ' + last.status + '。任务结束后页面已重新生成，可刷新查看。', last.status === 'failed');
      }
    } catch {
      setStatus('本页是静态打开的；请双击 04_start_dashboard.bat 后用本地 dashboard 操作。', true);
    }
  }

  function setupActions() {
    if (!document.querySelector('[data-run-status]')) return;

    document.querySelectorAll('[data-link-check]').forEach(function (input) {
      input.addEventListener('change', updateSelectionState);
    });
    document.querySelectorAll('[data-seller-check]').forEach(function (input) {
      input.addEventListener('change', updateSelectionState);
    });

    const checkAll = document.querySelector('[data-check-all]');
    if (checkAll) {
      checkAll.addEventListener('change', function () {
        document.querySelectorAll('[data-filter-target]:not([hidden]) [data-link-check]').forEach(function (input) {
          input.checked = checkAll.checked;
        });
        updateSelectionState();
      });
    }
    const checkAllSellers = document.querySelector('[data-check-all-sellers]');
    if (checkAllSellers) {
      checkAllSellers.addEventListener('change', function () {
        document.querySelectorAll('[data-filter-target]:not([hidden]) [data-seller-check]').forEach(function (input) {
          input.checked = checkAllSellers.checked;
        });
        updateSelectionState();
      });
    }

    updateSelectionState();

    function canRunTask() {
      if (apiAvailable()) return true;
      setStatus('本页是静态打开的；勾选和筛选可用。要启动爬虫，请双击 04_start_dashboard.bat 后用本地 dashboard 操作。', true);
      return false;
    }

    const runDiscover = document.querySelector('[data-run-discover]');
    if (runDiscover) {
      runDiscover.addEventListener('click', async function () {
        if (!canRunTask()) return;
        try {
          const keywords = visibleKeywords();
          const filters = keywordFilterPayload();
          if (runDiscover.closest('.keyword-form-panel') && !keywords.length) {
            setStatus('当前筛选下没有可抓取的关键词。', true);
            return;
          }
          const suffix = keywords.length ? ('（' + keywords.length + ' 个关键词）') : '';
          setStatus('已提交：抓筛选关键词 links' + suffix);
          const result = await postJson('/api/discover-links', { keywords: keywords, keywordType: filters.keywordType, gameName: filters.gameName });
          if (result && result.accepted === false && result.message) {
            setStatus(result.message);
            return;
          }
          refreshTaskStatus();
        } catch (err) {
          setStatus(err.message, true);
        }
      });
    }

    const runOcr = document.querySelector('[data-run-ocr]');
    if (runOcr) {
      runOcr.addEventListener('click', async function () {
        if (!canRunTask()) return;
        try {
          setStatus('已提交：识别图片 UID');
          await postJson('/api/ocr-uids');
          refreshTaskStatus();
        } catch (err) {
          setStatus(err.message, true);
        }
      });
    }

    document.querySelectorAll('[data-run-link]').forEach(function (button) {
      button.addEventListener('click', async function () {
        if (!canRunTask()) return;
        const linkId = button.dataset.runLink;
        setActionPending(button);
        try {
          setStatus('已提交：爬取 ' + linkId + ' 的图片');
          await postJson('/api/download-images', { linkIds: [linkId], maxLinks: 1, maxImages: 60 });
          refreshTaskStatus();
        } catch (err) {
          clearActionPending(button);
          setStatus(err.message, true);
        }
      });
    });

    document.querySelectorAll('[data-run-seller]').forEach(function (button) {
      button.addEventListener('click', async function () {
        if (!canRunTask()) return;
        const sellerId = button.dataset.runSeller;
        const linkIds = listFromCsv(button.dataset.runSellerLinks);
        setActionPending(button);
        try {
          setStatus('已提交：爬取卖家 ' + sellerId + ' 的图片');
          await postJson('/api/download-images', { sellerIds: [sellerId], linkIds: linkIds, maxLinks: Math.max(1, linkIds.length), maxImages: 200 });
          refreshTaskStatus();
        } catch (err) {
          clearActionPending(button);
          setStatus(err.message, true);
        }
      });
    });

    document.querySelectorAll('[data-run-link-ocr]').forEach(function (button) {
      button.addEventListener('click', async function () {
        if (!canRunTask()) return;
        const linkId = button.dataset.runLinkOcr;
        setActionPending(button);
        try {
          setStatus('已提交：识别 ' + linkId + ' 的 UID');
          await postJson('/api/ocr-uids', { linkIds: [linkId] });
          refreshTaskStatus();
        } catch (err) {
          clearActionPending(button);
          setStatus(err.message, true);
        }
      });
    });

    document.querySelectorAll('[data-run-seller-ocr]').forEach(function (button) {
      button.addEventListener('click', async function () {
        if (!canRunTask()) return;
        const sellerId = button.dataset.runSellerOcr;
        const linkIds = listFromCsv(button.dataset.runSellerOcrLinks);
        setActionPending(button);
        try {
          setStatus('已提交：识别卖家 ' + sellerId + ' 的 UID');
          await postJson('/api/ocr-uids', { sellerIds: [sellerId], linkIds: linkIds });
          refreshTaskStatus();
        } catch (err) {
          clearActionPending(button);
          setStatus(err.message, true);
        }
      });
    });

    document.querySelectorAll('.actions-cell a.text-action').forEach(function (link) {
      link.addEventListener('click', function () {
        setActionPending(link, '正在跳转...');
      });
    });

    const runSelected = document.querySelector('[data-run-selected]');
    if (runSelected) {
      runSelected.addEventListener('click', async function () {
        if (!canRunTask()) return;
        const linkIds = checkedLinkIds();
        if (!linkIds.length) return;
        try {
          setStatus('已提交：爬取 ' + linkIds.length + ' 个 link 的图片');
          await postJson('/api/download-images', { linkIds: linkIds, maxLinks: linkIds.length, maxImages: Math.max(60, linkIds.length * 60) });
          refreshTaskStatus();
        } catch (err) {
          setStatus(err.message, true);
        }
      });
    }

    const runSelectedSellers = document.querySelector('[data-run-selected-sellers]');
    if (runSelectedSellers) {
      runSelectedSellers.addEventListener('click', async function () {
        if (!canRunTask()) return;
        const sellerIds = checkedSellerIds();
        const linkIds = linkIdsForCheckedSellers();
        if (!sellerIds.length) return;
        try {
          setStatus('已提交：爬取 ' + sellerIds.length + ' 个卖家的图片');
          await postJson('/api/download-images', { sellerIds: sellerIds, linkIds: linkIds, maxLinks: Math.max(1, linkIds.length), maxImages: Math.max(200, sellerIds.length * 120) });
          refreshTaskStatus();
        } catch (err) {
          setStatus(err.message, true);
        }
      });
    }

    if (apiAvailable()) {
      refreshTaskStatus();
      setInterval(refreshTaskStatus, 5000);
    } else {
      canRunTask();
    }
  }

  function setupKeywordForm() {
    const form = document.querySelector('[data-keyword-form]');
    if (!form) return;
    if (!apiAvailable()) {
      setStatus('本页是静态打开的；请双击 04_start_dashboard.bat 后用本地 dashboard 新增关键词。', true);
      return;
    }
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      const data = new FormData(form);
      const keyword = String(data.get('keyword') || '').trim();
      const keywordType = String(data.get('keywordType') || '').trim();
      const gameName = String(data.get('gameName') || '').trim();
      if (!keyword) return;
      try {
        setStatus('正在新增关键词：' + keyword);
        await postJson('/api/keywords', { keyword: keyword, keywordType: keywordType, gameName: gameName });
        setStatus('关键词已保存，页面已重新生成，请刷新查看最新列表。');
        form.reset();
      } catch (err) {
        setStatus(err.message, true);
      }
    });

    document.querySelectorAll('[data-save-keyword]').forEach(function (button) {
      button.addEventListener('click', async function () {
        const keyword = String(button.dataset.saveKeyword || '').trim();
        const row = button.closest('tr');
        const keywordTypeInput = row ? row.querySelector('[data-edit-keyword-type]') : null;
        const gameNameInput = row ? row.querySelector('[data-edit-game-name]') : null;
        const keywordType = String(keywordTypeInput && keywordTypeInput.value || '').trim();
        const gameName = String(gameNameInput && gameNameInput.value || '').trim();
        if (!keyword) return;
        if (!keywordType || !gameName) {
          setStatus('关键词类型和游戏名称不能为空。', true);
          return;
        }
        try {
          button.disabled = true;
          setStatus('正在更新关键词类型：' + keyword);
          await postJson('/api/keywords', { keyword: keyword, keywordType: keywordType, gameName: gameName });
          if (row) {
            row.dataset.keywordType = keywordType;
            row.dataset.gameName = gameName;
            row.dataset.search = [keyword, keywordType, gameName, row.textContent || ''].join(' ').toLowerCase();
          }
          setStatus('关键词已更新。页面已重新生成，请刷新查看其他页面的最新分类。');
        } catch (err) {
          setStatus(err.message, true);
        } finally {
          button.disabled = false;
        }
      });
    });

    document.querySelectorAll('[data-delete-keyword]').forEach(function (button) {
      button.addEventListener('click', async function () {
        const keyword = String(button.dataset.deleteKeyword || '').trim();
        if (!keyword) return;
        const deleteRelated = true;
        if (!window.confirm('删除关键词：' + keyword + '\\n\\n会同时删除这个关键词相关的商品线索、卖家聚合记录、图片记录和本地图片文件。\\n\\n点“确定”删除，点“取消”不删除。')) return;
        try {
          setStatus('正在删除关键词：' + keyword);
          const result = await deleteJson('/api/keywords', { keyword: keyword, deleteRelated: deleteRelated });
          const deleted = result.deleted || {};
          const detail = deleteRelated
            ? '，并删除 links ' + (deleted.links || 0) + ' 条、图片记录 ' + (deleted.images || 0) + ' 条、本地图片 ' + (deleted.files || 0) + ' 个'
            : '，已保留已有 links 和图片';
          setStatus('关键词已删除' + detail + '。页面已重新生成，请刷新查看最新列表。');
          button.closest('tr')?.remove();
        } catch (err) {
          setStatus(err.message, true);
        }
      });
    });
  }

  function setupImageCsvDownloadLink() {
    const toolbar = document.querySelector('.gallery') ? document.querySelector('.toolbar') : null;
    if (!toolbar || !document.querySelector('[data-image-row]')) return;
    if (toolbar.querySelector('[data-download-image-csv]')) return;
    const link = document.createElement('a');
    link.className = 'text-action toolbar-action';
    link.href = 'image_uid_export.csv';
    link.download = 'image_uid_filtered_export.csv';
    link.dataset.downloadImageCsv = '1';
    link.textContent = '下载 CSV';
    link.addEventListener('click', function (event) {
      event.preventDefault();
      const search = document.querySelector('[data-filter-search]');
      const uidFilter = document.querySelector('[data-filter-uid]');
      const selects = Array.from(document.querySelectorAll('[data-filter-select]'));
      const term = String(search && search.value || '').trim().toLowerCase();
      const uidTerm = String(uidFilter && uidFilter.value || '').trim().toLowerCase();
      const rows = Array.from(document.querySelectorAll('[data-image-row]')).filter(function (row) {
        const target = row.closest('[data-filter-target]');
        if (row.hidden || (target && target.hidden)) return false;
        const targetSearch = String(target && target.dataset.search || '').toLowerCase();
        const rowSearch = String(row.dataset.search || '').toLowerCase();
        const groupMatchesTerm = !term || targetSearch.indexOf(term) !== -1;
        const rowMatchesTerm = !term || rowSearch.indexOf(term) !== -1;
        if (term && !groupMatchesTerm && !rowMatchesTerm) return false;
        if (uidTerm && String(row.dataset.uid || '').toLowerCase().indexOf(uidTerm) === -1) return false;
        for (const select of selects) {
          if (!select.value) continue;
          const key = String(select.dataset.field || '');
          if (key === 'usable' && String(row.dataset.usable || '') !== select.value) return false;
          if (key === 'imageStatus' && String(row.dataset.imageStatus || '') !== select.value) return false;
          if (key === 'ocrConfidence' && String(row.dataset.ocrConfidence || '') !== select.value) return false;
          if (key !== 'usable' && key !== 'imageStatus' && key !== 'ocrConfidence') {
            const targetValue = String(target && target.dataset[key] || '');
            if (targetValue !== select.value && targetValue.split('|').indexOf(select.value) === -1) return false;
          }
        }
        return true;
      });
      const csvRows = [['image_id', 'updated_at', 'uid']].concat(rows.map(function (row) {
        return [
          row.dataset.imageId || '',
          row.dataset.updatedAt || '',
          row.dataset.uid || '',
        ];
      }));
      const csv = csvRows.map(function (row) {
        return row.map(function (cell) {
          const value = String(cell == null ? '' : cell);
          return /[",\\r\\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
        }).join(',');
      }).join('\\r\\n') + '\\r\\n';
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const temp = document.createElement('a');
      temp.href = url;
      temp.download = link.download;
      document.body.appendChild(temp);
      temp.click();
      temp.remove();
      URL.revokeObjectURL(url);
    });
    toolbar.insertBefore(link, toolbar.firstChild);
  }

  function setupNoUidCleanupButton() {
    const toolbar = document.querySelector('.gallery') ? document.querySelector('.toolbar') : null;
    if (!toolbar || !document.querySelector('[data-image-row]')) return;
    if (toolbar.querySelector('[data-cleanup-no-uid-images]')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'text-action toolbar-action danger-action';
    button.dataset.cleanupNoUidImages = '1';
    button.textContent = '清理无 UID 图片';
    button.addEventListener('click', async function () {
      if (!apiAvailable()) {
        setStatus('本页是静态打开的；请双击 04_start_dashboard.bat 后用本地 dashboard 清理。', true);
        return;
      }
      try {
        setActionPending(button, '正在预估...');
        const preview = await postJson('/api/cleanup/no-uid-images', { dryRun: true });
        clearActionPending(button);
        if (!preview.count) {
          setStatus('没有可清理的无 UID 图片。');
          return;
        }
        setStatus('可清理 ' + preview.count + ' 张无 UID 图片，预计释放 ' + preview.mb + ' MB。');
        const ok = window.confirm('将清理 ' + preview.count + ' 张无 UID 图片，预计释放 ' + preview.mb + ' MB。记录会保留，后续不会重复下载这些图片。确认继续？');
        if (!ok) return;
        setActionPending(button);
        await postJson('/api/cleanup/no-uid-images');
        clearActionPending(button);
        setStatus('已提交清理任务：' + preview.count + ' 张无 UID 图片。');
        refreshTaskStatus();
      } catch (err) {
        clearActionPending(button);
        setStatus(err.message, true);
      }
    });
    toolbar.insertBefore(button, toolbar.firstChild);
  }

  function setupImageConfidenceFilter() {
    const toolbar = document.querySelector('.gallery') ? document.querySelector('.toolbar') : null;
    if (!toolbar || !document.querySelector('[data-image-row]')) return;
    if (toolbar.querySelector('[data-field="ocrConfidence"]')) return;
    const label = document.createElement('label');
    const span = document.createElement('span');
    const select = document.createElement('select');
    span.textContent = 'OCR置信度';
    select.dataset.filterSelect = '1';
    select.dataset.field = 'ocrConfidence';
    [
      ['', '全部'],
      ['high_confidence', 'high_confidence'],
      ['low_confidence', 'low_confidence'],
      ['none', 'none'],
    ].forEach(function (item) {
      const option = document.createElement('option');
      option.value = item[0];
      option.textContent = item[1];
      select.appendChild(option);
    });
    label.appendChild(span);
    label.appendChild(select);
    const keywordFilter = toolbar.querySelector('[data-field="keywordType"]');
    toolbar.insertBefore(label, keywordFilter ? keywordFilter.closest('label') : toolbar.querySelector('.visible-count'));
  }

  function setupImageUidFilter() {
    const toolbar = document.querySelector('.gallery') ? document.querySelector('.toolbar') : null;
    if (!toolbar || !document.querySelector('[data-image-row]')) return;
    if (toolbar.querySelector('[data-filter-uid]')) return;
    const label = document.createElement('label');
    const span = document.createElement('span');
    const input = document.createElement('input');
    span.textContent = 'UID';
    input.dataset.filterUid = '1';
    input.type = 'search';
    input.placeholder = '输入 UID';
    label.appendChild(span);
    label.appendChild(input);
    const usableFilter = toolbar.querySelector('[data-field="usable"]');
    toolbar.insertBefore(label, usableFilter ? usableFilter.closest('label').nextSibling : toolbar.querySelector('.visible-count'));
  }

  function setupFilters() {
    const search = document.querySelector('[data-filter-search]');
    const uidFilter = document.querySelector('[data-filter-uid]');
    const selects = Array.from(document.querySelectorAll('[data-filter-select]'));
    const targets = Array.from(document.querySelectorAll('[data-filter-target]'));
    const visibleCount = document.querySelector('[data-visible-count]');
    const emptyState = document.querySelector('[data-empty-state]');
    const params = new URLSearchParams(window.location.search);
    const selectedLinkId = String(params.get('link_id') || '').trim();
    const selectedSellerId = String(params.get('seller_id') || '').trim();
    const imageFilterMode = Boolean(document.querySelector('[data-image-row]'));
    const sellerFilterMode = Boolean(document.querySelector('.sellers-table'));

    if (selectedLinkId && search) {
      search.value = selectedLinkId;
    }
    if (selectedSellerId && search) {
      search.value = selectedSellerId;
    }
    if (selectedLinkId && emptyState) {
      emptyState.textContent = '这个 link 暂无图片：' + selectedLinkId;
    }
    if (selectedSellerId && emptyState) {
      emptyState.textContent = '这个卖家暂无图片：' + selectedSellerId;
    }

    function setStat(key, value, subValue) {
      const card = document.querySelector('[data-stat-card="' + key + '"]');
      if (!card) return;
      const valueEl = card.querySelector('[data-stat-value]');
      const subEl = card.querySelector('[data-stat-sub]');
      if (valueEl) valueEl.textContent = String(value);
      if (subEl && subValue !== undefined) subEl.textContent = String(subValue);
    }

    function updateImageStats() {
      if (!imageFilterMode) return;
      const rows = Array.from(document.querySelectorAll('[data-image-row]')).filter(function (row) {
        return !row.hidden && !row.closest('[data-filter-target][hidden]');
      });
      const localCount = rows.filter(function (row) { return row.dataset.localImage === 'yes'; }).length;
      const savedCount = rows.filter(function (row) { return row.dataset.savedImage === 'yes'; }).length;
      const usableRows = rows.filter(function (row) { return row.dataset.usable === 'yes'; });
      const unusableCount = rows.filter(function (row) { return row.dataset.usable !== 'yes'; }).length;
      const uniqueUids = new Set(usableRows.map(function (row) { return row.dataset.uid || ''; }).filter(Boolean));
      setStat('imageRecords', rows.length, '本地图片 ' + localCount);
      setStat('savedImages', savedCount, '当前筛选结果');
      setStat('uidUsableImages', usableRows.length, '不可用 ' + unusableCount);
      setStat('uniqueUsableUids', uniqueUids.size, '当前筛选结果去重');
      setStat('visibleImages', rows.length, '随筛选变化');
    }

    function updateSellerStats() {
      if (!sellerFilterMode) return;
      const rows = Array.from(document.querySelectorAll('.sellers-table [data-filter-target]')).filter(function (row) {
        return !row.hidden;
      });
      const multiLinkCount = rows.filter(function (row) {
        return Number(row.dataset.sellerLinkCount || 0) > 1;
      }).length;
      const withImagesCount = rows.filter(function (row) {
        return Number(row.dataset.sellerImageCount || 0) > 0;
      }).length;
      const usableImages = rows.reduce(function (sum, row) {
        return sum + Number(row.dataset.sellerUsableCount || 0);
      }, 0);
      const duplicateHidden = rows.reduce(function (sum, row) {
        return sum + Math.max(0, Number(row.dataset.sellerRawImageCount || 0) - Number(row.dataset.sellerImageCount || 0));
      }, 0);
      setStat('sellerRecords', rows.length, '多商品卖家 ' + multiLinkCount);
      setStat('sellerWithImages', withImagesCount, '已隐藏重复图片 ' + duplicateHidden);
      setStat('sellerUsableImages', usableImages, '当前筛选结果');
      setStat('visibleSellers', rows.length, '随筛选变化');
    }

    function apply() {
      const term = String(search && search.value || '').trim().toLowerCase();
      const uidTerm = String(uidFilter && uidFilter.value || '').trim().toLowerCase();
      let shown = 0;
      targets.forEach(function (target) {
        let ok = true;
        if (selectedLinkId) ok = String(target.dataset.linkId || '') === selectedLinkId;
        if (selectedSellerId) ok = String(target.dataset.sellerId || '') === selectedSellerId;
        const groupMatchesTerm = !term || String(target.dataset.search || '').toLowerCase().indexOf(term) !== -1;
        if (ok && !imageFilterMode) ok = groupMatchesTerm;
        selects.forEach(function (select) {
          if (!ok || !select.value) return;
          const key = String(select.dataset.field || '');
          const targetValue = String(target.dataset[key] || '');
          const matchesValue = targetValue === select.value || targetValue.split('|').indexOf(select.value) !== -1;
          if (!(imageFilterMode && (key === 'usable' || key === 'ocrConfidence' || key === 'imageStatus')) && !matchesValue) ok = false;
        });
        if (imageFilterMode) {
          let visibleRows = 0;
          Array.from(target.querySelectorAll('[data-image-row]')).forEach(function (row) {
            let rowOk = ok;
            const rowMatchesTerm = !term || String(row.dataset.search || '').toLowerCase().indexOf(term) !== -1;
            if (rowOk && term && !groupMatchesTerm && !rowMatchesTerm) rowOk = false;
            if (rowOk && uidTerm && String(row.dataset.uid || '').toLowerCase().indexOf(uidTerm) === -1) rowOk = false;
            selects.forEach(function (select) {
              if (!rowOk || !select.value) return;
              const key = String(select.dataset.field || '');
              if (key === 'usable' && String(row.dataset.usable || '') !== select.value) rowOk = false;
              if (key === 'imageStatus' && String(row.dataset.imageStatus || '') !== select.value) rowOk = false;
              if (key === 'ocrConfidence' && String(row.dataset.ocrConfidence || '') !== select.value) rowOk = false;
            });
            row.hidden = !rowOk;
            if (rowOk) visibleRows += 1;
          });
          target.hidden = !ok || visibleRows === 0;
          shown += visibleRows;
        } else {
          target.hidden = !ok;
          if (ok) shown += 1;
        }
      });
    if (visibleCount) visibleCount.textContent = String(shown);
      if (emptyState) emptyState.hidden = shown !== 0;
      updateImageStats();
      updateSellerStats();
      updateSelectionState();
    }

    if (search) search.addEventListener('input', apply);
    if (uidFilter) uidFilter.addEventListener('input', apply);
    selects.forEach(function (select) {
      select.addEventListener('change', apply);
    });
    apply();
  }

  function highlightHashTarget() {
    if (!window.location.hash) return;
    const id = decodeURIComponent(window.location.hash.slice(1));
    const target = document.getElementById(id);
    if (!target) return;
    target.classList.add('target-hit');
    setTimeout(function () {
      target.classList.remove('target-hit');
    }, 1800);
  }

  function setupBackToTop() {
    const button = document.querySelector('[data-back-to-top]');
    if (!button) return;
    function updateVisibility() {
      button.classList.toggle('is-visible', window.scrollY > 360);
    }
    button.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    window.addEventListener('scroll', updateVisibility, { passive: true });
    updateVisibility();
  }

  document.addEventListener('error', function (event) {
    const img = event.target;
    if (!img || img.tagName !== 'IMG') return;
    const card = img.closest('.list-preview, .preview-strip');
    if (card) card.classList.add('image-missing');
  }, true);

  setupImageConfidenceFilter();
  setupImageUidFilter();
  setupNoUidCleanupButton();
  setupImageCsvDownloadLink();
  setupFilters();
  setupActions();
  setupKeywordForm();
  setupBackToTop();
  setTimeout(highlightHashTarget, 80);
  window.addEventListener('hashchange', highlightHashTarget);
}());
`;
}

function indexHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0; url=sellers.html">
  <title>Xianyu Review Image Index</title>
</head>
<body>
  <a href="sellers.html">打开卖家页面</a>
</body>
</html>
`;
}

async function main() {
  const [links, images, keywords] = await Promise.all([
    readCsv(LINK_STATE_FILE),
    readCsv(IMAGE_STATE_FILE),
    loadKeywords(),
  ]);
  normalizeLinkSellerNames(links);
  const imagesByLink = groupImagesByLink(images);
  const imagesBySeller = groupImagesBySeller(images, links);
  const keywordByText = new Map(keywords.map((row) => [keywordKey(row.keyword), row]));
  const sellers = buildSellerRows(links, imagesBySeller, keywordByText);
  const generatedAt = formatDate(new Date().toISOString());

  await fs.mkdir(ASSETS_DIR, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(SITE_DIR, 'sellers.html'), renderSellersPage(sellers, keywords, generatedAt), 'utf8'),
    fs.writeFile(path.join(SITE_DIR, 'links.html'), renderLinksPage(links, imagesByLink, keywords, keywordByText, generatedAt), 'utf8'),
    fs.writeFile(path.join(SITE_DIR, 'images.html'), renderImagesPage(links, images, imagesBySeller, keywords, keywordByText, generatedAt), 'utf8'),
    fs.writeFile(path.join(SITE_DIR, 'keywords.html'), renderKeywordsPage(keywords, links, images, generatedAt), 'utf8'),
    fs.writeFile(path.join(SITE_DIR, 'index.html'), indexHtml(), 'utf8'),
    fs.writeFile(path.join(ASSETS_DIR, 'app.css'), css(), 'utf8'),
    fs.writeFile(path.join(ASSETS_DIR, 'app.js'), appJs(), 'utf8'),
    writeImageUidExport(images),
  ]);

  console.log(`Generated site: ${path.join(SITE_DIR, 'sellers.html')}`);
  console.log(`Sellers: ${sellers.length}`);
  console.log(`Links: ${links.length}`);
  console.log(`Images: ${images.length}`);
  console.log(`Keywords: ${keywords.length}`);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

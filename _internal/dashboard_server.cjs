#!/usr/bin/env node
'use strict';

const http = require('http');
const fsSync = require('fs');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { readCsvRows, writeCsvRows, writeFileAtomic } = require('./csv_utils.cjs');

const INTERNAL_DIR = __dirname;
const ROOT_DIR = path.basename(INTERNAL_DIR).toLowerCase() === '_internal' ? path.resolve(INTERNAL_DIR, '..') : INTERNAL_DIR;
const SITE_DIR = path.join(ROOT_DIR, 'site');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const KEYWORD_STATE_FILE = path.join(DATA_DIR, 'keyword_state.csv');
const LINK_STATE_FILE = path.join(DATA_DIR, 'link_state.csv');
const IMAGE_STATE_FILE = path.join(DATA_DIR, 'image_state.csv');
const KEYWORD_CONFIG_FILE = path.join(ROOT_DIR, 'config', 'xianyu_keywords.txt');
const LOCAL_DEFAULTS_FILE = path.join(ROOT_DIR, 'config', 'xianyu_local_defaults.json');
const KEYWORD_HEADERS = ['keyword', 'keyword_type', 'game_name', 'created_at', 'updated_at', 'notes'];
const LINK_HEADERS = ['link_id', 'keyword', 'item_url', 'seller_url', 'review_url', 'seller_name', 'item_title', 'card_text', 'has_images', 'total_images', 'images_downloaded', 'images_remaining', 'link_status', 'image_status', 'last_link_crawl_at', 'last_image_crawl_at', 'notes'];
const IMAGE_HEADERS = ['image_id', 'seller_id', 'link_id', 'keyword', 'seller_url', 'review_url', 'thumb_url', 'original_url', 'local_path', 'source', 'width', 'height', 'content_type', 'bytes', 'sha256', 'status', 'downloaded_at', 'notes', 'uid', 'usable'];
const MAX_LINKS_PER_TASK = 2000;
const MAX_IMAGES_PER_TASK = 100000;
function loadLocalDefaults() {
  try {
    const raw = fsSync.readFileSync(LOCAL_DEFAULTS_FILE, 'utf8');
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error && error.code === 'ENOENT') return {};
    throw new Error(`Cannot read local defaults: ${LOCAL_DEFAULTS_FILE}: ${error.message || String(error)}`);
  }
}
const LOCAL_DEFAULTS = loadLocalDefaults();
const DEFAULT_KEYWORD_TYPE = String(LOCAL_DEFAULTS.keyword_type || LOCAL_DEFAULTS.keywordType || 'general').trim() || 'general';
const DEFAULT_GAME_NAME = String(LOCAL_DEFAULTS.game_name || LOCAL_DEFAULTS.gameName || 'default').trim() || 'default';
const PORT = Number(process.env.XIANYU_DASHBOARD_PORT || 8788);
const NODE_EXE = process.execPath;
const BUNDLED_PYTHON_EXE = path.join(
  process.env.USERPROFILE || os.homedir(),
  '.cache',
  'codex-runtimes',
  'codex-primary-runtime',
  'dependencies',
  'python',
  'python.exe',
);
const PYTHON_EXE = fsSync.existsSync(BUNDLED_PYTHON_EXE) ? BUNDLED_PYTHON_EXE : 'python';

const runningTasks = new Map();
const taskHistory = [];
let lastLiveRegenerateAt = 0;
let liveRegenerateRunning = false;
let taskSequence = 0;

function jsonResponse(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload, null, 2));
}

function textResponse(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function sanitizeLinkIds(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  return raw
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .filter((item) => /^[a-zA-Z0-9_-]{1,120}$/.test(item));
}

const sanitizeSellerIds = sanitizeLinkIds;

function sanitizeKeywords(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[,\n\r|]+/);
  return [...new Set(raw
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .filter((item) => item.length <= 120))].slice(0, 30);
}

async function readKeywordConfig() {
  try {
    const raw = await fs.readFile(KEYWORD_CONFIG_FILE, 'utf8');
    return raw.replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
}

async function syncKeywordConfig(rows) {
  const keywords = [...new Set(rows.map((row) => String(row.keyword || '').trim()).filter(Boolean))];
  await fs.mkdir(path.dirname(KEYWORD_CONFIG_FILE), { recursive: true });
  await writeFileAtomic(KEYWORD_CONFIG_FILE, `${keywords.join('\r\n')}\r\n`, 'utf8');
}

async function ensureKeywordState() {
  const rows = await readCsvRows(KEYWORD_STATE_FILE);
  const configKeywords = await readKeywordConfig();
  const byKeyword = new Map();
  const now = nowIso();
  for (const row of rows) {
    const keyword = String(row.keyword || '').trim();
    if (!keyword) continue;
    byKeyword.set(keyword.toLowerCase(), {
      keyword,
      keyword_type: String(row.keyword_type || '').trim() === '未分类' ? DEFAULT_KEYWORD_TYPE : String(row.keyword_type || '').trim() || DEFAULT_KEYWORD_TYPE,
      game_name: String(row.game_name || '').trim() || DEFAULT_GAME_NAME,
      created_at: row.created_at || now,
      updated_at: row.updated_at || row.created_at || now,
      notes: row.notes || '',
    });
  }
  for (const keyword of configKeywords) {
    const key = keyword.toLowerCase();
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
  await writeCsvRows(KEYWORD_STATE_FILE, KEYWORD_HEADERS, out);
  await syncKeywordConfig(out);
  return out;
}

async function linkIdsForKeywords(keywords) {
  const selected = new Set(keywords.map((keyword) => String(keyword || '').trim().toLowerCase()).filter(Boolean));
  if (!selected.size) return [];
  const rows = await readCsvRows(path.join(DATA_DIR, 'link_state.csv'));
  return [...new Set(rows
    .filter((row) => selected.has(String(row.keyword || '').trim().toLowerCase()))
    .map((row) => String(row.link_id || '').trim())
    .filter(Boolean))];
}

function filterKeywordRows(rows, keywordType, gameName, submittedKeywords) {
  const type = String(keywordType || '').trim();
  const game = String(gameName || '').trim();
  const submitted = new Set(submittedKeywords.map((keyword) => String(keyword || '').trim().toLowerCase()).filter(Boolean));
  if (!type && !game) return submittedKeywords;
  return rows
    .filter((row) => !type || String(row.keyword_type || '').trim() === type)
    .filter((row) => !game || String(row.game_name || '').trim() === game)
    .map((row) => String(row.keyword || '').trim())
    .filter(Boolean)
    .filter((keyword) => !submitted.size || submitted.has(keyword.toLowerCase()));
}

async function keywordsForFilters(keywordType, gameName, submittedKeywords) {
  return filterKeywordRows(await ensureKeywordState(), keywordType, gameName, submittedKeywords);
}

async function linkCountsByKeyword() {
  const rows = await readCsvRows(path.join(DATA_DIR, 'link_state.csv'));
  const counts = new Map();
  for (const row of rows) {
    const keyword = String(row.keyword || '').trim();
    if (!keyword) continue;
    const key = keyword.toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function isPathInside(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveLocalDataPath(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const absolute = path.isAbsolute(text) ? text : path.resolve(ROOT_DIR, text);
  return isPathInside(ROOT_DIR, absolute) ? absolute : '';
}

function isNoUidCleanupCandidate(row) {
  const uid = String(row.uid || '').trim();
  const notes = String(row.notes || '');
  const localPath = resolveLocalDataPath(row.local_path);
  return !uid
    && notes.includes('uid_ocr:')
    && localPath
    && fsSync.existsSync(localPath)
    && String(row.status || '').trim() !== 'discarded_no_uid';
}

async function cleanupNoUidImages({ dryRun = true } = {}) {
  const rows = await readCsvRows(IMAGE_STATE_FILE);
  let count = 0;
  let bytes = 0;
  const now = nowIso();
  for (const row of rows) {
    if (!isNoUidCleanupCandidate(row)) continue;
    const localPath = resolveLocalDataPath(row.local_path);
    let size = 0;
    try {
      size = fsSync.statSync(localPath).size;
    } catch {
      size = 0;
    }
    count += 1;
    bytes += size;
    if (dryRun) continue;
    await fs.unlink(localPath).catch(() => {});
    const oldNotes = String(row.notes || '').trim();
    const kept = oldNotes ? `${oldNotes}; ` : '';
    row.notes = `${kept}cleanup:discarded_no_uid:${now}:path=${localPath}`;
    row.local_path = '';
    row.status = 'discarded_no_uid';
    row.bytes = row.bytes || String(size || '');
  }
  if (!dryRun) await writeCsvRows(IMAGE_STATE_FILE, IMAGE_HEADERS, rows);
  return { count, bytes, mb: Math.round((bytes / 1024 / 1024) * 100) / 100 };
}

function planKeywordRelatedDeletion(keyword, linkRows, imageRows) {
  const key = String(keyword || '').trim().toLowerCase();
  if (!key) return { keptLinks: [...linkRows], deletedLinks: [], keptImages: [...imageRows], deletedImages: [], rehomedImages: 0 };
  const deletedLinks = linkRows.filter((row) => String(row.keyword || '').trim().toLowerCase() === key);
  const deletedLinkIds = new Set(deletedLinks.map((row) => String(row.link_id || '').trim()).filter(Boolean));
  const keptLinks = linkRows.filter((row) => String(row.keyword || '').trim().toLowerCase() !== key);
  const keptLinkBySeller = new Map();
  for (const row of keptLinks) {
    const sellerId = sellerIdFromLink(row);
    if (sellerId && !keptLinkBySeller.has(sellerId)) keptLinkBySeller.set(sellerId, row);
  }
  const deletedSellerIds = new Set(deletedLinks.map(sellerIdFromLink).filter(Boolean));
  const exclusiveSellerIds = new Set([...deletedSellerIds].filter((sellerId) => !keptLinkBySeller.has(sellerId)));

  const keptImages = [];
  const deletedImages = [];
  let rehomedImages = 0;
  for (const originalRow of imageRows) {
    const sellerId = sellerIdFromLink(originalRow);
    const imageKeyword = String(originalRow.keyword || '').trim().toLowerCase();
    const imageLinkId = String(originalRow.link_id || '').trim();
    const directlyRelated = imageKeyword === key || (imageLinkId && deletedLinkIds.has(imageLinkId));
    if (sellerId && exclusiveSellerIds.has(sellerId)) {
      deletedImages.push(originalRow);
      continue;
    }
    const replacement = sellerId ? keptLinkBySeller.get(sellerId) : null;
    if (directlyRelated && replacement) {
      keptImages.push({
        ...originalRow,
        link_id: replacement.link_id || originalRow.link_id,
        keyword: replacement.keyword || originalRow.keyword,
        seller_url: replacement.seller_url || originalRow.seller_url,
        review_url: replacement.review_url || originalRow.review_url,
      });
      rehomedImages += 1;
      continue;
    }
    if (directlyRelated) deletedImages.push(originalRow);
    else keptImages.push(originalRow);
  }

  return { keptLinks, deletedLinks, keptImages, deletedImages, rehomedImages };
}

async function deleteKeywordRelatedData(keyword) {
  const key = String(keyword || '').trim().toLowerCase();
  if (!key) return { links: 0, images: 0, files: 0, bytes: 0, mb: 0, rehomedImages: 0 };

  const linkRows = await readCsvRows(LINK_STATE_FILE);
  const imageRows = await readCsvRows(IMAGE_STATE_FILE);
  const plan = planKeywordRelatedDeletion(key, linkRows, imageRows);

  let files = 0;
  let bytes = 0;
  for (const row of plan.deletedImages) {
    const localPath = resolveLocalDataPath(row.local_path);
    if (!localPath || !fsSync.existsSync(localPath)) continue;
    try {
      const stat = fsSync.statSync(localPath);
      bytes += stat.size || 0;
      await fs.unlink(localPath);
      files += 1;
    } catch {
      // Keep deleting CSV records even if a local file is already gone or locked.
    }
  }

  await writeCsvRows(LINK_STATE_FILE, LINK_HEADERS, plan.keptLinks);
  await writeCsvRows(IMAGE_STATE_FILE, IMAGE_HEADERS, plan.keptImages);
  return {
    links: plan.deletedLinks.length,
    images: plan.deletedImages.length,
    files,
    bytes,
    mb: Math.round((bytes / 1024 / 1024) * 100) / 100,
    rehomedImages: plan.rehomedImages,
  };
}

function userIdFromUrl(raw) {
  try {
    return new URL(String(raw || '').trim()).searchParams.get('userId') || '';
  } catch {
    return '';
  }
}

function sellerIdFromLink(row) {
  const explicit = String(row.seller_id || '').trim();
  if (explicit) return explicit;
  const userId = userIdFromUrl(row.seller_url || row.review_url || '');
  if (userId) return `seller_${userId}`;
  const linkId = String(row.link_id || '').trim();
  if (linkId.startsWith('seller_')) return linkId;
  return linkId;
}

async function linkIdsForSellers(sellerIds) {
  const selected = new Set(sellerIds.map((sellerId) => String(sellerId || '').trim()).filter(Boolean));
  if (!selected.size) return [];
  const rows = await readCsvRows(path.join(DATA_DIR, 'link_state.csv'));
  const picked = [];
  const seen = new Set();
  for (const row of rows) {
    const sellerId = sellerIdFromLink(row);
    if (!selected.has(sellerId) || seen.has(sellerId)) continue;
    const linkId = String(row.link_id || '').trim();
    if (!linkId) continue;
    picked.push(linkId);
    seen.add(sellerId);
  }
  return picked;
}

async function allLinkIdsForSellers(sellerIds) {
  const selected = new Set(sellerIds.map((sellerId) => String(sellerId || '').trim()).filter(Boolean));
  if (!selected.size) return [];
  const rows = await readCsvRows(path.join(DATA_DIR, 'link_state.csv'));
  return [...new Set(rows
    .filter((row) => selected.has(sellerIdFromLink(row)))
    .map((row) => String(row.link_id || '').trim())
    .filter(Boolean))];
}

function nowIso() {
  return new Date().toISOString();
}

function taskSnapshot() {
  const activeTasks = Array.from(runningTasks.values()).map((task) => ({
    ...task,
    progress: taskProgress(task),
    elapsedSeconds: Math.max(0, Math.round((Date.now() - Date.parse(task.startedAt || nowIso())) / 1000)),
    lastOutputLines: String(task.output || '').split(/\r?\n/).filter(Boolean).slice(-8),
  }));
  return {
    currentTask: activeTasks[0] || null,
    currentTasks: activeTasks,
    history: taskHistory.slice(-8).reverse(),
  };
}

function taskProgress(task) {
  if (!task) return null;
  let done = Number(task.progressDone || 0);
  let total = Number(task.progressTotal || 0);
  let kind = task.progressKind || '';
  const output = String(task.output || '');
  const progressPattern = /TASK_PROGRESS\s+([a-z-]+)\s+done=(\d+)\s+total=(\d+)/g;
  let marker;
  let latestMarker = null;
  while ((marker = progressPattern.exec(output))) latestMarker = marker;
  if (latestMarker) {
    kind = latestMarker[1] || kind;
    done = Math.max(done, Number(latestMarker[2] || 0));
    total = Number(latestMarker[3] || total);
  } else if (kind === 'download-images') {
    const matches = output.match(/== Download review images:/g);
    done = Math.max(done, matches ? matches.length : 0);
  }
  if (!kind && !total) return null;
  return {
    kind,
    done: Math.min(done, total),
    total,
    remaining: Math.max(0, total - done),
    unit: task.progressUnit || '个',
  };
}

function appendTaskOutput(task, text) {
  if (!task) return;
  task.output = `${task.output || ''}${text}`.slice(-16000);
}

function runNodeScript(script, args, label, task) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(INTERNAL_DIR, script);
    const child = spawn(NODE_EXE, [scriptPath, ...args], {
      cwd: ROOT_DIR,
      windowsHide: true,
    });
    const output = [];
    const push = (chunk) => {
      const text = chunk.toString();
      output.push(text);
      appendTaskOutput(task, text);
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('error', (err) => {
      if (err && err.code === 'EPERM') {
        err.message = `启动 Node 子进程被系统拒绝：${err.message}`;
      }
      reject(err);
    });
    child.on('close', (code) => {
      if (code === 0) resolve(output.join(''));
      else {
        const err = new Error(`${label} exited with code ${code}`);
        err.output = output.join('');
        err.outputAlreadyAppended = Boolean(task);
        reject(err);
      }
    });
  });
}

function isRetryableBrowserFailure(error) {
  const text = `${error?.message || ''}\n${error?.output || ''}\n${error?.stack || ''}`;
  return /Target page, context or browser has been closed|Target\.createTarget.*Failed to open a new tab|browserContext\.newPage.*closed|Browser closed|Target closed|page has been closed|context has been closed/i.test(text);
}

async function runBrowserNodeScript(script, args, label, task, maxAttempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await runNodeScript(script, args, label, task);
    } catch (error) {
      lastError = error;
      if (!isRetryableBrowserFailure(error) || attempt >= maxAttempts) throw error;
      appendTaskOutput(task, `\nBrowser session stopped unexpectedly; retrying from saved progress (${attempt + 1}/${maxAttempts}).\n`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  throw lastError;
}

function runPythonScript(script, args, label, task) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(INTERNAL_DIR, script);
    const child = spawn(PYTHON_EXE, ['-B', scriptPath, ...args], {
      cwd: ROOT_DIR,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONPYCACHEPREFIX: path.join(INTERNAL_DIR, 'tmp_pycache'),
        PYTHONUNBUFFERED: '1',
      },
    });
    const output = [];
    const push = (chunk) => {
      const text = chunk.toString();
      output.push(text);
      appendTaskOutput(task, text);
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('error', (err) => {
      if (err && err.code === 'EPERM') {
        err.message = `启动 Python 子进程被系统拒绝：${err.message}`;
      }
      reject(err);
    });
    child.on('close', (code) => {
      if (code === 0) resolve(output.join(''));
      else {
        const err = new Error(`${label} exited with code ${code}`);
        err.output = output.join('');
        err.outputAlreadyAppended = Boolean(task);
        reject(err);
      }
    });
  });
}

async function regenerateSite() {
  await ensureKeywordState();
  await runNodeScript('generate_site.cjs', [], 'generate site');
}

function maybeRegenerateSiteDuringTask() {
  if (!runningTasks.size) return;
  const now = Date.now();
  if (liveRegenerateRunning || now - lastLiveRegenerateAt < 20000) return;
  liveRegenerateRunning = true;
  lastLiveRegenerateAt = now;
  regenerateSite()
    .catch((err) => console.warn(`Live site generation failed: ${err.message}`))
    .finally(() => {
      liveRegenerateRunning = false;
    });
}

function taskConflicts(locks) {
  const wanted = new Set(locks || ['browser']);
  for (const task of runningTasks.values()) {
    const held = new Set(task.locks || ['browser']);
    for (const lock of wanted) {
      if (held.has(lock)) return task;
    }
  }
  return null;
}

function reserveTask(label, locks) {
  const conflict = taskConflicts(locks);
  if (conflict) {
    return { accepted: false, status: 409, message: `已有任务正在运行：${conflict.label}` };
  }
  const task = {
    id: `${Date.now()}_${taskSequence += 1}`,
    label,
    locks: locks || ['browser'],
    status: 'running',
    startedAt: nowIso(),
    finishedAt: '',
    output: '',
    error: '',
  };
  runningTasks.set(task.id, task);
  return { accepted: true, task };
}

async function executeReservedTask(task, worker) {
  let value;
  let failure = null;
  try {
    value = await worker(task);
  } catch (error) {
    failure = error;
    task.status = 'failed';
    task.error = error && error.message ? error.message : String(error);
    if (error && error.output && !error.outputAlreadyAppended) {
      task.output = `${task.output || ''}${error.output}`.slice(-16000);
    }
  }
  try {
    await regenerateSite();
  } catch (error) {
    appendTaskOutput(task, `\nSite regeneration failed: ${error.message || String(error)}\n`);
    if (!failure) {
      failure = error;
      task.status = 'failed';
      task.error = error && error.message ? error.message : String(error);
    }
  } finally {
    if (!failure) task.status = 'done';
    task.finishedAt = nowIso();
    taskHistory.push({ ...task });
    if (taskHistory.length > 20) taskHistory.shift();
    runningTasks.delete(task.id);
  }
  return { ok: !failure, value, error: failure, task };
}

async function enqueueTask(label, locks, worker) {
  const reservation = reserveTask(label, locks);
  if (!reservation.accepted) return reservation;
  const { task } = reservation;
  setImmediate(() => {
    executeReservedTask(task, worker).catch((error) => {
      console.error(`Task finalization failed: ${error.message || String(error)}`);
    });
  });
  return { accepted: true, task };
}

async function runTaskAndWait(label, locks, worker) {
  const reservation = reserveTask(label, locks);
  if (!reservation.accepted) return reservation;
  const execution = await executeReservedTask(reservation.task, worker);
  if (!execution.ok) {
    return {
      accepted: false,
      status: Number(execution.error?.status) || 500,
      error: execution.task.error,
      task: execution.task,
    };
  }
  return {
    accepted: true,
    status: 200,
    task: execution.task,
    value: execution.value,
  };
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  return JSON.parse(text);
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/status') {
    maybeRegenerateSiteDuringTask();
    jsonResponse(res, 200, taskSnapshot());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/keywords') {
    jsonResponse(res, 200, { keywords: await ensureKeywordState() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/cleanup/no-uid-images') {
    jsonResponse(res, 200, await cleanupNoUidImages({ dryRun: true }));
    return;
  }

  if (req.method === 'DELETE' && url.pathname === '/api/keywords') {
    const body = await readRequestBody(req);
    const keyword = String(body.keyword || '').trim();
    const deleteRelated = body.deleteRelated === true || body.deleteRelated === 'true';
    if (!keyword) {
      jsonResponse(res, 400, { error: 'keyword required' });
      return;
    }
    const result = await runTaskAndWait(`删除关键词：${keyword}`, ['browser', 'images', 'ocr', 'site'], async () => {
      const rows = await ensureKeywordState();
      const kept = rows.filter((row) => String(row.keyword || '').trim().toLowerCase() !== keyword.toLowerCase());
      if (kept.length === rows.length && !deleteRelated) {
        const error = new Error('keyword not found');
        error.status = 404;
        throw error;
      }
      if (kept.length !== rows.length) {
        await writeCsvRows(KEYWORD_STATE_FILE, KEYWORD_HEADERS, kept);
        await syncKeywordConfig(kept);
      }
      const deleted = deleteRelated
        ? await deleteKeywordRelatedData(keyword)
        : { links: 0, images: 0, files: 0, bytes: 0, mb: 0, rehomedImages: 0 };
      return { ok: true, keyword, keywords: kept.length, deleteRelated, deleted };
    });
    if (!result.accepted) {
      jsonResponse(res, result.status || 409, { error: result.message || result.error || 'task rejected' });
      return;
    }
    jsonResponse(res, 200, result.value);
    return;
  }

  if (req.method !== 'POST') {
    jsonResponse(res, 405, { error: 'Method not allowed' });
    return;
  }

  if (url.pathname === '/api/keywords') {
    const body = await readRequestBody(req);
    const keyword = String(body.keyword || '').trim();
    const keywordType = String(body.keywordType || body.keyword_type || '').trim() || DEFAULT_KEYWORD_TYPE;
    const gameName = String(body.gameName || body.game_name || '').trim() || DEFAULT_GAME_NAME;
    if (!keyword) {
      jsonResponse(res, 400, { error: 'keyword required' });
      return;
    }
    if (keyword.length > 120 || keywordType.length > 80 || gameName.length > 80) {
      jsonResponse(res, 400, { error: 'keyword, keywordType or gameName too long' });
      return;
    }
    const result = await runTaskAndWait(`保存关键词：${keyword}`, ['site'], async () => {
      const rows = await ensureKeywordState();
      const now = nowIso();
      const existing = rows.find((row) => String(row.keyword || '').trim().toLowerCase() === keyword.toLowerCase());
      if (existing) {
        existing.keyword_type = keywordType;
        existing.game_name = gameName;
        existing.updated_at = now;
        existing.notes = existing.notes || '';
      } else {
        rows.push({
          keyword,
          keyword_type: keywordType,
          game_name: gameName,
          created_at: now,
          updated_at: now,
          notes: 'added from dashboard',
        });
      }
      await writeCsvRows(KEYWORD_STATE_FILE, KEYWORD_HEADERS, rows);
      await syncKeywordConfig(rows);
      return { ok: true, keyword, keywordType, gameName, keywords: rows.length };
    });
    if (!result.accepted) {
      jsonResponse(res, result.status || 409, { error: result.message || result.error || 'task rejected' });
      return;
    }
    jsonResponse(res, 200, result.value);
    return;
  }

  if (url.pathname === '/api/discover-links') {
    const body = await readRequestBody(req);
    const rawKeywords = sanitizeKeywords(body.keywords);
    if (!rawKeywords.length) {
      jsonResponse(res, 400, { error: '关键词页抓取必须带关键词；请刷新页面后重新筛选再抓取' });
      return;
    }
    const requestedKeywords = await keywordsForFilters(body.keywordType || body.keyword_type, body.gameName || body.game_name, rawKeywords);
    if ((body.keywordType || body.keyword_type || body.gameName || body.game_name) && !requestedKeywords.length) {
      jsonResponse(res, 400, { error: '当前筛选下没有可抓取的关键词' });
      return;
    }
    const keywords = requestedKeywords;
    const keywordCount = keywords.length;
    const candidatesPerKeyword = keywordCount <= 1 ? 8 : keywordCount <= 5 ? 5 : 3;
    const maxCandidates = Math.min(18, keywordCount * candidatesPerKeyword);
    const maxInspectPages = Math.min(10, maxCandidates);
    const args = [
      '--mode', 'discover-links',
      '--cdp-url=',
      '--max-keywords', String(keywordCount),
      '--max-candidates', String(maxCandidates),
      '--max-candidates-per-keyword', String(candidatesPerKeyword),
      '--max-inspect-pages', String(maxInspectPages),
      '--max-refresh-pages', '0',
      '--max-open-pages', '2',
      '--max-invalid-inspects', '6',
      '--max-consecutive-invalid-inspects', '4',
      '--skip-seller-name-refresh',
      '--scroll-steps', '8',
      '--min-delay-ms', '1200',
      '--max-delay-ms', '2500',
    ];
    if (keywords.length) args.push('--keywords', keywords.join('|'));
    const labelKeywords = keywords.slice(0, 3).join('、') + (keywords.length > 3 ? ` 等 ${keywords.length} 个` : '');
    const result = await enqueueTask(`抓筛选关键词：${labelKeywords}`, ['browser'], async (task) => {
      await runBrowserNodeScript('xianyu_public_review_image_scraper.cjs', args, 'discover links', task);
    });
    jsonResponse(res, result.status || 202, result);
    return;
  }

  if (url.pathname === '/api/download-images') {
    const body = await readRequestBody(req);
    const sellerIds = sanitizeSellerIds(body.sellerIds);
    let linkIds = sanitizeLinkIds(body.linkIds);
    if (sellerIds.length) {
      linkIds = [...new Set([...linkIds, ...(await allLinkIdsForSellers(sellerIds))])];
    }
    if (!linkIds.length) {
      jsonResponse(res, 400, { error: 'linkIds or sellerIds required' });
      return;
    }
    const maxLinksRaw = body.maxSellers || body.maxLinks || linkIds.length;
    const maxLinks = Math.max(1, Math.floor(Number(maxLinksRaw) || linkIds.length));
    const selectedCount = sellerIds.length || linkIds.length;
    const maxImagesRaw = body.maxImages || Math.max(500, selectedCount * 500);
    const maxImages = Math.max(1, Math.floor(Number(maxImagesRaw) || 500));
    if (maxLinks > MAX_LINKS_PER_TASK || maxImages > MAX_IMAGES_PER_TASK) {
      jsonResponse(res, 400, {
        error: `单次任务最多 ${MAX_LINKS_PER_TASK} 个卖家/link、${MAX_IMAGES_PER_TASK} 张图片；当前请求 ${maxLinks} / ${maxImages}`,
      });
      return;
    }
    const label = sellerIds.length ? `爬取图片：已选 ${sellerIds.length} 个卖家` : `爬取图片：已选 ${linkIds.length} 个 link`;
    const result = await enqueueTask(label, ['browser', 'images'], async (task) => {
      task.progressKind = 'download-images';
      task.progressTotal = Math.min(selectedCount, maxLinks);
      task.progressUnit = sellerIds.length ? '个卖家' : '个 link';
      await runBrowserNodeScript('xianyu_public_review_image_scraper.cjs', [
        '--mode', 'download-images',
        '--cdp-url=',
        '--link-ids', linkIds.join(','),
        '--max-links-per-run', String(maxLinks),
        '--max-images-per-run', String(maxImages),
        '--scroll-steps', '16',
        '--min-delay-ms', '1200',
        '--max-delay-ms', '2500',
      ], 'download images', task);
    });
    jsonResponse(res, result.status || 202, result);
    return;
  }

  if (url.pathname === '/api/refresh-seller-names') {
    const body = await readRequestBody(req);
    const maxSellers = Math.max(1, Math.min(100, Number(body.maxSellers || 30) || 30));
    const result = await enqueueTask(`补卖家名：最多 ${maxSellers} 个卖家`, ['browser'], async (task) => {
      await runBrowserNodeScript('xianyu_public_review_image_scraper.cjs', [
        '--mode', 'refresh-seller-names',
        '--cdp-url=',
        '--max-seller-names-per-run', String(maxSellers),
        '--scroll-steps', '4',
        '--min-delay-ms', '900',
        '--max-delay-ms', '1800',
      ], 'refresh seller names', task);
    });
    jsonResponse(res, result.status || 202, result);
    return;
  }

  if (url.pathname === '/api/regenerate-site') {
    const result = await enqueueTask('刷新 HTML 页面', ['browser', 'images', 'ocr', 'site'], async () => {});
    jsonResponse(res, result.status || 202, result);
    return;
  }

  if (url.pathname === '/api/ocr-uids') {
    const body = await readRequestBody(req);
    const sellerIds = sanitizeSellerIds(body.sellerIds);
    let linkIds = sanitizeLinkIds(body.linkIds);
    if (sellerIds.length) {
      linkIds = [...new Set([...linkIds, ...(await linkIdsForSellers(sellerIds))])];
    }
    const args = linkIds.length ? ['--link-ids', linkIds.join(',')] : [];
    const label = sellerIds.length ? `OCR UID：${sellerIds.length} 个卖家` : linkIds.length ? `OCR UID：${linkIds.length} 个 link` : 'OCR UID';
    const result = await enqueueTask(label, ['ocr', 'images'], async (task) => {
      task.progressKind = 'ocr-uids';
      task.progressUnit = '张';
      await runPythonScript('ocr_uid_from_images.py', args, 'ocr uid images', task);
    });
    jsonResponse(res, result.status || 202, result);
    return;
  }

  if (url.pathname === '/api/cleanup/no-uid-images') {
    const body = await readRequestBody(req);
    if (body.dryRun || body.preview) {
      jsonResponse(res, 200, await cleanupNoUidImages({ dryRun: true }));
      return;
    }
    const preview = await cleanupNoUidImages({ dryRun: true });
    const result = await enqueueTask(`清理无 UID 图片：${preview.count} 张`, ['images', 'site'], async (task) => {
      task.progressKind = 'cleanup-no-uid-images';
      task.progressTotal = preview.count;
      task.progressUnit = '张';
      const cleaned = await cleanupNoUidImages({ dryRun: false });
      task.progressDone = cleaned.count;
      appendTaskOutput(task, `Cleaned ${cleaned.count} no-UID images, released ${cleaned.mb} MB.\n`);
    });
    jsonResponse(res, result.status || 202, result);
    return;
  }

  jsonResponse(res, 404, { error: 'Not found' });
}

async function serveStatic(req, res, url) {
  let requested = decodeURIComponent(url.pathname);
  if (requested === '/') requested = '/keywords.html';
  const cleanRequest = requested.replace(/^\/+/, '');
  const root = cleanRequest.startsWith('images/') ? ROOT_DIR : SITE_DIR;
  const filePath = path.resolve(root, cleanRequest);
  if (!isPathInside(root, filePath)) {
    textResponse(res, 403, 'Forbidden');
    return;
  }
  try {
    const body = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.csv': 'text/csv; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
    };
    textResponse(res, 200, body, types[ext] || 'application/octet-stream');
  } catch (err) {
    if (err && err.code === 'ENOENT') textResponse(res, 404, 'Not found');
    else textResponse(res, 500, err.message || String(err));
  }
}

async function start() {
  await regenerateSite().catch((err) => {
    console.warn(`Initial site generation failed: ${err.message}`);
  });
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else await serveStatic(req, res, url);
    } catch (err) {
      jsonResponse(res, 500, { error: err.message || String(err) });
    }
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Dashboard: http://127.0.0.1:${PORT}/keywords.html`);
    console.log('Close this window to stop the dashboard server.');
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  module.exports = {
    filterKeywordRows,
    isPathInside,
    isRetryableBrowserFailure,
    planKeywordRelatedDeletion,
    taskProgress,
  };
}

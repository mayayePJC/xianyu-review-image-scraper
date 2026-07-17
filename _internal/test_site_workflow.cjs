#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SITE_DIR = path.resolve(__dirname, '..', 'site');

function readSiteFile(name) {
  return fs.readFileSync(path.join(SITE_DIR, name), 'utf8');
}

function count(text, pattern) {
  return (text.match(pattern) || []).length;
}

function assertNavigationOrder(page) {
  const labels = ['1 关键词', '2 卖家', '3 图片', '商品线索'];
  let previous = -1;
  for (const label of labels) {
    const current = page.indexOf(`>${label}</a>`);
    assert(current > previous, `navigation item is missing or out of order: ${label}`);
    previous = current;
  }
}

function main() {
  const keywords = readSiteFile('keywords.html');
  const sellers = readSiteFile('sellers.html');
  const images = readSiteFile('images.html');
  const links = readSiteFile('links.html');
  const index = readSiteFile('index.html');
  const appJs = readSiteFile(path.join('assets', 'app.js'));
  const appCss = readSiteFile(path.join('assets', 'app.css'));

  [keywords, sellers, images, links].forEach(assertNavigationOrder);
  [keywords, sellers, images, links].forEach((page) => {
    assert(!page.includes('workflow-strip'), 'duplicate workflow strip must not return');
  });

  assert.equal(count(keywords, /data-run-discover/g), 1, 'keywords page owns link discovery');
  assert.equal(count(keywords, /data-run-ocr(?:\s|>)/g), 0);
  assert.equal(count(keywords, /data-run-selected-sellers/g), 0);

  assert.equal(count(sellers, /data-run-selected-sellers/g), 1, 'sellers page owns image crawling');
  assert(sellers.includes('data-check-all-sellers'), 'seller selection must remain available');
  assert.equal(count(sellers, /data-run-seller="/g), 0, 'seller rows must not start tasks');
  assert.equal(count(sellers, /data-run-seller-ocr/g), 0, 'seller rows must not start OCR');
  assert.equal(count(sellers, /data-run-ocr(?:\s|>)/g), 0);

  assert.equal(count(images, /data-run-ocr(?:\s|>)/g), 1, 'images page owns OCR');
  assert.equal(count(images, /data-download-image-csv/g), 1, 'images page owns filtered CSV export');
  assert(!images.includes('清理无 UID 图片'));

  assert.equal(count(links, /type="checkbox"/g), 0, 'item leads are read-only');
  assert.equal(count(links, /data-run-/g), 0, 'item leads must not start tasks');
  assert(!links.includes('class="run-panel"'));

  assert(index.includes('url=keywords.html'), 'dashboard index must open at workflow step one');
  assert(!appJs.includes('data-run-link'));
  assert(!appJs.includes('data-run-seller-ocr'));
  assert(!appJs.includes('setupNoUidCleanupButton'));
  assert(appJs.includes('已导出当前筛选结果'), 'CSV export must report visible completion feedback');
  assert(appCss.includes('grid-template-columns: repeat(2, minmax(0, 1fr))'), 'mobile navigation must fit without horizontal overflow');
  assert(appCss.includes('max-width: 100%;\n  overflow: auto;'), 'image tables must scroll inside their group on narrow screens');

  console.log('site workflow tests passed');
}

main();

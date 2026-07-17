#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs/promises');
const path = require('path');
const { parseCsv, readCsvRows, writeCsvRows, writeFileAtomic } = require('./csv_utils.cjs');
const {
  classifyImageInspection,
  downloadImages,
  hasImagesStatus,
} = require('./xianyu_public_review_image_scraper.cjs');

const LINK_HEADERS = [
  'link_id', 'keyword', 'item_url', 'seller_url', 'review_url', 'seller_name', 'item_title', 'card_text',
  'has_images', 'total_images', 'images_downloaded', 'images_remaining', 'link_status', 'image_status',
  'last_link_crawl_at', 'last_image_crawl_at', 'notes',
];

async function testCsvSupportsQuotedNewlines() {
  const rows = parseCsv('id,notes\r\n1,"first line\r\nsecond line"\r\n2,"a ""quote"""\r\n');
  assert.deepEqual(rows, [
    { id: '1', notes: 'first line\r\nsecond line' },
    { id: '2', notes: 'a "quote"' },
  ]);
  assert.throws(() => parseCsv('id,notes\n1,"unfinished\n'), /unclosed quoted field/);
}

function testImageInspectionDistinguishesUnknownFromNoImages() {
  assert.deepEqual(classifyImageInspection('credit_reviews_not_found', 0), {
    status: 'credit_reviews_not_found', hasImages: '', totalImages: '',
  });
  assert.deepEqual(classifyImageInspection('with_pictures_not_found', 0), {
    status: 'confirmed_no_images', hasImages: 'no', totalImages: 0,
  });
  assert.deepEqual(classifyImageInspection('ok', 0), {
    status: 'review_images_collection_empty', hasImages: 'yes', totalImages: 0,
  });
  assert.equal(hasImagesStatus({ has_images: 'no', link_status: 'with_pictures_not_found' }), '', 'legacy no-image rows must be rechecked once');
  assert.equal(hasImagesStatus({ has_images: 'no', link_status: 'confirmed_no_images' }), 'no');
}

async function testReadOnlyTreatsMissingFileAsEmpty(tempRoot) {
  assert.deepEqual(await readCsvRows(path.join(tempRoot, 'missing.csv')), []);
  await assert.rejects(readCsvRows(tempRoot), (error) => error && error.code !== 'ENOENT');
}

async function testConcurrentAtomicWritesStayComplete(tempRoot) {
  const file = path.join(tempRoot, 'site', 'app.js');
  const first = 'A'.repeat(20000);
  const second = 'B'.repeat(20000);
  for (let run = 0; run < 10; run += 1) {
    await Promise.all([
      writeFileAtomic(file, first, 'utf8'),
      writeFileAtomic(file, second, 'utf8'),
    ]);
    const saved = await fs.readFile(file, 'utf8');
    assert.ok(saved === first || saved === second, 'concurrent generation must leave one complete file');
  }
  const leftovers = (await fs.readdir(path.dirname(file))).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
}

async function testOneSellerFailureDoesNotAbortBatch(tempRoot) {
  const dataDir = path.join(tempRoot, 'data');
  const runDir = path.join(tempRoot, 'run');
  await fs.mkdir(runDir, { recursive: true });
  const linkRows = [
    {
      link_id: 'item_1', keyword: 'first', seller_url: 'https://www.goofish.com/personal?userId=1',
      has_images: 'yes', total_images: '1', images_downloaded: '0', images_remaining: '1',
      link_status: 'review_images_found', image_status: 'pending', notes: '',
    },
    {
      link_id: 'item_2', keyword: 'second', seller_url: 'https://www.goofish.com/personal?userId=2',
      has_images: 'yes', total_images: '1', images_downloaded: '0', images_remaining: '1',
      link_status: 'review_images_found', image_status: 'pending', notes: '',
    },
  ];
  await writeCsvRows(path.join(dataDir, 'link_state.csv'), LINK_HEADERS, linkRows);

  const calls = [];
  const result = await downloadImages(null, {
    dataDir,
    linkIds: 'item_1,item_2',
    maxLinksPerRun: 2,
    maxImagesPerRun: 10,
  }, { runDir, imagesDownloaded: 0 }, {
    downloadImagesForLink: async (_context, row) => {
      calls.push(row.link_id);
      if (row.link_id === 'item_1') throw new Error('seller page changed unexpectedly');
      row.image_status = 'complete';
      row.images_downloaded = '1';
      row.images_remaining = '0';
      return { found: 1, downloaded: 1, status: 'complete' };
    },
  });

  assert.deepEqual(calls, ['item_1', 'item_2']);
  assert.equal(result.processedLinks, 2);
  assert.equal(result.failedLinks, 1);
  const savedRows = await readCsvRows(path.join(dataDir, 'link_state.csv'));
  assert.equal(savedRows.find((row) => row.link_id === 'item_1').image_status, 'crawl_failed');
  assert.equal(savedRows.find((row) => row.link_id === 'item_2').image_status, 'complete');
}

async function testBrowserRecoveryFailureEscalatesForProcessRetry(tempRoot) {
  const dataDir = path.join(tempRoot, 'browser-recovery-data');
  const runDir = path.join(tempRoot, 'browser-recovery-run');
  await fs.mkdir(runDir, { recursive: true });
  await writeCsvRows(path.join(dataDir, 'link_state.csv'), LINK_HEADERS, [{
    link_id: 'item_browser', seller_url: 'https://www.goofish.com/personal?userId=9',
    has_images: 'yes', total_images: '1', images_downloaded: '0', images_remaining: '1',
    link_status: 'review_images_found', image_status: 'pending', notes: '',
  }]);

  await assert.rejects(downloadImages(null, {
    dataDir,
    linkIds: 'item_browser',
    maxLinksPerRun: 1,
    maxImagesPerRun: 10,
  }, { runDir, imagesDownloaded: 0 }, {
    downloadImagesForLink: async () => {
      throw new Error('Target page, context or browser has been closed');
    },
    recoverContext: async () => {
      throw new Error('browser relaunch failed');
    },
  }), /browser relaunch failed/);
}

async function main() {
  const tempRoot = path.join(__dirname, `.tmp-data-safety-${process.pid}`);
  await fs.rm(tempRoot, { recursive: true, force: true });
  await fs.mkdir(tempRoot, { recursive: true });
  try {
    await testCsvSupportsQuotedNewlines();
    testImageInspectionDistinguishesUnknownFromNoImages();
    await testReadOnlyTreatsMissingFileAsEmpty(tempRoot);
    await testConcurrentAtomicWritesStayComplete(tempRoot);
    await testOneSellerFailureDoesNotAbortBatch(tempRoot);
    await testBrowserRecoveryFailureEscalatesForProcessRetry(tempRoot);
    console.log('data safety tests passed');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

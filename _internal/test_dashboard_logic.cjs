#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const {
  filterKeywordRows,
  isPathInside,
  isRetryableBrowserFailure,
  planKeywordRelatedDeletion,
  taskProgress,
} = require('./dashboard_server.cjs');
const { effectiveHasImages, linkProgress } = require('./generate_site.cjs');

function testProgressUsesCompletedCheckpoint() {
  const progress = taskProgress({
    progressKind: 'download-images',
    progressTotal: 178,
    progressUnit: 'sellers',
    output: [
      'TASK_PROGRESS download-images done=0 total=102',
      '== Download review images: seller_1 ==',
      'TASK_PROGRESS download-images done=1 total=102',
      '== Download review images: seller_2 ==',
      'TASK_PROGRESS download-images done=2 total=102',
    ].join('\n'),
  });
  assert.deepEqual(progress, {
    kind: 'download-images',
    done: 2,
    total: 102,
    remaining: 100,
    unit: 'sellers',
  });
}

function testOcrProgressUsesPythonCheckpoint() {
  const progress = taskProgress({
    progressKind: 'ocr-uids',
    progressUnit: 'images',
    output: 'TASK_PROGRESS ocr-uids done=25 total=137',
  });
  assert.deepEqual(progress, {
    kind: 'ocr-uids', done: 25, total: 137, remaining: 112, unit: 'images',
  });
}

function testBrowserRetryClassification() {
  assert.equal(isRetryableBrowserFailure({ output: 'browserContext.newPage: Target page, context or browser has been closed' }), true);
  assert.equal(isRetryableBrowserFailure({ output: 'Protocol error (Target.createTarget): Failed to open a new tab' }), true);
  assert.equal(isRetryableBrowserFailure({ output: 'CSV permission denied' }), false);
}

function testKeywordFilterCannotMixTypes() {
  const rows = [
    { keyword: 'keyword-alpha', keyword_type: 'category-a', game_name: 'sample-game' },
    { keyword: 'keyword-beta', keyword_type: 'category-b', game_name: 'sample-game' },
  ];
  const filtered = filterKeywordRows(rows, 'category-a', 'sample-game', ['keyword-alpha', 'keyword-beta']);
  assert.deepEqual(filtered, ['keyword-alpha']);
}

function testKeywordDeletionPreservesSharedSellerImages() {
  const sellerOne = 'https://www.goofish.com/personal?userId=1';
  const sellerTwo = 'https://www.goofish.com/personal?userId=2';
  const links = [
    { link_id: 'old_1', keyword: 'delete-me', seller_url: sellerOne, review_url: sellerOne },
    { link_id: 'keep_1', keyword: 'keep-me', seller_url: sellerOne, review_url: sellerOne },
    { link_id: 'old_2', keyword: 'delete-me', seller_url: sellerTwo, review_url: sellerTwo },
  ];
  const images = [
    { image_id: 'shared', seller_id: 'seller_1', link_id: 'old_1', keyword: 'delete-me', seller_url: sellerOne },
    { image_id: 'exclusive', seller_id: 'seller_2', link_id: 'other_old_id', keyword: 'stale-keyword', seller_url: sellerTwo },
    { image_id: 'unrelated', seller_id: 'seller_3', link_id: 'keep_3', keyword: 'keep-me' },
  ];

  const plan = planKeywordRelatedDeletion('delete-me', links, images);

  assert.equal(plan.deletedLinks.length, 2);
  assert.deepEqual(plan.deletedImages.map((row) => row.image_id), ['exclusive']);
  assert.equal(plan.rehomedImages, 1);
  const shared = plan.keptImages.find((row) => row.image_id === 'shared');
  assert.equal(shared.link_id, 'keep_1');
  assert.equal(shared.keyword, 'keep-me');
}

function testPathContainmentDoesNotAcceptSiblingPrefix() {
  const root = path.resolve('E:\\workspace\\project');
  assert.equal(isPathInside(root, path.join(root, 'images', 'one.jpg')), true);
  assert.equal(isPathInside(root, path.resolve('E:\\workspace\\project-private\\secret.txt')), false);
  assert.equal(isPathInside(root, path.resolve(root, '..', 'secret.txt')), false);
}

function testDownloadedCountCannotExceedProgressTotal() {
  const progress = linkProgress({
    total_images: '45',
    images_downloaded: '54',
    images_remaining: '0',
  }, []);
  assert.equal(progress.downloaded, 54);
  assert.equal(progress.total, 54);
  assert.equal(progress.remaining, 0);
}

function testLegacyNoImageRowsAreShownAsUnknownUntilRechecked() {
  assert.equal(effectiveHasImages({ has_images: 'no', link_status: 'with_pictures_not_found', image_status: 'skipped_no_images' }), 'unknown');
  assert.equal(effectiveHasImages({ has_images: 'no', link_status: 'confirmed_no_images', image_status: 'skipped_no_images' }), 'no');
}

function main() {
  testProgressUsesCompletedCheckpoint();
  testOcrProgressUsesPythonCheckpoint();
  testBrowserRetryClassification();
  testKeywordFilterCannotMixTypes();
  testKeywordDeletionPreservesSharedSellerImages();
  testPathContainmentDoesNotAcceptSiblingPrefix();
  testDownloadedCountCannotExceedProgressTotal();
  testLegacyNoImageRowsAreShownAsUnknownUntilRechecked();
  console.log('dashboard logic tests passed');
}

main();

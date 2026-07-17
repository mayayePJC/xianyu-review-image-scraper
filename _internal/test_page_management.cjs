#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { clickTextLike, closeAllOpenPages, newManagedPage, releaseManagedPage } = require('./xianyu_public_review_image_scraper.cjs');

class FakePage {
  constructor(name, evaluateResults = []) {
    this.name = name;
    this.evaluateResults = [...evaluateResults];
    this.closed = false;
    this.urlValue = 'about:blank';
    this.keyboard = { press: async () => {} };
  }

  isClosed() {
    return this.closed;
  }

  async close() {
    this.closed = true;
  }

  async evaluate() {
    const result = this.evaluateResults.length ? this.evaluateResults.shift() : false;
    if (result === 'clicked' && this.onClick) this.onClick();
    return result;
  }

  async waitForLoadState() {}

  async goto(url) {
    this.urlValue = url;
  }
}

class FakeContext {
  constructor(pages) {
    this._pages = pages;
    this.newPageCalls = 0;
    this.failNextNewPage = false;
  }

  pages() {
    return this._pages;
  }

  async newPage() {
    this.newPageCalls += 1;
    if (this.failNextNewPage) {
      this.failNextNewPage = false;
      throw new Error('Target.createTarget: Failed to open a new tab');
    }
    const page = new FakePage(`new-${this.newPageCalls}`);
    this._pages.push(page);
    return page;
  }
}

async function testClickKeepsSearchPageWhenNewTabOpens() {
  const searchPage = new FakePage('search');
  const itemPage = new FakePage('item', [false, 'clicked', false]);
  const reviewPage = new FakePage('review', [false]);
  const context = new FakeContext([searchPage, itemPage]);
  itemPage.onClick = () => context._pages.push(reviewPage);

  const result = await clickTextLike(
    context,
    itemPage,
    'anything',
    'fake click',
    { maxOpenPages: 2, minDelayMs: 0, maxDelayMs: 0 },
  );

  assert.equal(result.page, reviewPage);
  assert.equal(searchPage.isClosed(), false, 'search page must stay open for the next keyword');
  assert.equal(reviewPage.isClosed(), false, 'new review page must stay open');
  assert.equal(itemPage.isClosed(), true, 'old item page can close to respect maxOpenPages=2');
}

async function testNewManagedPageRetriesAfterCreateTargetFailure() {
  const oldPage = new FakePage('old');
  const context = new FakeContext([oldPage]);
  context.failNextNewPage = true;

  const page = await newManagedPage(context, { maxOpenPages: 2, minDelayMs: 0, maxDelayMs: 0 }, [oldPage]);

  assert.equal(context.newPageCalls, 2, 'newManagedPage should retry once after a tab creation failure');
  assert.equal(page.isClosed(), false, 'retried page should stay open');
  assert.equal(oldPage.isClosed(), false, 'kept page should stay open');
}

async function testOnePageLimitReusesInsteadOfOpeningSecondPage() {
  const existingPage = new FakePage('existing');
  const context = new FakeContext([existingPage]);

  const page = await newManagedPage(context, { maxOpenPages: 1, minDelayMs: 0, maxDelayMs: 0 }, [existingPage]);

  assert.equal(page, existingPage, 'the only page should be reused when the limit is one');
  assert.equal(context.newPageCalls, 0, 'no second page should be opened');
  assert.equal(context.pages().filter((item) => !item.isClosed()).length, 1);
}

async function testCloseAllOpenPagesCanKeepReusablePage() {
  const first = new FakePage('first');
  const second = new FakePage('second');
  const context = new FakeContext([first, second]);

  const closed = await closeAllOpenPages(context, 'fake pages', 1);

  assert.equal(closed, 1);
  assert.equal(first.isClosed(), true, 'oldest restored page should close');
  assert.equal(second.isClosed(), false, 'newest restored page should stay available for reuse');
}

async function testReleaseManagedPageKeepsLastPageAlive() {
  const page = new FakePage('only-page');
  const context = new FakeContext([page]);

  await releaseManagedPage(context, page, { maxOpenPages: 2 });

  assert.equal(page.isClosed(), false, 'last page must stay open so the browser context stays alive');
  assert.equal(page.urlValue, 'about:blank', 'last page should be reset to a blank reusable page');
}

async function testReleaseManagedPageClosesPageWhenAnotherPageExists() {
  const keepPage = new FakePage('keep');
  const page = new FakePage('temporary');
  const context = new FakeContext([keepPage, page]);

  await releaseManagedPage(context, page, { maxOpenPages: 2 });

  assert.equal(keepPage.isClosed(), false);
  assert.equal(page.isClosed(), true, 'temporary page should close when another page can keep the context alive');
}

async function main() {
  await testClickKeepsSearchPageWhenNewTabOpens();
  await testNewManagedPageRetriesAfterCreateTargetFailure();
  await testOnePageLimitReusesInsteadOfOpeningSecondPage();
  await testCloseAllOpenPagesCanKeepReusablePage();
  await testReleaseManagedPageKeepsLastPageAlive();
  await testReleaseManagedPageClosesPageWhenAnotherPageExists();
  console.log('page management tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

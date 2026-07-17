# Xianyu Review Image Scraper

A local crawler and dashboard for collecting public Xianyu/Goofish item links, seller review images, and optional UID-style numeric text from downloaded images.

This repository contains only the crawler source code and safe example configuration. Runtime data, downloaded images, browser profiles, logs, generated HTML, and private keyword/URL config files are intentionally ignored.

## Features

- Discover public item/seller links from keyword searches.
- Inspect seller review pages and record whether review images exist.
- Download review images into local folders.
- Generate a local HTML dashboard for sellers, item leads, images, and keywords.
- Run optional local OCR over downloaded images and export UID results.
- Checkpoint link, image, and OCR state during long tasks so a later run can resume saved work.

## Setup

1. Install Node.js 18 or newer.
2. Install dependencies:

```bash
cd _internal
npm install
```

3. Create local config files from the examples:

```bash
copy ..\config\xianyu_keywords.example.txt ..\config\xianyu_keywords.txt
copy ..\config\xianyu_item_urls.example.txt ..\config\xianyu_item_urls.txt
```

4. Edit the local config files with your own keywords or public item URLs.
5. Optional: copy `config/xianyu_local_defaults.example.json` to `config/xianyu_local_defaults.json` to set private local defaults for new keywords.

## Usage

On Windows, double-click:

- `01_discover_links.bat` to discover links from keywords.
- `02_download_review_images.bat` to download review images.
- `03_generate_html_site.bat` to generate the local static HTML site.
- `04_start_dashboard.bat` to start the local dashboard server.
- `05_ocr_uid_images.bat` to run OCR over downloaded images.

You can also run the scripts directly from `_internal`:

```bash
npm run discover:links
npm run download:images
npm run site
npm run dashboard
```

The dashboard is served at `http://127.0.0.1:8788/`. The primary workflow is keywords, sellers, then images; the item-leads page is read-only detail. Browser work is sequential and keeps at most two crawler pages open. A single seller failure is recorded and does not discard the rest of the batch.

Only `confirmed_no_images` records are skipped permanently. Older or failed inspections are treated as unknown and checked again when selected, preventing a missing/changed page control from becoming a false no-image result.

Run the local regression suite after changes:

```bash
cd _internal
npm test
```

## Data Safety

The following paths are local-only and are not committed:

- `data/`
- `images/`
- `logs/`
- `site/`
- `browser_profile/`
- `config/xianyu_keywords.txt`
- `config/xianyu_item_urls.txt`

Keep OCR calibration samples and manually verified private data out of public commits.
If you need private OCR calibration locally, create `config/ocr_uid_calibration.local.json` or `_internal/ocr_uid_calibration.local.json`; both paths are ignored by Git.

## Responsible Use

Use this tool only for public pages you are allowed to access. Respect platform terms, rate limits, robots guidance where applicable, and local laws.

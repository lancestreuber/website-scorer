#!/usr/bin/env node
'use strict';

const path   = require('path');
const fs     = require('fs');
const { parse }     = require('csv-parse');
const { stringify } = require('csv-stringify');

// Load .env — check two levels up (Pi: workspace/keys/.env) then local ./keys/.env
const ENV_PATH_DEPLOY = path.join(__dirname, '..', '..', 'keys', '.env');
const ENV_PATH_LOCAL  = path.join(__dirname, 'keys', '.env');
const ENV_PATH = fs.existsSync(ENV_PATH_DEPLOY) ? ENV_PATH_DEPLOY : ENV_PATH_LOCAL;
require('dotenv').config({ path: ENV_PATH });

const pLimit           = require('p-limit');
const { extractSignals } = require('./extractors');
const { fetchPageSpeed } = require('./pagespeed');
const { generateAssessment } = require('./assessment');
const config           = require('./signals.config');

// ─── CLI argument parsing ──────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--errors-only') { args.errorsOnly = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      args[key] = argv[i + 1] || true;
      i++;
    }
  }
  return args;
}

function usage() {
  console.error([
    'Usage: node pipeline.js --csv <path> --out <path> [options]',
    '',
    'Required:',
    '  --csv <path>         Absolute path to input CSV',
    '  --out <path>         Absolute path for output CSV',
    '',
    'Optional:',
    '  --url-col <name>     Column name containing URLs (default: auto-detect)',
    '  --concurrency <n>    Parallel workers, 1-10 (default: 5)',
    '  --errors-only        Re-process only rows where band=error',
  ].join('\n'));
}

const args = parseArgs(process.argv);

if (!args.csv || !args.out) {
  usage();
  process.exit(1);
}

if (!process.env.PAGESPEED_API_KEY || process.env.PAGESPEED_API_KEY === 'YOUR_KEY_HERE') {
  console.error(`[ERROR] PAGESPEED_API_KEY not set. Add it to ${ENV_PATH}`);
  process.exit(1);
}

const INPUT_CSV    = args.csv;
const OUTPUT_CSV   = args.out;
const URL_COL_ARG  = args['url-col'] || null;
const ERRORS_ONLY  = args.errorsOnly || false;
const CONCURRENCY  = Math.min(10, Math.max(1, parseInt(args.concurrency || '5', 10)));

// Auto-detect URL column names
const URL_COL_CANDIDATES = ['website', 'url', 'domain', 'web', 'website url', 'site', 'homepage'];

// ─── Output columns appended to original row ───────────────────────────────────

const NEW_COLUMNS = [
  'score', 'intent_score', 'band', 'disqualify_reason',
  'ssl_valid', 'is_https', 'word_count',
  'has_analytics', 'has_schema', 'has_sitemap', 'has_llms_txt',
  'pagespeed_performance', 'pagespeed_accessibility', 'pagespeed_seo', 'pagespeed_best_practices',
  'pagespeed_lcp', 'pagespeed_error',
  'signals_fired', 'intent_signals_fired', 'assessment',
];

// ─── Scoring logic ─────────────────────────────────────────────────────────────

function computeQualityScore(signals, pageSpeedData) {
  let score = 0;
  const fired = [];

  function check(signalKey, configKey) {
    if (signals[signalKey] === true) {
      score += config.quality[configKey] || 0;
      fired.push(configKey);
    }
  }

  check('http_only',           'http_only');
  check('no_ssl',              'no_ssl');
  check('no_schema',           'no_schema');
  check('no_sitemap',          'no_sitemap');
  check('low_word_count',      'low_word_count');
  check('no_meta_description', 'no_meta_description');
  check('no_contact_info',     'no_contact_info');
  check('slow_response',       'slow_response');
  check('no_og_tags',          'no_og_tags');
  check('old_copyright',       'old_copyright');
  check('no_viewport',         'no_viewport');
  check('missing_hsts',        'missing_hsts');
  check('missing_csp',         'missing_csp');
  check('multiple_h1',         'multiple_h1');
  check('no_h1',               'no_h1');
  check('images_missing_alt_flag', 'images_missing_alt');
  check('excessive_redirects', 'excessive_redirects');
  check('old_jquery',          'old_jquery');

  // PageSpeed-derived signals
  if (pageSpeedData && pageSpeedData.pagespeed_error === null) {
    const ps = config.pagespeed;
    if (pageSpeedData.pagespeed_performance != null && pageSpeedData.pagespeed_performance < ps.perf_low_threshold) {
      score += config.quality.pagespeed_perf_low;
      fired.push('pagespeed_perf_low');
      signals.pagespeed_perf_low = true;
    }
    if (pageSpeedData.pagespeed_accessibility != null && pageSpeedData.pagespeed_accessibility < ps.a11y_low_threshold) {
      score += config.quality.pagespeed_a11y_low;
      fired.push('pagespeed_a11y_low');
      signals.pagespeed_a11y_low = true;
    }
    if (pageSpeedData.pagespeed_seo != null && pageSpeedData.pagespeed_seo < ps.seo_low_threshold) {
      score += config.quality.pagespeed_seo_low;
      fired.push('pagespeed_seo_low');
      signals.pagespeed_seo_low = true;
    }
    if (pageSpeedData.pagespeed_best_practices != null && pageSpeedData.pagespeed_best_practices < ps.bp_low_threshold) {
      score += config.quality.pagespeed_bp_low;
      fired.push('pagespeed_bp_low');
      signals.pagespeed_bp_low = true;
    }
  }

  return { score, fired };
}

function computeIntentScore(signals) {
  let intentScore = 0;
  const fired = [];

  function check(signalKey, configKey) {
    if (signals[signalKey] === true) {
      intentScore += config.intent[configKey] || 0;
      fired.push(configKey);
    }
  }

  check('has_any_analytics',        'has_any_analytics');
  check('has_ad_tracking',          'has_ad_tracking');
  check('has_contact_form',         'has_contact_form');
  check('has_facebook_pixel',       'has_facebook_pixel');
  check('broken_sitemap',           'broken_sitemap');
  check('has_social_links',         'has_social_links');
  check('partial_og_tags',          'partial_og_tags');
  check('has_broken_schema',        'has_broken_schema');
  check('stale_blog',               'stale_blog');
  check('meta_description_too_long','meta_description_too_long');
  check('has_google_fonts',         'has_google_fonts');
  check('no_llms_txt',              'no_llms_txt');

  return { intentScore, fired };
}

function determineBand(score, intentScore) {
  const t = config.thresholds;
  if (score >= t.hot.minScore && intentScore >= t.hot.minIntent) return 'hot';
  if (score >= t.warm.minScore || intentScore >= 15) return 'warm';
  return 'cold';
}

// ─── CSV helpers ───────────────────────────────────────────────────────────────

function detectUrlColumn(headers) {
  if (URL_COL_ARG) {
    if (headers.includes(URL_COL_ARG)) return URL_COL_ARG;
    console.error(`[ERROR] Column "${URL_COL_ARG}" not found. Available: ${headers.join(', ')}`);
    process.exit(1);
  }
  for (const candidate of URL_COL_CANDIDATES) {
    const match = headers.find(h => h.toLowerCase() === candidate.toLowerCase());
    if (match) return match;
  }
  console.error(`[ERROR] Could not auto-detect URL column. Available columns: ${headers.join(', ')}`);
  console.error(`Use --url-col <column-name> to specify it.`);
  process.exit(1);
}

function normalizeUrl(raw) {
  if (!raw || !raw.trim()) return null;
  let u = raw.trim();
  if (!u.startsWith('http://') && !u.startsWith('https://')) {
    u = 'https://' + u;
  }
  try {
    const parsed = new URL(u);
    return parsed.href;
  } catch (_) {
    return null;
  }
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (_) {
    return url;
  }
}

// ─── Logging ───────────────────────────────────────────────────────────────────

let logStream = null;

function initLog() {
  const logsDir = path.join(__dirname, '..', '..', 'data', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(logsDir, `run_${ts}.log`);
  logStream = fs.createWriteStream(logPath, { flags: 'a' });
  return logPath;
}

function log(msg) {
  if (logStream) logStream.write(msg + '\n');
}

function closeLog() {
  if (logStream) { logStream.end(); logStream = null; }
}

// ─── Row processing ────────────────────────────────────────────────────────────

function buildOutputRow(original, overrides) {
  const row = Object.assign({}, original);
  // Set all new columns to empty string by default
  for (const col of NEW_COLUMNS) row[col] = '';
  return Object.assign(row, overrides);
}

async function processRow(row, urlCol, index, total) {
  const rawUrl = row[urlCol] || '';
  const normalizedUrl = normalizeUrl(rawUrl);
  const domain = normalizedUrl ? extractDomain(normalizedUrl) : rawUrl || '(empty)';

  if (!normalizedUrl) {
    const out = buildOutputRow(row, {
      score: 0, intent_score: 0, band: 'error',
      disqualify_reason: 'invalid_url',
    });
    console.log(`[PROGRESS] ${index}/${total} · ${domain} · error (http_status=invalid_url)`);
    log(`[PROGRESS] ${index}/${total} · ${domain} · error (http_status=invalid_url)`);
    return out;
  }

  let signals = {};
  let disqualify_reason = null;
  let pageSpeedData = null;
  let httpStatus = null;

  try {
    // Stages 1–3
    const result = await extractSignals(normalizedUrl);
    signals           = result.signals;
    disqualify_reason = result.disqualify_reason;
    httpStatus        = result.httpStatus;

    log(`[SIGNALS] ${domain} · ${JSON.stringify(signals)}`);

    if (disqualify_reason) {
      const out = buildOutputRow(row, {
        score: 0, intent_score: 0, band: 'disqualified',
        disqualify_reason,
        ssl_valid: String(signals.ssl_valid || false),
        is_https:  String(signals.is_https  || false),
      });
      console.log(`[PROGRESS] ${index}/${total} · ${domain} · disqualified (reason=${disqualify_reason})`);
      log(`[PROGRESS] ${index}/${total} · ${domain} · disqualified (reason=${disqualify_reason})`);
      return out;
    }

    // Stage 4 — PageSpeed (with 429 retry)
    pageSpeedData = await fetchPageSpeed(normalizedUrl);
    if (pageSpeedData.pagespeed_error === 'quota_exceeded_429') {
      log(`[WARN] ${domain} · PageSpeed 429 quota exceeded, waiting 60s then retrying`);
      await new Promise(r => setTimeout(r, 60000));
      pageSpeedData = await fetchPageSpeed(normalizedUrl);
    }

    log(`[PAGESPEED] ${domain} · ${JSON.stringify(pageSpeedData)}`);

    // Compute scores
    const { score, fired: qualityFired } = computeQualityScore(signals, pageSpeedData);
    const { intentScore, fired: intentFired } = computeIntentScore(signals);
    const band = determineBand(score, intentScore);
    const assessment = generateAssessment(signals, score, intentScore, band, pageSpeedData);

    const out = buildOutputRow(row, {
      score,
      intent_score: intentScore,
      band,
      disqualify_reason: '',
      ssl_valid:   String(signals.ssl_valid  || false),
      is_https:    String(signals.is_https   || false),
      word_count:  signals.word_count != null ? String(signals.word_count) : '',
      has_analytics: String(signals.has_any_analytics || false),
      has_schema:    String(signals.has_schema        || false),
      has_sitemap:   String(signals.has_sitemap       || false),
      has_llms_txt:  String(signals.has_llms_txt      || false),
      pagespeed_performance:    pageSpeedData.pagespeed_performance    != null ? String(pageSpeedData.pagespeed_performance)    : '',
      pagespeed_accessibility:  pageSpeedData.pagespeed_accessibility  != null ? String(pageSpeedData.pagespeed_accessibility)  : '',
      pagespeed_seo:            pageSpeedData.pagespeed_seo            != null ? String(pageSpeedData.pagespeed_seo)            : '',
      pagespeed_best_practices: pageSpeedData.pagespeed_best_practices != null ? String(pageSpeedData.pagespeed_best_practices) : '',
      pagespeed_lcp:            pageSpeedData.pagespeed_lcp            != null ? String(pageSpeedData.pagespeed_lcp)            : '',
      pagespeed_error:          pageSpeedData.pagespeed_error          || '',
      signals_fired:       qualityFired.join('|'),
      intent_signals_fired: intentFired.join('|'),
      assessment,
    });

    console.log(`[PROGRESS] ${index}/${total} · ${domain} · ${band} (score=${score}, intent=${intentScore})`);
    log(`[PROGRESS] ${index}/${total} · ${domain} · ${band} (score=${score}, intent=${intentScore})`);
    return out;

  } catch (err) {
    const statusStr = err.httpStatus != null ? String(err.httpStatus) : (err.message || 'unknown');
    const out = buildOutputRow(row, {
      score: 0, intent_score: 0, band: 'error',
      disqualify_reason: '',
      pagespeed_error: err.message || 'unknown',
    });
    console.log(`[PROGRESS] ${index}/${total} · ${domain} · error (http_status=${statusStr})`);
    log(`[ERROR] ${index}/${total} · ${domain} · ${err.stack || err.message}`);
    return out;
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  // Ensure output directory exists
  const outDir = path.dirname(OUTPUT_CSV);
  fs.mkdirSync(outDir, { recursive: true });

  initLog();

  // Read CSV
  let rows;
  try {
    const csvText = fs.readFileSync(INPUT_CSV, 'utf8');
    rows = await new Promise((resolve, reject) => {
      parse(csvText, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      }, (err, data) => {
        if (err) reject(err); else resolve(data);
      });
    });
  } catch (err) {
    if (err.message && err.message.includes('No such file')) {
      console.error(`[ERROR] Input CSV not found: ${INPUT_CSV}`);
      process.exit(1);
    }
    // /dev/null or empty file — emit usage-friendly error for smoke test
    console.error(`[ERROR] Could not parse CSV: ${err.message}`);
    process.exit(1);
  }

  if (!rows || rows.length === 0) {
    console.error('[ERROR] CSV is empty or has no data rows.');
    process.exit(1);
  }

  const headers = Object.keys(rows[0]);
  const urlCol  = detectUrlColumn(headers);

  // Filter rows if --errors-only
  let workRows = rows;
  if (ERRORS_ONLY) {
    workRows = rows.filter(r => r.band === 'error');
    if (workRows.length === 0) {
      console.log('[SUMMARY] No error rows found. Nothing to process.');
      closeLog();
      return;
    }
  }

  const total = workRows.length;
  console.log(`[START] Website Scorer · ${total} domains · concurrency=${CONCURRENCY}`);
  log(`[START] ${new Date().toISOString()} · ${total} domains · concurrency=${CONCURRENCY} · input=${INPUT_CSV}`);

  // Prepare output streamer
  const outStream  = fs.createWriteStream(OUTPUT_CSV);
  const allColumns = [...headers, ...NEW_COLUMNS.filter(c => !headers.includes(c))];
  const stringifier = stringify({ header: true, columns: allColumns });
  stringifier.pipe(outStream);

  const limit = pLimit(CONCURRENCY);
  let i = 0;
  const counters = { disqualified: 0, hot: 0, warm: 0, cold: 0, error: 0 };

  const tasks = workRows.map(row => limit(async () => {
    i++;
    const result = await processRow(row, urlCol, i, total);
    const band = result.band;
    if (band === 'disqualified') counters.disqualified++;
    else if (band === 'hot')     counters.hot++;
    else if (band === 'warm')    counters.warm++;
    else if (band === 'cold')    counters.cold++;
    else                         counters.error++;

    stringifier.write(result);
  }));

  await Promise.all(tasks);

  stringifier.end();
  await new Promise(resolve => outStream.on('finish', resolve));

  const elapsed = Date.now() - startTime;
  const mins  = Math.floor(elapsed / 60000);
  const secs  = Math.floor((elapsed % 60000) / 1000);
  const dur   = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  console.log(`[SUMMARY] Done in ${dur} · ${counters.disqualified} disqualified · ${counters.hot} hot · ${counters.warm} warm · ${counters.cold} cold · ${counters.error} errors`);
  console.log(`[OUTPUT] ${path.resolve(OUTPUT_CSV)}`);

  log(`[SUMMARY] Done in ${dur} · ${JSON.stringify(counters)}`);
  closeLog();
}

main().catch(err => {
  console.error('[FATAL]', err.message || err);
  closeLog();
  process.exit(1);
});

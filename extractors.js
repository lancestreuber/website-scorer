'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { getRandomUA } = require('./useragents');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jitterDelay(minMs = 1500, maxMs = 3500) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildHeaders() {
  return {
    'User-Agent': getRandomUA(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Upgrade-Insecure-Requests': '1',
  };
}

async function fetchUrl(url, timeoutMs = 12000) {
  const start = Date.now();
  const response = await axios.get(url, {
    timeout: timeoutMs,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: buildHeaders(),
    // track redirects
    beforeRedirect: (options, { headers }) => {
      // axios follows automatically; we rely on response.request for final URL
    },
  });
  const elapsed = Date.now() - start;
  return { response, elapsed };
}

// ─── Stage 1: Hard disqualification ───────────────────────────────────────────

const ECOMMERCE_PATTERNS = [
  { test: (b) => /cdn\.shopify\.com|myshopify\.com/i.test(b),                reason: 'shopify_detected' },
  { test: (b) => /woocommerce/i.test(b),                                       reason: 'woocommerce_detected' },
  { test: (b) => /bigcommerce/i.test(b),                                       reason: 'bigcommerce_detected' },
  { test: (b) => /squarespace\.com\/commerce|"commerce".*squarespace|squarespace.*"commerce"/i.test(b), reason: 'squarespace_commerce' },
  { test: (b) => /magento/i.test(b),                                           reason: 'magento_detected' },
  { test: (b) => /wix\.com/i.test(b) && /(\/store|addtocart|cart)/i.test(b),   reason: 'wix_commerce' },
  { test: (b) => /ecwid/i.test(b),                                             reason: 'ecwid_detected' },
  { test: (b) => /prestashop/i.test(b),                                        reason: 'prestashop_detected' },
];

const AUTH_PATTERNS = [
  { test: (b) => /<input[^>]+type=["']password["']/i.test(b),                  reason: 'login_form_present' },
  { test: (b) => /href=["'][^"']*\/(login|signin|sign-in|my-account|account\/login|wp-login)/i.test(b), reason: 'auth_links_detected' },
  { test: (b) => /href=["'][^"']*\/wp-admin/i.test(b),                         reason: 'wordpress_admin' },
  { test: (b) => /member\s+login|member\s+portal|client\s+login|staff\s+login/i.test(b), reason: 'member_portal_detected' },
];

const CART_PATTERNS = [
  { test: (b) => /class=["'][^"']*(?:add-to-cart|shopping-cart|cart-icon|minicart)/i.test(b) ||
                  /id=["'][^"']*(?:add-to-cart|shopping-cart|cart-icon|minicart)/i.test(b),  reason: 'cart_detected' },
  { test: (b) => /href=["'][^"']*\/(cart|checkout|basket|bag)["'>/]/i.test(b),               reason: 'checkout_detected' },
  { test: (b) => /add to cart|buy now|add to bag/i.test(b),                                   reason: 'buy_button_detected' },
];

function checkDisqualifiers(body) {
  for (const p of ECOMMERCE_PATTERNS) {
    if (p.test(body)) return p.reason;
  }
  for (const p of AUTH_PATTERNS) {
    if (p.test(body)) return p.reason;
  }
  for (const p of CART_PATTERNS) {
    if (p.test(body)) return p.reason;
  }
  return null;
}

// ─── Stage 2: Infrastructure signals ──────────────────────────────────────────

function extractInfrastructure(httpsResult, httpResult, redirectChain) {
  const { response: httpsResp, elapsed: httpsElapsed, sslError } = httpsResult;
  const finalResp = httpsResp || httpResult.response;

  const is_https = finalResp
    ? (finalResp.request && finalResp.request.protocol === 'https:') ||
      (finalResp.config && finalResp.config.url && finalResp.config.url.startsWith('https'))
    : false;

  const http_only = !httpsResp || sslError;
  const ssl_valid = httpsResp && !sslError;

  const ttfb_ms = httpsElapsed || (httpResult && httpResult.elapsed) || null;
  const slow_response = ttfb_ms !== null && ttfb_ms > 3000;

  const redirect_count = redirectChain ? redirectChain.length : 0;
  const excessive_redirects = redirect_count > 2;

  const headers = finalResp ? finalResp.headers : {};
  const missing_hsts  = !headers['strict-transport-security'];
  const missing_csp   = !headers['content-security-policy'];
  const missing_x_frame = !headers['x-frame-options'];
  const server_header = headers['server'] || null;

  return {
    ssl_valid,
    is_https,
    http_only,
    no_ssl: !ssl_valid,
    ttfb_ms,
    slow_response,
    redirect_count,
    excessive_redirects,
    response_headers: headers,
    missing_hsts,
    missing_csp,
    missing_x_frame,
    server_header,
  };
}

// ─── Stage 3: HTML content signals (Cheerio) ──────────────────────────────────

const PHONE_REGEX = /(\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4})/;
const ADDRESS_KEYWORDS = /\b(?:street|st\b|avenue|ave\b|boulevard|blvd|suite|ste\b|road|rd\b|drive|dr\b|lane|ln\b|court|ct\b|highway|hwy)\b/i;
const SOCIAL_DOMAINS = ['facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com', 'youtube.com', 'tiktok.com'];
const COPYRIGHT_REGEX = /©\s*(\d{4})|[Cc]opyright\s+(\d{4})/g;
const STALE_DATE_REGEX = /\b(20\d{2})\b/g;

function extractVersion(url, packageName) {
  if (!url) return null;
  const m = url.match(new RegExp(packageName + '[/-]([\\d.]+)', 'i'));
  return m ? m[1] : null;
}

function compareVersion(version, threshold) {
  if (!version) return false;
  const parts = version.split('.').map(Number);
  const threshParts = threshold.split('.').map(Number);
  for (let i = 0; i < threshParts.length; i++) {
    if ((parts[i] || 0) < threshParts[i]) return true;
    if ((parts[i] || 0) > threshParts[i]) return false;
  }
  return false;
}

function extractHtmlSignals(body, html) {
  const $ = cheerio.load(html);
  const signals = {};
  const currentYear = new Date().getFullYear();

  // ── Content ──────────────────────────────────────────────────────────────────
  const visibleText = $.root().text().replace(/\s+/g, ' ').trim();
  signals.word_count = visibleText.split(/\s+/).filter(Boolean).length;
  signals.low_word_count = signals.word_count < 300;
  signals.very_low_word_count = signals.word_count < 100;

  // ── Meta & SEO ────────────────────────────────────────────────────────────────
  const titleEl = $('title');
  signals.has_title = titleEl.length > 0 && titleEl.text().trim().length > 0;
  signals.title_text = titleEl.text().trim() || null;

  const metaDesc = $('meta[name="description"]');
  signals.has_meta_description = metaDesc.length > 0 && (metaDesc.attr('content') || '').trim().length > 0;
  signals.meta_description_text = metaDesc.attr('content') || null;
  signals.meta_description_length = signals.meta_description_text ? signals.meta_description_text.length : 0;
  signals.meta_description_too_long = signals.meta_description_length > 160;
  signals.no_meta_description = !signals.has_meta_description;

  const ogTitle = $('meta[property="og:title"]');
  const ogDesc  = $('meta[property="og:description"]');
  const ogImage = $('meta[property="og:image"]');
  signals.has_og_title       = ogTitle.length > 0;
  signals.has_og_description = ogDesc.length > 0;
  signals.has_og_image       = ogImage.length > 0;
  signals.has_og_tags        = signals.has_og_title && signals.has_og_description && signals.has_og_image;
  signals.partial_og_tags    = (signals.has_og_title || signals.has_og_description || signals.has_og_image) && !signals.has_og_tags;
  signals.no_og_tags         = !signals.has_og_tags;

  signals.has_canonical = $('link[rel="canonical"]').length > 0;
  signals.has_viewport  = $('meta[name="viewport"]').length > 0;
  signals.no_viewport   = !signals.has_viewport;

  // ── Structured data ───────────────────────────────────────────────────────────
  const schemaScripts = $('script[type="application/ld+json"]');
  signals.has_schema_json = schemaScripts.length > 0;

  let schema_json_valid = false;
  if (signals.has_schema_json) {
    schemaScripts.each((_, el) => {
      try { JSON.parse($(el).html() || ''); schema_json_valid = true; } catch (_) {}
    });
  }
  signals.schema_json_valid = schema_json_valid;
  signals.has_schema_microdata = $('[itemscope],[itemtype]').length > 0;
  signals.has_schema = signals.has_schema_json || signals.has_schema_microdata;
  signals.no_schema = !signals.has_schema;
  signals.has_broken_schema = signals.has_schema_json && !signals.schema_json_valid;

  // ── Contact ───────────────────────────────────────────────────────────────────
  signals.has_phone = PHONE_REGEX.test(visibleText);

  const addressTagPresent = $('address').length > 0;
  const addressKeywordPresent = ADDRESS_KEYWORDS.test(visibleText) && /\d/.test(visibleText);
  signals.has_address = addressTagPresent || addressKeywordPresent;
  signals.has_contact_info = signals.has_phone || signals.has_address;
  signals.no_contact_info = !signals.has_contact_info;

  // Contact form: <form> with non-password text/email inputs
  let hasContactForm = false;
  $('form').each((_, form) => {
    const inputs = $(form).find('input[type="text"],input[type="email"],input:not([type]),textarea');
    const passwordInputs = $(form).find('input[type="password"]');
    if (inputs.length > 0 && passwordInputs.length === 0) {
      hasContactForm = true;
    }
  });
  signals.has_contact_form = hasContactForm;

  // ── Analytics & tracking ──────────────────────────────────────────────────────
  const scriptSrcs = [];
  const inlineScripts = [];
  $('script').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (src) scriptSrcs.push(src);
    else inlineScripts.push($(el).html() || '');
  });
  const allScriptContent = inlineScripts.join(' ');

  signals.has_google_analytics = /google-analytics\.com|gtag\s*\(|['"]ga['"]\s*,/.test(allScriptContent) ||
    scriptSrcs.some(s => /google-analytics\.com|googletagmanager\.com.*gtag/.test(s));
  signals.has_google_tag_manager = scriptSrcs.some(s => /googletagmanager\.com/.test(s)) ||
    /googletagmanager\.com/.test(allScriptContent);
  signals.has_facebook_pixel = scriptSrcs.some(s => /connect\.facebook\.net/.test(s)) ||
    /connect\.facebook\.net|fbq\s*\(/.test(allScriptContent);
  signals.has_any_analytics = signals.has_google_analytics || signals.has_google_tag_manager || signals.has_facebook_pixel;
  signals.has_ad_tracking = signals.has_facebook_pixel ||
    scriptSrcs.some(s => /snap\.licdn\.com|ads\.linkedin\.com/.test(s)) ||
    /snap\.licdn\.com/.test(allScriptContent);

  // ── Social links ──────────────────────────────────────────────────────────────
  const socialFound = new Set();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    for (const domain of SOCIAL_DOMAINS) {
      if (href.includes(domain)) socialFound.add(domain);
    }
  });
  signals.social_links      = Array.from(socialFound);
  signals.has_social_links  = socialFound.size > 0;
  signals.social_link_count = socialFound.size;

  // ── Blog / content signals ────────────────────────────────────────────────────
  let hasBlog = false;
  $('a, nav').each((_, el) => {
    const text = ($(el).text() + ' ' + ($(el).attr('href') || '')).toLowerCase();
    if (/\b(blog|news|articles|updates|posts)\b/.test(text)) hasBlog = true;
  });
  signals.has_blog_section = hasBlog;

  // Detect post dates near blog-like content
  const blogDates = [];
  if (hasBlog) {
    const bodyText = $.root().text();
    let m;
    const dateRe = /\b(20\d{2})\b/g;
    while ((m = dateRe.exec(bodyText)) !== null) {
      const yr = parseInt(m[1], 10);
      if (yr >= 2010 && yr <= currentYear) blogDates.push(yr);
    }
  }
  signals.blog_post_dates = blogDates;
  const mostRecentBlogYear = blogDates.length > 0 ? Math.max(...blogDates) : null;
  signals.stale_blog = hasBlog && mostRecentBlogYear !== null && (currentYear - mostRecentBlogYear) > 2;

  // ── Copyright year ────────────────────────────────────────────────────────────
  const copyrightYears = [];
  let cm;
  const crRe = /©\s*(\d{4})|[Cc]opyright\s+(\d{4})/g;
  while ((cm = crRe.exec(body)) !== null) {
    const yr = parseInt(cm[1] || cm[2], 10);
    if (yr >= 1990 && yr <= currentYear + 1) copyrightYears.push(yr);
  }
  signals.copyright_year = copyrightYears.length > 0 ? Math.max(...copyrightYears) : null;
  signals.copyright_age  = signals.copyright_year ? currentYear - signals.copyright_year : null;
  signals.old_copyright  = signals.copyright_age !== null && signals.copyright_age > 3;

  // ── Technology signals ────────────────────────────────────────────────────────
  const allLinkSrcs = [];
  $('link[href]').each((_, el) => allLinkSrcs.push($(el).attr('href') || ''));

  const jquerySrc = scriptSrcs.find(s => /jquery/i.test(s)) || null;
  signals.uses_jquery = !!jquerySrc || /jquery/i.test(allScriptContent);
  signals.jquery_version = extractVersion(jquerySrc, 'jquery');
  signals.old_jquery = signals.jquery_version ? compareVersion(signals.jquery_version, '2.0') : false;

  const bootstrapSrc = scriptSrcs.find(s => /bootstrap/i.test(s)) || allLinkSrcs.find(s => /bootstrap/i.test(s)) || null;
  signals.uses_bootstrap = !!bootstrapSrc;
  signals.bootstrap_version = extractVersion(bootstrapSrc, 'bootstrap');

  let inlineStyleCount = 0;
  $('[style]').each(() => inlineStyleCount++);
  signals.has_inline_styles = inlineStyleCount > 5;

  signals.uses_google_fonts = allLinkSrcs.some(s => /fonts\.googleapis\.com/.test(s));

  signals.iframe_count = $('iframe').length;

  const externalScriptDomains = new Set();
  scriptSrcs.forEach(src => {
    try {
      const u = new URL(src);
      externalScriptDomains.add(u.hostname);
    } catch (_) {}
  });
  signals.external_script_count = externalScriptDomains.size;

  // ── Image signals ─────────────────────────────────────────────────────────────
  signals.image_count = $('img').length;
  let missingAlt = 0;
  $('img').each((_, el) => {
    const alt = $(el).attr('alt');
    if (alt === undefined || alt === null || alt.trim() === '') missingAlt++;
  });
  signals.images_missing_alt = missingAlt;
  signals.all_images_have_alt = missingAlt === 0;
  signals.images_missing_alt_flag = missingAlt > 0;  // alias for scoring

  // ── Heading structure ─────────────────────────────────────────────────────────
  signals.has_h1             = $('h1').length > 0;
  signals.h1_count           = $('h1').length;
  signals.multiple_h1        = signals.h1_count > 1;
  signals.has_proper_heading_structure = signals.has_h1 && !signals.multiple_h1;
  signals.no_h1              = !signals.has_h1;

  return signals;
}

// ─── Ancillary requests (robots.txt, sitemap.xml, llms.txt) ───────────────────

async function fetchAncillary(domain) {
  const results = {
    has_robots: false,
    robots_body: null,
    sitemap_status: null,
    has_sitemap: false,
    sitemap_declared_in_robots: false,
    broken_sitemap: false,
    has_llms_txt: false,
  };

  // robots.txt
  try {
    const r = await axios.get(`${domain}/robots.txt`, {
      timeout: 5000,
      validateStatus: () => true,
      headers: buildHeaders(),
    });
    results.has_robots = r.status === 200;
    if (results.has_robots) {
      results.robots_body = typeof r.data === 'string' ? r.data : String(r.data);
      results.sitemap_declared_in_robots = /^Sitemap:/im.test(results.robots_body);
    }
  } catch (_) {}

  // sitemap.xml
  try {
    const r = await axios.get(`${domain}/sitemap.xml`, {
      timeout: 5000,
      validateStatus: () => true,
      headers: buildHeaders(),
    });
    results.sitemap_status = r.status;
    results.has_sitemap = r.status === 200;
  } catch (_) {
    results.sitemap_status = null;
    results.has_sitemap = false;
  }

  results.broken_sitemap = results.sitemap_declared_in_robots && results.sitemap_status !== 200;
  results.no_sitemap = !results.has_sitemap;

  // llms.txt
  try {
    const r = await axios.get(`${domain}/llms.txt`, {
      timeout: 5000,
      validateStatus: () => true,
      headers: buildHeaders(),
    });
    results.has_llms_txt = r.status === 200;
  } catch (_) {
    results.has_llms_txt = false;
  }
  results.no_llms_txt = !results.has_llms_txt;

  return results;
}

// ─── Primary export ────────────────────────────────────────────────────────────

/**
 * Main signal extraction function.
 * Returns { signals, httpStatus, disqualify_reason, finalUrl, sslError, protocol }
 */
async function extractSignals(rawUrl) {
  await jitterDelay(1500, 3500);

  // Normalize URL — strip protocol, trailing slash
  let cleanDomain;
  try {
    const u = new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`);
    cleanDomain = u.hostname.replace(/^www\./, '');
  } catch (_) {
    throw new Error('invalid_url');
  }

  const httpsUrl = `https://${cleanDomain}`;
  const httpUrl  = `http://${cleanDomain}`;

  let httpsResp = null;
  let httpResp  = null;
  let httpsElapsed = null;
  let sslError = false;
  let httpStatus = null;
  let finalUrl = httpsUrl;
  let body = '';
  let html = '';

  // Attempt HTTPS first
  try {
    const { response, elapsed } = await fetchUrl(httpsUrl);
    httpsElapsed = elapsed;
    httpsResp = response;
    httpStatus = response.status;
    // Get final URL from the response
    if (response.request && response.request.res && response.request.res.responseUrl) {
      finalUrl = response.request.res.responseUrl;
    }
    body = typeof response.data === 'string' ? response.data : '';
    html = body;
  } catch (err) {
    const msg = err.message || '';
    if (/certificate|ssl|tls|CERT|UNABLE_TO_VERIFY|SELF_SIGNED|ERR_CERT/i.test(msg) ||
        err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
        err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
        err.code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
      sslError = true;
    }
    // Try HTTP fallback
    try {
      const { response, elapsed } = await fetchUrl(httpUrl);
      httpResp = response;
      httpStatus = response.status;
      finalUrl = httpUrl;
      body = typeof response.data === 'string' ? response.data : '';
      html = body;
    } catch (err2) {
      throw Object.assign(new Error('connection_failed'), { httpStatus: 0 });
    }
  }

  if (!body) {
    throw Object.assign(new Error('empty_response'), { httpStatus });
  }

  // Stage 1: Hard disqualification (runs on raw body string)
  const disqualify_reason = checkDisqualifiers(body);

  // Infrastructure signals
  const httpsResult = { response: httpsResp, elapsed: httpsElapsed, sslError };
  const httpResult  = { response: httpResp,  elapsed: null };
  const infraSignals = extractInfrastructure(httpsResult, httpResult, []);

  if (disqualify_reason) {
    return {
      signals: { ...infraSignals },
      httpStatus,
      disqualify_reason,
      finalUrl,
      sslError,
      protocol: httpsResp ? 'https' : 'http',
    };
  }

  // Stage 3: HTML content signals
  const htmlSignals = extractHtmlSignals(body, html);

  // Ancillary requests (robots, sitemap, llms.txt)
  const ancillary = await fetchAncillary(httpsResp ? httpsUrl : httpUrl);

  const signals = {
    ...infraSignals,
    ...htmlSignals,
    ...ancillary,
  };

  return {
    signals,
    httpStatus,
    disqualify_reason: null,
    finalUrl,
    sslError,
    protocol: httpsResp ? 'https' : 'http',
  };
}

module.exports = { extractSignals };

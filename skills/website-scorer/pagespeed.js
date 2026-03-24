'use strict';

const axios = require('axios');

const PAGESPEED_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const TIMEOUT_MS = 30000;
const MAX_AUDIT_ISSUES = 10;

/**
 * Fetch PageSpeed Insights for a URL (mobile strategy, all categories).
 * Returns a flat result object — never throws.
 */
async function fetchPageSpeed(url) {
  const empty = {
    pagespeed_performance: null,
    pagespeed_accessibility: null,
    pagespeed_seo: null,
    pagespeed_best_practices: null,
    pagespeed_lcp: null,
    pagespeed_cls: null,
    pagespeed_fid: null,
    pagespeed_audit_issues: [],
    pagespeed_error: null,
  };

  try {
    // Google PageSpeed API requires repeated `category` params, not an array
    // Build the query string manually to get ?category=performance&category=seo&...
    const qs = new URLSearchParams([
      ['url',      url],
      ['strategy', 'mobile'],
      ['key',      process.env.PAGESPEED_API_KEY],
      ['category', 'performance'],
      ['category', 'accessibility'],
      ['category', 'seo'],
      ['category', 'best-practices'],
    ]).toString();

    const response = await axios.get(`${PAGESPEED_ENDPOINT}?${qs}`, {
      timeout: TIMEOUT_MS,
      validateStatus: () => true,
    });

    // PageSpeed quota exceeded — return error, caller will handle retry
    if (response.status === 429) {
      return { ...empty, pagespeed_error: 'quota_exceeded_429' };
    }

    if (response.status !== 200) {
      return { ...empty, pagespeed_error: `http_${response.status}` };
    }

    const data = response.data;
    const lr = data.lighthouseResult;

    if (!lr) {
      return { ...empty, pagespeed_error: 'no_lighthouse_result' };
    }

    const cats = lr.categories || {};
    const audits = lr.audits || {};

    const perf = cats.performance ? Math.round((cats.performance.score || 0) * 100) : null;
    const a11y = cats.accessibility ? Math.round((cats.accessibility.score || 0) * 100) : null;
    const seo  = cats.seo           ? Math.round((cats.seo.score || 0) * 100)           : null;
    const bp   = cats['best-practices'] ? Math.round((cats['best-practices'].score || 0) * 100) : null;

    // Core Web Vitals from audits
    const lcpAudit = audits['largest-contentful-paint'];
    const clsAudit = audits['cumulative-layout-shift'];
    const tbtAudit = audits['total-blocking-time'];

    const lcp = lcpAudit ? Math.round((lcpAudit.numericValue || 0)) : null;
    const cls = clsAudit ? parseFloat((clsAudit.numericValue || 0).toFixed(3)) : null;
    const fid = tbtAudit ? Math.round((tbtAudit.numericValue || 0)) : null;

    // Collect failing/warning audit titles from perf, a11y, and SEO categories
    const failedAuditTitles = [];
    const targetCats = ['performance', 'accessibility', 'seo'];

    for (const catKey of targetCats) {
      const cat = cats[catKey];
      if (!cat || !cat.auditRefs) continue;
      for (const ref of cat.auditRefs) {
        if (failedAuditTitles.length >= MAX_AUDIT_ISSUES) break;
        const audit = audits[ref.id];
        if (!audit) continue;
        if (typeof audit.score === 'number' && audit.score < 0.9) {
          failedAuditTitles.push(audit.title);
        }
      }
    }

    return {
      pagespeed_performance: perf,
      pagespeed_accessibility: a11y,
      pagespeed_seo: seo,
      pagespeed_best_practices: bp,
      pagespeed_lcp: lcp,
      pagespeed_cls: cls,
      pagespeed_fid: fid,
      pagespeed_audit_issues: failedAuditTitles.slice(0, MAX_AUDIT_ISSUES),
      pagespeed_error: null,
    };

  } catch (err) {
    let msg = err.message || 'unknown_error';
    if (err.code === 'ECONNABORTED' || msg.includes('timeout')) msg = 'timeout';
    return { ...empty, pagespeed_error: msg };
  }
}

module.exports = { fetchPageSpeed };

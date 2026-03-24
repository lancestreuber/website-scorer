'use strict';

const config = require('./signals.config');

// Maps signal key → human-readable problem phrase
// The function receives the full signals object so phrases can include dynamic values
function buildProblemPhrases(signals) {
  return [
    { key: 'http_only',            weight: config.quality.http_only,           phrase: 'no SSL certificate' },
    { key: 'no_ssl',               weight: config.quality.no_ssl,              phrase: 'SSL certificate error' },
    { key: 'pagespeed_perf_low',   weight: config.quality.pagespeed_perf_low,  phrase: `poor mobile performance (${signals._ps_performance}/100)` },
    { key: 'no_schema',            weight: config.quality.no_schema,           phrase: 'no structured data markup' },
    { key: 'no_sitemap',           weight: config.quality.no_sitemap,          phrase: 'no XML sitemap' },
    { key: 'pagespeed_a11y_low',   weight: config.quality.pagespeed_a11y_low,  phrase: `poor accessibility score (${signals._ps_accessibility}/100)` },
    { key: 'pagespeed_seo_low',    weight: config.quality.pagespeed_seo_low,   phrase: `low SEO score (${signals._ps_seo}/100)` },
    { key: 'low_word_count',       weight: config.quality.low_word_count,      phrase: `thin content (${signals.word_count} words)` },
    { key: 'no_meta_description',  weight: config.quality.no_meta_description, phrase: 'missing meta description' },
    { key: 'no_contact_info',      weight: config.quality.no_contact_info,     phrase: 'no phone number or address visible' },
    { key: 'pagespeed_bp_low',     weight: config.quality.pagespeed_bp_low,    phrase: `failing best practices (${signals._ps_best_practices}/100)` },
    { key: 'slow_response',        weight: config.quality.slow_response,       phrase: `slow load time (${signals.ttfb_ms}ms response)` },
    { key: 'no_og_tags',           weight: config.quality.no_og_tags,          phrase: 'missing Open Graph tags' },
    { key: 'old_copyright',        weight: config.quality.old_copyright,       phrase: `copyright year showing ${signals.copyright_year}` },
    { key: 'no_viewport',          weight: config.quality.no_viewport,         phrase: 'not mobile-optimized (missing viewport tag)' },
    { key: 'missing_hsts',         weight: config.quality.missing_hsts,        phrase: 'no HSTS security header' },
    { key: 'multiple_h1',          weight: config.quality.multiple_h1,         phrase: `multiple H1 tags (${signals.h1_count} found)` },
    { key: 'no_h1',                weight: config.quality.no_h1,               phrase: 'no H1 heading tag' },
    { key: 'images_missing_alt',   weight: config.quality.images_missing_alt,  phrase: `${signals.images_missing_alt} image(s) missing alt text` },
    { key: 'excessive_redirects',  weight: config.quality.excessive_redirects, phrase: `too many redirects (${signals.redirect_count})` },
    { key: 'old_jquery',           weight: config.quality.old_jquery,          phrase: `outdated jQuery version (${signals.jquery_version})` },
  ];
}

function buildIntentPhrases(signals) {
  const phrases = [];
  if (signals.has_google_analytics || signals.has_google_tag_manager) phrases.push('has Google Analytics installed');
  if (signals.has_facebook_pixel)    phrases.push('runs Facebook/Meta Pixel');
  if (signals.has_ad_tracking)       phrases.push('uses ad tracking');
  if (signals.has_contact_form)      phrases.push('has a lead capture form');
  if (signals.broken_sitemap)        phrases.push('attempted XML sitemap setup (now broken)');
  if (signals.partial_og_tags)       phrases.push('partially implemented Open Graph tags');
  if (signals.has_broken_schema)     phrases.push('attempted structured data markup (invalid JSON)');
  if (signals.stale_blog)            phrases.push('started a blog that went dormant');
  if (signals.has_social_links)      phrases.push(`maintains ${signals.social_link_count} social media presence(s)`);
  if (signals.meta_description_too_long) phrases.push('wrote a meta description (too long)');
  if (signals.has_google_fonts)      phrases.push('chose custom typography via Google Fonts');
  return phrases;
}

/**
 * Generate a 2–4 sentence plain-English assessment string.
 * No AI — purely template-driven.
 */
function generateAssessment(signals, qualityScore, intentScore, band, pageSpeedData) {
  // Attach PageSpeed values into signals object for phrase interpolation
  signals._ps_performance    = pageSpeedData && pageSpeedData.pagespeed_performance    != null ? pageSpeedData.pagespeed_performance    : '?';
  signals._ps_accessibility  = pageSpeedData && pageSpeedData.pagespeed_accessibility  != null ? pageSpeedData.pagespeed_accessibility  : '?';
  signals._ps_seo            = pageSpeedData && pageSpeedData.pagespeed_seo            != null ? pageSpeedData.pagespeed_seo            : '?';
  signals._ps_best_practices = pageSpeedData && pageSpeedData.pagespeed_best_practices != null ? pageSpeedData.pagespeed_best_practices : '?';

  const problems = buildProblemPhrases(signals);
  const firedProblems = problems
    .filter(p => signals[p.key] === true)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 4);

  const sentences = [];

  // Sentence 1 — problem list
  if (firedProblems.length === 0) {
    sentences.push(`This site has a quality score of ${qualityScore} with no major individual issues flagged.`);
  } else if (firedProblems.length === 1) {
    sentences.push(`This site has ${firedProblems[0].phrase}.`);
  } else if (firedProblems.length === 2) {
    sentences.push(`This site has ${firedProblems[0].phrase} and ${firedProblems[1].phrase}.`);
  } else {
    const last = firedProblems[firedProblems.length - 1].phrase;
    const rest = firedProblems.slice(0, -1).map(p => p.phrase).join(', ');
    sentences.push(`This site has ${rest}, and ${last}.`);
  }

  // Sentence 2 — PageSpeed summary (only if data is available and not all nulls)
  if (pageSpeedData && pageSpeedData.pagespeed_error === null &&
      pageSpeedData.pagespeed_performance != null && pageSpeedData.pagespeed_seo != null) {
    sentences.push(`It scored ${pageSpeedData.pagespeed_performance}/100 on mobile performance and ${pageSpeedData.pagespeed_seo}/100 for SEO.`);
  }

  // Sentence 3 — intent signals
  const intentPhrases = buildIntentPhrases(signals);
  if (intentPhrases.length > 0) {
    const evidence = intentPhrases.slice(0, 3).join(', ');
    sentences.push(`The owner shows signs of effort — ${evidence} — suggesting they're open to improvement.`);
  } else {
    sentences.push(`No analytics or tracking detected, suggesting the owner may be less engaged with their online presence.`);
  }

  // Sentence 4 — band context
  if (band === 'hot') {
    sentences.push(`Strong candidate: both quality (${qualityScore}) and intent (${intentScore}) scores clear hot-lead thresholds.`);
  } else if (band === 'warm') {
    sentences.push(`Warm lead: quality score (${qualityScore}) is solid but intent signals are moderate (${intentScore}).`);
  } else if (band === 'cold') {
    sentences.push(`Cold lead: low quality score (${qualityScore}) or insufficient intent signals (${intentScore}).`);
  }

  return sentences.join(' ');
}

module.exports = { generateAssessment };

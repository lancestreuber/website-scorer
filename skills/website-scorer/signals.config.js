'use strict';

module.exports = {

  // These trigger instant disqualification — score becomes 0, lead is skipped
  disqualifiers: [
    'shopify_detected', 'woocommerce_detected', 'bigcommerce_detected',
    'squarespace_commerce', 'magento_detected', 'wix_commerce',
    'ecwid_detected', 'prestashop_detected',
    'login_form_present', 'auth_links_detected', 'member_portal_detected',
    'cart_detected', 'checkout_detected', 'buy_button_detected',
  ],

  // Quality signals — each adds to the quality score
  // Higher quality score = worse website = better lead for us
  quality: {
    http_only:                 15,
    no_ssl:                    15,  // SSL error on HTTPS attempt
    pagespeed_perf_low:        15,  // performance < 50
    no_schema:                 12,
    no_sitemap:                12,
    pagespeed_a11y_low:        12,  // accessibility < 70
    pagespeed_seo_low:         12,  // SEO score < 70
    low_word_count:            10,
    no_meta_description:       10,
    no_contact_info:           10,
    pagespeed_bp_low:          10,  // best practices < 70
    slow_response:              8,
    no_og_tags:                 8,
    old_copyright:              8,
    no_viewport:                8,  // not mobile optimized
    missing_hsts:               5,
    missing_csp:                4,
    multiple_h1:                4,
    no_h1:                      5,
    images_missing_alt:         6,  // any images missing alt
    excessive_redirects:        4,
    old_jquery:                 6,
  },

  // Intent signals — add to intent_score separately
  // Higher intent score = owner is trying but failing = more motivated buyer
  intent: {
    has_any_analytics:         15,  // they care about traffic
    has_ad_tracking:           12,  // they've run or considered paid ads
    has_contact_form:          10,  // they want leads
    has_facebook_pixel:        12,
    broken_sitemap:            10,  // they set one up but it broke
    has_social_links:           8,  // they're active somewhere online
    partial_og_tags:            8,  // they know about OG tags but did it wrong
    has_broken_schema:          7,  // they tried structured data but it's malformed
    stale_blog:                 8,  // tried content marketing, gave up
    meta_description_too_long:  6,  // they added meta descriptions but got the length wrong
    has_google_fonts:           5,  // someone put thought into typography
    no_llms_txt:               20,  // no llms.txt = not AI-aware = we can pitch AI features
  },

  // Score thresholds for band assignment
  thresholds: {
    hot:  { minScore: 80, minIntent: 20 },
    warm: { minScore: 60, minIntent: 0  },
    // anything below warm thresholds = cold
  },

  // PageSpeed thresholds used by pipeline.js to map raw scores to signal keys
  pagespeed: {
    perf_low_threshold:  50,
    a11y_low_threshold:  70,
    seo_low_threshold:   70,
    bp_low_threshold:    70,
  },
};

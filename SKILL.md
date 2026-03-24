# Skill: website-scorer

## What this skill does

`website-scorer` is a lead qualification pipeline for a web development agency. Given a CSV file of business leads, it fetches each website, runs deterministic signal extraction (no AI or LLMs), calls the Google PageSpeed Insights API, and outputs an enriched CSV with a quality score, intent score, band classification (hot/warm/cold/disqualified), and a plain-English assessment of each site's problems. The goal is to identify small businesses with bad websites whose owners are actively trying to improve — those are the easiest sales.

---

## When to use this skill

Invoke this skill when the user says any of the following (or close variants):
- "score these leads"
- "qualify these websites"
- "run the website scorer"
- "audit these sites"
- "process the CSV"
- "find hot leads"
- "score the CSV"
- "run the lead pipeline"
- "which of these sites are worth contacting"

---

## Entry point

```bash
node /home/pi/openclaw/skills/website-scorer/pipeline.js \
  --csv <input_csv_path> \
  --out <output_csv_path> \
  [--url-col <column_name>] \
  [--concurrency <n>] \
  [--errors-only]
```

---

## CLI Arguments

| Argument | Type | Default | Required | Description |
|---|---|---|---|---|
| `--csv` | string (absolute path) | — | YES | Path to input CSV file |
| `--out` | string (absolute path) | — | YES | Path for output CSV (created/overwritten) |
| `--url-col` | string | auto-detect | no | Column name in CSV that contains URLs. Auto-detection checks: `website`, `url`, `domain`, `web`, `site`, `homepage` (case-insensitive). |
| `--concurrency` | integer 1–10 | 5 | no | How many domains to process in parallel. Max 10. |
| `--errors-only` | flag | false | no | Re-process only rows where a previous run produced `band=error`. Used to retry failed domains without re-scoring everything. |

---

## Example invocations

**Basic run (auto-detect URL column):**
```bash
node /home/pi/openclaw/skills/website-scorer/pipeline.js \
  --csv /home/pi/openclaw/data/inputs/leads_march.csv \
  --out /home/pi/openclaw/data/outputs/leads_march_scored.csv \
  --concurrency 5
```

**Specify URL column, lower concurrency, re-run errors only:**
```bash
node /home/pi/openclaw/skills/website-scorer/pipeline.js \
  --csv /home/pi/openclaw/data/outputs/leads_march_scored.csv \
  --out /home/pi/openclaw/data/outputs/leads_march_scored_v2.csv \
  --url-col "Website URL" \
  --concurrency 2 \
  --errors-only
```

---

## Input CSV requirements

- First row must be a header row
- Must have at least one column containing URLs (website addresses)
- URLs may have or lack `https://` prefix — the tool normalizes them
- All other columns are preserved in the output

**Place input CSVs at:** `/home/pi/openclaw/data/inputs/`

---

## Output CSV

The output CSV contains all original columns, plus these new columns appended in order:

| Column | Type | Description |
|---|---|---|
| `score` | integer | Quality score (0–180+). Higher = worse website = better lead. |
| `intent_score` | integer | Intent score (0–115+). Higher = more evidence owner is trying to improve. |
| `band` | string | `hot`, `warm`, `cold`, `disqualified`, or `error` |
| `disqualify_reason` | string | Reason code if disqualified (e.g., `shopify_detected`, `cart_detected`) |
| `ssl_valid` | boolean string | Whether HTTPS fetch succeeded with valid SSL |
| `is_https` | boolean string | Whether final URL uses HTTPS |
| `word_count` | integer | Approximate visible word count on homepage |
| `has_analytics` | boolean string | Google Analytics or GTM or Facebook Pixel detected |
| `has_schema` | boolean string | Structured data (JSON-LD or microdata) present |
| `has_sitemap` | boolean string | sitemap.xml returned HTTP 200 |
| `has_llms_txt` | boolean string | `/llms.txt` returned HTTP 200 (AI-awareness signal) |
| `pagespeed_performance` | integer 0–100 | Mobile performance score from PageSpeed Insights |
| `pagespeed_accessibility` | integer 0–100 | Accessibility score |
| `pagespeed_seo` | integer 0–100 | SEO score |
| `pagespeed_best_practices` | integer 0–100 | Best practices score |
| `pagespeed_lcp` | integer (ms) | Largest Contentful Paint in milliseconds |
| `pagespeed_error` | string | Error message if PageSpeed call failed, empty otherwise |
| `signals_fired` | pipe-delimited string | Quality signals that fired, e.g. `no_ssl\|no_schema\|low_word_count` |
| `intent_signals_fired` | pipe-delimited string | Intent signals that fired, e.g. `has_any_analytics\|has_contact_form` |
| `assessment` | string | 2–4 sentence plain-English summary of the site's problems and lead potential |

**Output CSVs appear at:** `/home/pi/openclaw/data/outputs/`

---

## Band definitions

| Band | Condition | Meaning |
|---|---|---|
| `hot` | `score >= 80` AND `intent_score >= 20` | Excellent lead. Bad site + motivated owner. Prioritize. |
| `warm` | `score >= 60` OR `intent_score >= 15` | Worth pursuing. Decent quality signal or decent intent. |
| `cold` | Below warm thresholds | Low priority. Site may not be bad enough, or owner shows no engagement. |
| `disqualified` | E-commerce, login portals, cart/checkout detected | Not a target. Site is already sophisticated or a platform store. Skip entirely. |
| `error` | Unhandled exception, timeout, or connection failure | Could not fetch the site. Use `--errors-only` to retry. |

---

## Disqualification reasons

A domain is immediately disqualified (score=0, skipped) if any of these patterns are detected on the homepage HTML:

- `shopify_detected` — Shopify CDN or myshopify.com URLs present
- `woocommerce_detected` — WooCommerce scripts/classes present
- `bigcommerce_detected` — BigCommerce references
- `squarespace_commerce` — Squarespace commerce features
- `magento_detected` — Magento references
- `wix_commerce` — Wix site with store/cart features
- `ecwid_detected` — Ecwid e-commerce
- `prestashop_detected` — PrestaShop
- `login_form_present` — Password input field detected
- `auth_links_detected` — Links to /login, /signin, /wp-login, etc.
- `wordpress_admin` — Links to /wp-admin
- `member_portal_detected` — "Member login", "client login", "staff login" text
- `cart_detected` — Shopping cart elements (classes/IDs)
- `checkout_detected` — Links to /cart, /checkout, /basket
- `buy_button_detected` — "Add to cart", "Buy now" button text

Note: WordPress sites WITHOUT e-commerce signals are NOT disqualified.

---

## Environment variable requirements

| Variable | Required | Location |
|---|---|---|
| `PAGESPEED_API_KEY` | YES | `/home/pi/openclaw/keys/.env` |

The tool will refuse to start if `PAGESPEED_API_KEY` is missing. Obtain a free key at https://developers.google.com/speed/docs/insights/v5/get-started — the free tier allows ~25,000 requests/day.

---

## Estimated runtime

- Per domain: 10–20 seconds (includes 1.5–3.5s jitter delay + HTTP fetch + ancillary requests + PageSpeed API call)
- 50 domains at concurrency=5: ~5–10 minutes
- 200 domains at concurrency=5: ~15–35 minutes
- 500 domains at concurrency=5: ~35–90 minutes

PageSpeed Insights calls are the main bottleneck. If PageSpeed returns a 429 (quota exceeded), the tool automatically waits 60 seconds and retries once before continuing.

---

## stdout format (machine-parseable)

All lines written to stdout follow one of these exact formats:

```
[START] Website Scorer · {n} domains · concurrency={c}
[PROGRESS] {i}/{total} · {domain} · {band} (score={score}, intent={intent})
[PROGRESS] {i}/{total} · {domain} · disqualified (reason={reason})
[PROGRESS] {i}/{total} · {domain} · error (http_status={status})
[SUMMARY] Done in {Xm Ys} · {n} disqualified · {n} hot · {n} warm · {n} cold · {n} errors
[OUTPUT] {absolute_path_to_output_csv}
```

All debug and signal-level logging goes to the log file only (see `/home/pi/openclaw/data/logs/`). stdout stays clean for machine parsing.

---

## `--errors-only` flag

Use this flag when a previous run produced some `band=error` rows (network failures, timeouts, etc.) and you want to retry only those domains without re-processing successfully scored rows.

Pass the **scored output CSV** as `--csv` and a new path as `--out`. The tool will filter to only rows where `band=error` and re-process them. The output will contain only the retried rows (not the full dataset), so you may need to merge with the original output.

---

## Log files

Each run creates a detailed log at:
```
/home/pi/openclaw/data/logs/run_{ISO_timestamp}.log
```

The log contains the full signal JSON for each domain, PageSpeed raw results, and any errors. It is not written to stdout. Use these logs for debugging or to understand exactly which signals fired.

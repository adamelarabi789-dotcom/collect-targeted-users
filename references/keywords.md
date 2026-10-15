---
name: target-keywords
description: Optional flat keyword list and account criteria for the collector. Replace the placeholders with YOUR niche keywords, or configure them in config.json.
---

# Target Keywords & Niche Criteria (template)

> **This file is optional.** The authoritative niche keywords live in
> `config.json` → `search.keywords.A` / `search.keywords.B` (or the
> `X_NICHE_KEYWORDS` / `X_KEYWORDS_A` / `X_KEYWORDS_B` env vars). The scanner
> only uses this file as an extra list of terms for its keyword-hit report.
>
> Every `- item` bullet below is treated as a keyword. Replace the placeholders
> with your own terms, or leave this file empty.

## 1. Niche & Industry Keywords (Bucket A)
- [INSERT_NICHE_KEYWORDS_A]

## 2. Production / Creative Keywords
- [INSERT_CREATIVE_KEYWORDS]

## 3. Secondary Role Keywords (Bucket B)
- [INSERT_NICHE_KEYWORDS_B]

## 4. Target Buckets (labels only)
- **Bucket A:** [INSERT_BUCKET_A_NAME] - rename in `config.json` `classification.buckets.A.name`
- **Bucket B:** [INSERT_BUCKET_B_NAME] - rename in `config.json` `classification.buckets.B.name`

Default run target: **20 NEW unique users total** collected in one unified pass
(A + B combined; the bucket label is only a hint).

## 5. Account Filtering Criteria
- **Follower Count:** Less than `criteria.maxFollowers` (default 40,000).
- **Activity Threshold:** Newest post within `criteria.maxLastPostDays` (default 7)
  and at least `criteria.minPosts30d` posts in `criteria.activityWindowDays`
  (default 8 in 30 days), relaxed toward `criteria.minPosts30dFloor` when behind pace.
- **Classification:** `scripts/semantics.js` (`scoreSemantics`) assigns the A/B
  label from the configured lexicon - it is a hint only and never gates the run.

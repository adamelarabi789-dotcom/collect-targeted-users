'use strict';
/**
 * columns.js — the single, strict output schema for the skill.
 *
 * Every final output (the Google Sheet and the optional --local-csv mirror)
 * uses EXACTLY these 8 columns, in this order. The scanner's richer in-memory
 * candidate record (recent posts, matched terms, run id, …) is NOT persisted.
 */
const COLUMNS = [
  'bucket',
  'category',
  'username',
  'profileUrl',
  'followers',
  'bio',
  'daysSinceLastPost',
  'postsLast7Days',
];

module.exports = { COLUMNS };

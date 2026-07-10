/**
 * Fuzzy path scoring ported from VS Code's `src/vs/base/common/fuzzyScorer.ts`
 * (Microsoft, MIT licensed) — the same scorer behind Quick Open and the chat
 * file pickers. The DP matrix (`doScoreFuzzy`/`computeCharScore`) is a direct
 * port; item scoring keeps VS Code's label-over-path threshold scheme.
 */

const NO_MATCH = 0;

const PATH_IDENTITY_SCORE = 1 << 18;
const LABEL_PREFIX_SCORE_THRESHOLD = 1 << 17;
const LABEL_SCORE_THRESHOLD = 1 << 16;

function isUpper(code: number): boolean {
  return code >= 65 && code <= 90;
}

function scoreSeparatorAtPos(charCode: number): number {
  switch (charCode) {
    case 47: // slash
    case 92: // backslash
      return 5; // prefer path separators...
    case 95: // underscore
    case 45: // dash
    case 46: // period
    case 32: // space
    case 39: // single quote
    case 34: // double quote
    case 58: // colon
      return 4; // ...over other separators
    default:
      return 0;
  }
}

function considerAsEqual(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  if (a === "/" || a === "\\") {
    return b === "/" || b === "\\";
  }
  return false;
}

function computeCharScore(
  queryChar: string,
  queryLowerChar: string,
  target: string,
  targetLower: string,
  targetIndex: number,
  matchesSequenceLength: number
): number {
  if (!considerAsEqual(queryLowerChar, targetLower[targetIndex])) {
    return 0;
  }
  let score = 1; // character match bonus

  // Consecutive match bonus: sequences up to 3 get the full bonus (6) and the
  // remainder half (3), reducing the boost of very long sequences.
  if (matchesSequenceLength > 0) {
    score += Math.min(matchesSequenceLength, 3) * 6 + Math.max(0, matchesSequenceLength - 3) * 3;
  }
  if (queryChar === target[targetIndex]) {
    score += 1; // same case bonus
  }
  if (targetIndex === 0) {
    score += 8; // start of word bonus
  } else {
    const separatorBonus = scoreSeparatorAtPos(target.charCodeAt(targetIndex - 1));
    if (separatorBonus) {
      score += separatorBonus; // after separator bonus
    } else if (isUpper(target.charCodeAt(targetIndex)) && matchesSequenceLength === 0) {
      score += 2; // inside-word camelCase bonus
    }
  }
  return score;
}

/**
 * Cheap in-order subsequence check — the prefilter that keeps the scorer
 * instant: most candidates die here in O(target) instead of running the
 * O(query × target) matrix.
 */
function isSubsequence(queryLower: string, targetLower: string): boolean {
  let queryIndex = 0;
  for (let targetIndex = 0; targetIndex < targetLower.length; targetIndex++) {
    const queryChar = queryLower[queryIndex];
    const targetChar = targetLower[targetIndex];
    if (
      queryChar === targetChar ||
      ((queryChar === "/" || queryChar === "\\") && (targetChar === "/" || targetChar === "\\"))
    ) {
      queryIndex++;
      if (queryIndex === queryLower.length) {
        return true;
      }
    }
  }
  return false;
}

// Scratch buffers reused across scorer calls: every cell is written before it
// is read, so no clearing is needed and per-call allocations disappear.
let scratchScores: number[] = [];
let scratchMatches: number[] = [];

const MAX_TARGET_LENGTH = 256;

/** VS Code's scorer matrix; returns 0 when the query is not a subsequence. */
function scoreFuzzyRaw(target: string, query: string): number {
  if (!target || !query) {
    return NO_MATCH;
  }
  const targetLength = target.length;
  const queryLength = query.length;
  if (targetLength < queryLength || targetLength > MAX_TARGET_LENGTH) {
    return NO_MATCH;
  }
  const queryLower = query.toLowerCase();
  const targetLower = target.toLowerCase();
  if (!isSubsequence(queryLower, targetLower)) {
    return NO_MATCH;
  }

  const cells = queryLength * targetLength;
  if (scratchScores.length < cells) {
    scratchScores = new Array(cells);
    scratchMatches = new Array(cells);
  }
  const scores = scratchScores;
  const matches = scratchMatches;

  for (let queryIndex = 0; queryIndex < queryLength; queryIndex++) {
    const queryIndexOffset = queryIndex * targetLength;
    const queryIndexPreviousOffset = queryIndexOffset - targetLength;
    const queryIndexGtNull = queryIndex > 0;
    const queryCharAtIndex = query[queryIndex];
    const queryLowerCharAtIndex = queryLower[queryIndex];

    for (let targetIndex = 0; targetIndex < targetLength; targetIndex++) {
      const targetIndexGtNull = targetIndex > 0;
      const currentIndex = queryIndexOffset + targetIndex;
      const leftIndex = currentIndex - 1;
      const diagIndex = queryIndexPreviousOffset + targetIndex - 1;

      const leftScore = targetIndexGtNull ? scores[leftIndex] : 0;
      const diagScore = queryIndexGtNull && targetIndexGtNull ? scores[diagIndex] : 0;
      const matchesSequenceLength =
        queryIndexGtNull && targetIndexGtNull ? matches[diagIndex] : 0;

      // Only produce a score for later query chars if the previous query char
      // already scored (keeps matches in sequence on the target).
      const score =
        !diagScore && queryIndexGtNull
          ? 0
          : computeCharScore(
              queryCharAtIndex,
              queryLowerCharAtIndex,
              target,
              targetLower,
              targetIndex,
              matchesSequenceLength
            );

      if (score && diagScore + score >= leftScore) {
        matches[currentIndex] = matchesSequenceLength + 1;
        scores[currentIndex] = diagScore + score;
      } else {
        matches[currentIndex] = NO_MATCH;
        scores[currentIndex] = leftScore;
      }
    }
  }

  return scores[queryLength * targetLength - 1];
}

/**
 * Scores a workspace-relative path against a query, mirroring VS Code's
 * doScoreItemFuzzySingle: label (basename) matches sit above path matches via
 * score thresholds, and label prefix matches above both, boosted by how much
 * of the label the query covers.
 */
export function fuzzyScore(query: string, targetPath: string): number | undefined {
  const trimmed = query.trim();
  if (!trimmed) {
    return 0;
  }
  const normalizedPath = targetPath.replace(/\\/g, "/");
  const queryLower = trimmed.toLowerCase();

  if (normalizedPath.toLowerCase() === queryLower) {
    return PATH_IDENTITY_SCORE;
  }

  // Directories carry a trailing "/" — strip it so their basename still
  // label-matches ("media" must hit "media/") instead of an empty label.
  const basePath = normalizedPath.endsWith("/") ? normalizedPath.slice(0, -1) : normalizedPath;
  const slash = basePath.lastIndexOf("/");
  const label = slash >= 0 ? basePath.slice(slash + 1) : basePath;
  const preferLabelMatches = !trimmed.includes("/") && !trimmed.includes("\\");

  if (preferLabelMatches) {
    const labelScore = scoreFuzzyRaw(label, trimmed);
    if (labelScore) {
      // Prefix matches on the label elevate above any other label match, with
      // a boost for short labels (query coverage percentage).
      if (label.toLowerCase().startsWith(queryLower)) {
        const coverage = Math.round((trimmed.length / label.length) * 100);
        return LABEL_PREFIX_SCORE_THRESHOLD + coverage + labelScore;
      }
      return LABEL_SCORE_THRESHOLD + labelScore;
    }
  }

  const pathScore = scoreFuzzyRaw(normalizedPath, trimmed);
  return pathScore ? pathScore : undefined;
}

/** Ranks candidates by fuzzy score (desc), shallow paths and alpha order. */
export function rankPaths(query: string, candidates: string[], limit: number): string[] {
  if (!query.trim()) {
    return [...candidates]
      .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
      .slice(0, limit);
  }
  const scored: Array<{ path: string; score: number }> = [];
  for (const candidate of candidates) {
    const score = fuzzyScore(query, candidate);
    if (score !== undefined) {
      scored.push({ path: candidate, score });
    }
  }
  return scored
    .sort(
      (a, b) =>
        b.score - a.score || depth(a.path) - depth(b.path) || a.path.localeCompare(b.path)
    )
    .slice(0, limit)
    .map((entry) => entry.path);
}

function depth(candidate: string): number {
  let count = 0;
  for (const char of candidate) {
    if (char === "/") {
      count++;
    }
  }
  // A directory's trailing "/" is a marker, not a level: "media/" sits at
  // the same depth as "readme.md".
  return candidate.endsWith("/") ? count - 1 : count;
}

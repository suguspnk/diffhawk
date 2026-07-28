export const MAX_REVIEW_BATCH_SIZE = 10;
export const MAX_REVIEWS_PER_POLL = 20;
// Stay below Codex's 1,048,576-character request ceiling after UTF-8
// serialization and leave headroom for transport framing.
export const MAX_REVIEW_PROMPT_BYTES = 900_000;
export const MAX_REVIEW_STDOUT_BYTES = 2 * 1024 * 1024;
export const MAX_REVIEW_STDERR_BYTES = 256 * 1024;
export const MAX_REVIEW_SUMMARY_CHARS = 16_000;
export const MAX_REVIEW_FINDINGS = 50;
export const MAX_REVIEW_COMMENT_CHARS = 4_000;
export const MAX_REVIEW_PATH_CHARS = 512;
// Includes summary + comments. 28k leaves room under GitHub's 60k review-body
// cap for fifty maximum-length paths plus markdown/location formatting when
// every finding must be demoted from inline to the review body.
export const MAX_REVIEW_TOTAL_TEXT_CHARS = 28_000;
export const MAX_GITHUB_REVIEW_BODY_CHARS = 60_000;
export const REVIEWER_HARD_KILL_GRACE_MS = 1_000;
export const MAX_GH_OUTPUT_BYTES = 32 * 1024 * 1024;

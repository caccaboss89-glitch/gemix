// Shared one-liner for web_x_search tool descriptions (main brain + build sub-agent).
const WEB_X_SEARCH_RESEARCH_GUIDANCE =
  'Deep/broad: full_team=true once with one detailed prompt covering all fact needs; fast only for a narrow fact — no chaining searches. Build agent: max 2 calls total (facts + optional search_images).';

module.exports = { WEB_X_SEARCH_RESEARCH_GUIDANCE };
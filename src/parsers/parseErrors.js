// src/parsers/parseErrors.js
//
// The vocabulary a failed parse speaks, shared by the registry and the parsers
// it dispatches to. It lives on its own so a parser can name a reason without
// importing the registry that imports it.

/** Structured reasons a parse can fail, so the model can act on them. */
const PARSE_ERROR = Object.freeze({
  FILE_UNAVAILABLE: 'FILE_UNAVAILABLE',
  PARSER_UNAVAILABLE: 'PARSER_UNAVAILABLE',
  UNSUPPORTED_TYPE: 'UNSUPPORTED_TYPE',
  TOO_LARGE: 'TOO_LARGE'
});

export { PARSE_ERROR };

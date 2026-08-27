// src/tools/executors/web.js
//
// Web discovery executor bindings.

import { searchImage } from '../searchImage.js';
import { readPage, searchWeb } from '../searchWeb.js';

const WEB_TOOL_EXECUTORS = Object.freeze({
  search_web: ({ args, responseCtx, userCtx }) => (
    searchWeb(args, responseCtx, { signal: userCtx.turnBudget?.signal })
  ),
  read_page: ({ args, responseCtx, userCtx }) => (
    readPage(args, responseCtx, { signal: userCtx.turnBudget?.signal })
  ),
  search_image: ({ args, userCtx }) => searchImage(args, { signal: userCtx.turnBudget?.signal })
});

export { WEB_TOOL_EXECUTORS };

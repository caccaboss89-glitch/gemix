// src/tools/executors/loading.js
//
// The deferred-tool loader of a Responses turn. The schema's enum already
// limits the names to the caller's deferred tools; loading one only adds it to
// the turn's set, and the engine offers it from the next round on.

function loadTools({ args, userCtx }) {
  const names = [...new Set(args.names)];
  for (const name of names) userCtx.loadedTools.add(name);
  return {
    success: true,
    status: 'ok',
    loaded: names,
    message: `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} now in your tool list.`
  };
}

const LOADING_TOOL_EXECUTORS = Object.freeze({ load_tools: loadTools });

export { LOADING_TOOL_EXECUTORS, loadTools };

# Sanitized OpenAI wire fixtures

Recorded shapes from the Codex Responses probes, rewritten so they contain no
credential, no ChatGPT account id, no signed URL and no user content. They exist
so the protocol can be implemented and regression-tested without ever running a
probe against a real token again.

- `function-loop.sse.txt` — a round that emits reasoning + a function call whose
  complete item only ever appears on `response.output_item.done`, and whose
  `response.completed.response.output` omits it. This is the case that makes the
  decoder's canonical item map necessary.
- `web-search.sse.txt` — hosted web search returning mixed text and
  `image_result` entries, plus `url_citation` annotations on the message.
- `incomplete.sse.txt` — a stream that stops after a delta with no terminal
  event, used to pin the "partial response, do not retry" rule.

# GemiX <-> Hermes Bridge

Tiny shim layer used to call Hermes for capabilities that the OpenAI-compatible
HTTP proxy (`hermes proxy`) doesn't expose.

## Why this exists

`hermes proxy` (the OAuth-backed OpenAI-compatible server GemiX talks to over
HTTP) only forwards a handful of paths to xAI:

```
/chat/completions  /completions  /embeddings  /models  /responses
```

Inside `/responses` the only allowed tool variants are:

```
function, web_search, x_search, collections_search, file_search,
code_execution, code_interpreter, mcp, shell
```

**Grok Imagine (image and video generation) is NOT exposed via any of those
paths**, so the proxy returns 404 (`/v1/images/generations`) or 422 (unknown
tool variant on `/responses`). **xAI TTS (`text_to_speech`) is also NOT
exposed via the proxy** - `/v1/tts` returns 404 `path_not_allowed`.

Hermes itself, however, ships internal toolsets `image_gen`, `video_gen`,
and `tts` that DO work - but only through the Hermes CLI / TUI, not the
proxy. The one-shot mode (`hermes -z "<prompt>"`) calls those tools and
either prints the resulting media URL on stdout (Imagine) or saves the
audio to disk at a path we control (TTS), which is exactly the contract
we need.

## Files

### `imagine.sh`

Wraps `hermes -z` for image and video generation. Single-line URL on stdout,
diagnostics on stderr, conventional exit codes.

```
bridge/imagine.sh image "<prompt>" [aspect_ratio]
bridge/imagine.sh video "<prompt>" [aspect_ratio] [duration_s] [resolution]
```

**Reference images** (image-to-image / image-to-video / reference-to-video):
the caller (`imagineGenerator.js`) resolves the requested filenames, exposes
them through the public attachment tunnel, and passes two env vars:

- `IMAGINE_REF_CLAUSE` - a ready-made natural-language sentence the wrapper
  appends verbatim to the prompt. It pairs each reference as
  `"<filename>" (<public_url>)` and encodes the intent: image gen -> guide
  subject/style/composition; video gen with 1 ref -> animate that exact image
  (image-to-video); video gen with 2-7 refs -> keep subjects/style consistent
  (reference-to-video). All the semantics live in the JS caller, not here.
- `IMAGINE_REF_URLS` - the same URLs, space-separated, used ONLY to strip any
  echoed reference URLs out of hermes' stdout before extracting the result URL.

The CLI cannot ingest binary inputs, but it does consume reference images
mentioned as URLs (verified in production: `hermes -t video_gen -z 'Animate
<https url>'` animates that image). xAI fetches each URL server-side.

### `tts.sh`

Wraps `hermes -t tts -z` for xAI text-to-speech. Saves the audio to the
output path provided by the caller (verified on disk before returning).

```
bridge/tts.sh "<text>" "<output_path>"
```

The wrapper instructs Hermes to:
- use ONLY the `text_to_speech` tool (toolset restricted via `-t tts`);
- speak the exact text supplied (no rewrites or translations);
- pick expressive vocal tags on its own - GemiX-Main does not bother
  emitting tags any more, so the model focuses on a single task and
  produces better-sounding output;
- save the file to the explicit absolute path we pass in (we never trust
  `~/voice-memos/` discovery - the host verifies the path itself).

Internals:
- `--yolo` to auto-approve the tool call without a TTY prompt
- `--ignore-rules` to skip AGENTS.md / SOUL.md / memory / preloaded skills
  injection (we don't want any of that mixing into the prompt)
- `-t image_gen` (resp. `video_gen`) to limit the toolset for the run
- An instruction appended to the user prompt that tells the model to reply
  with exactly one line containing only the URL - keeps stdout parseable
- A regex extraction as a safety net in case the model adds stray text

The script ALWAYS forwards Hermes' stderr to our stderr so logs stay useful
on the host even on success. The only thing that ever ends up on stdout is
the single URL line.

## Caller

`src/tools/imagineGenerator.js`:
1. spawns `bridge/imagine.sh image|video ...`
2. captures stdout and stderr
3. fetches the URL on success and pushes the bytes into
   `responseCtx.attachments` as a normal delivery-buffer attachment

## Notes / limitations

- Runs only on the production Linux VPS (the only environment GemiX supports).
- Reference images: supported via env vars (`IMAGINE_REF_CLAUSE` + `IMAGINE_REF_URLS`
  - see `imagine.sh` above). The CLI still can't take binary inputs directly, so
  the bytes are exposed through the attachment tunnel and xAI fetches them
  server-side from the URLs mentioned in the prompt.
- The CLI is invoked with `spawn` (no shell), so prompts are safe regardless
  of quoting / metacharacters. Reference URLs travel via the environment, never
  argv, so they can't be split or misparsed.

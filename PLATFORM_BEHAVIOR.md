# GemiX — Platform behavior matrix

Canonical reference for intentional differences across contexts. Runtime truth lives in `src/config/platformCapabilities.js`, `src/ai/tools.js` (`getToolsForUser`), and platform adapters.

## Profiles

| Profile | Platform constant | Ingress | History storage | Workspace | Memory |
|---------|-------------------|---------|-----------------|-----------|--------|
| WA personal | `whatsapp_personal` | 2-user chat; **`@gemix` in message body only** (quote-alone does **not** trigger) | `personal_<chatId>` | `group:personal:<chatId>` | **Shared** `memory_personal_<chatId>` |
| WA dedicated private | `whatsapp_dedicated` | All 1:1 messages | caller `waJid` | `user:<waJid>` | Per member `memory_<taskFileId>` |
| WA dedicated group | `whatsapp_dedicated` + `isGroup` | mention / reply to bot | `groupId` | `group:<groupId>` | Shared `memory_<groupId>` |
| Discord thread | `discord` | every message in GemiX forum thread | `channel.id` (per thread, isolated) | none | none (no `update_memory`) |

## Statute (Statuto Albertino)

| Platform | Mechanism |
|----------|-----------|
| Discord | Full text injected in system prompt as `<RulesContext>` via `loadRegolamento()` — **not** a tool |
| WhatsApp (active members) | Tool `read_server_rules` |

There is **no** embedding/RAG pipeline.

## System prompt layout (no duplicate limitations)

**Indentation:** top-level section bodies at 4 spaces; nested content (Platform children, Rules bullets) at 8 spaces. Built in `systemPrompt.js` + `platformCapabilities.js` (`_rulesBlock`).

| Section | Content |
|---------|---------|
| **Conversation → Platform** | Ingress rules; **`<Caller>`** on all profiles (who triggered the turn + active/non-active); personal **`<AccountOwner>`** (admin vs GemiX in history, no footer mechanics); optional **`<CallerAccess>`** when caller is not an active member; Discord **`<RulesContext>`**, optional **`<Emojis>`** / **`<Events>`** when non-empty in `ctx` |
| **Conversation → BatchNote** | When `batchMultiSpeaker`: merged turn; `<Caller>` = author of the latest message (permissions / task tools follow that author) |
| **ToolUsage** | Only tools in the live schema; operational notes (buffer, once-per-round, build, voice on dedicated, Discord title/PDF, …) |
| **Capabilities** | **WA only** (omitted on Discord). Catalog of non-obvious deliverables (`Documents: …`, `Media downloads: …`, image search/generation, charts, closing “try tools before refusing”). Lines are gated on live `toolNames`; no duplicate of obvious tool names (e.g. music). Not a second ToolUsage block. |
| **Limits** | Media duration caps; **`<Transcription>` note only on WA dedicated** (GemiX TTS voices in history); personal + Discord get the generic `read_file` on attachment tags line; Discord redirect (tell **the user** about dedicated WA for missing features) |
| **Memory / BuildWorkspace** | When applicable; shared vs per-user/group labels |
| **toolUnavailableMessage** | Runtime errors if the model calls a blocked tool (third person: “tell the user…”) |

Voice on **personal** is not in the schema and is **not** described in Platform (avoids implying `music_creator` / other tools are unavailable).

## Ingress & batch

- **While GemiX is answering**: new messages are **discarded**, not queued (see comments in `batchIngress.js` / `turnPipeline.js`).
- **Platform clients not ready**: personal WA waits for dedicated identity; Discord skips until `isReady()` — no queue (by design).
- **Debounce batch** (~2.5s, max 8s): rapid messages merge; quote window is recomputed **at batch fire** (`batchContentRefresh.js`).
- **Lock**: 5 min TTL + renew at batch fire (`batchIngress.js`, `turnPipeline.js`).

## Personal WA — history labeling (GemiX blocks)

On the admin account, chronological rules:

1. Block **starts** with fromMe **text containing the GemiX footer**.
2. Then any number of fromMe **attachment-only** messages (empty body / filename-only body stripped).
3. Block **ends** when: the other user writes; admin sends text without footer; admin sends media **with** caption text.

No message-count or time cap. Voice tool is disabled on personal so replies are text (+ attachments) and blocks stay consistent.

**Voice in history (personal):** user and Account Owner voice notes are attachment tags only (`read_file` to process). No `<Transcription>` wrapper and no `resolveGemixVoiceTranscription` on this platform (`historyTranscriptionNote: false`).

## Shared modules

- **`batchIngress.js`** — `enqueueBatchedTurn` (discard while locked, not queued)
- **`turnPipeline.js`** — batch → history → `handleMessage` → deliver
- **`quoteIngress.js`** — quoted replies; personal uses `buildPersonalGemixFlags` for quoted bot media
- **`personalWaHistory.js`** — GemiX vs Account Owner labels in personal history
- **`incomingMediaIngress.js`** — attachments → native parts + tags; `overDurationLimit` flag
- **`platformCapabilities.js`** — CAPS, prompt blocks, unavailable-tool messages

## History & media

### File delivery to the model (source: `src/utils/aiFileDelivery.js`)

| Mode | When | What the model sees |
|------|------|---------------------|
| **Tunnel** | PDF, images, audio, video (current turn or `read_file`) | `{type:'input_file', file_url:'https://…'}` via GemiX attachment tunnel — xAI runs vision/OCR/STT server-side on `/v1/responses` |
| **Inline text** | Text/code on **current** message (ingress) | `<FileContent path="…">` in user text (up to 200 KB) |
| **Tag only** | Office, archives, unknown binaries on ingress | `[Attachment: filename]` — use `read_file` (blocked for archives/office) or `build` / bash |
| **History text** | Older text/code in chat | On rebuild, same `deliverSyncedAttachment` as ingress: inline `<FileContent>` up to 200 KB when small enough; otherwise `[Attachment: …]` tag. `read_file` still applies 50 KB cap for on-demand loads |

Ingress path: `incomingMediaIngress.js` → `deliverSyncedAttachment()`. Discord/WA filenames without extension are normalized via `attachmentFilenames.resolveIngressFilename()`.

**Image tunnel cap:** `MAX_IMAGE_READS` (10) applies to `read_file` and build `read_file` only — not to unlimited tunnel images on current-turn ingress (by design).

- **MAX_HISTORY**: 50; quotes outside window → `REPLY_OUTSIDE_HISTORY_PREFIX`
- **History fetch timeout**: 15s; if incomplete, reference prune skipped; **age-only** prune (4h TTL on disk) runs on all platforms — stale files are removed; next successful history fetch re-syncs media from the last `MAX_HISTORY` messages
- **Discord attachments**: 25MB download cap in history rebuild
- **Footer on outbound**: WA personal GemiX text replies only
- **`[System]` in history**: WA dedicated private only
- **`<Transcription>` in history**: **WA dedicated only**, and only for **GemiX** `audio`/`ptt` after `send_voice_message` (text from `history_meta` / voice cache). End-user voice notes never get this wrapper. Personal and Discord do not inject it (`isGemixVoice` gated off on personal; Discord uses read_file / bot quote path without this Limits note).

| Profile | `historyTranscriptionNote` | Limits text |
|---------|--------------------------|-------------|
| WA personal | `false` | Use `read_file` on history attachment tags |
| WA dedicated (private/group) | `true` | GemiX voice messages may include `<Transcription>` |
| Discord | `false` | Same generic `read_file` line + dedicated-WA redirect |

---

## Tools reference

`getToolsForUser(isActiveMember, isAdmin, userCtx)` builds the live list. `code_interpreter` is native xAI (not in the function switch).

| Tool | Role | Platforms | Conditions / notes |
|------|------|-----------|-------------------|
| `web_x_search` | Research (web + X); optional images to buffer | All | Once per round |
| `read_file` | Read history attachment | All | |
| `code_interpreter` | xAI Python sandbox | WA only | Not Discord |
| `music_creator` | 30s music clip | WA only | **Available on personal** |
| `generate_image` / `generate_video` | Imagine | WA only | Once per round |
| `build` | Engineering sub-agent | WA only | Not Discord |
| `send_voice_message` | TTS voice | **WA dedicated only** | **Not** `whatsapp_personal` |
| `send_whatsapp_message` | WA to other recipient | WA + Discord | **Active member** |
| `send_email` | Email | WA + Discord | **Active member** |
| `schedule_tasks` / `read_my_tasks` / `remove_my_tasks` | Tasks | WA only | |
| `update_memory` | Long-term memory | WA only | Personal = shared chat file |
| `toggle_release_notify` | Release notify | WA only | |
| `read_server_rules` | Statute | WA only | **Active member** |
| `read_music_stats` | MusicBot stats | WA only | **Active member** |
| `generate_formal_request_pdf` | Art. 6 PDF | Discord only | |
| `set_conversation_title` | Thread title | Discord only | First turn only |
| `bug_report` | Admin report | All | |

### Active-member-only (runtime + schema)

`read_server_rules`, `read_music_stats`, `send_email`, `send_whatsapp_message`

Non-active callers: listed in `<CallerAccess>` (Conversation) when on WA; same list derived from live `toolNames` (not duplicated in Limits).

## Prompt audit scripts (repo `scripts/`)

Offline test utilities — no Hermes, no WhatsApp/Discord connection. Run from repo root with Node.

| Script | Purpose |
|--------|---------|
| `dump-prompt-case.js <1-15>` | Print one synthetic system prompt for the matching audit case (see case table in script header). |
| `regenerate-prompt-dumps.js` | Write all 15 prompts to `agent-tools/caseNN-dump.txt` and validate indent / banned lines. |
| `dump-tools-case.js <6\|9>` | Print JSON schemas for selected tools on dedicated private (6) vs group (9). |

Case IDs (prompt matrix): 1–5 personal WA; 6–8 dedicated private; 9–11 dedicated group; 12–15 Discord (first turn, follow-up, batch, emojis). Keep `CASES` in `dump-prompt-case.js` in sync when adding new prompt dimensions.

### ONCE_PER_ROUND

`read_music_stats`, `read_server_rules`, `web_x_search`, `generate_image`, `generate_video`, `build`
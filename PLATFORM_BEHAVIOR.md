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

| Section | Content |
|---------|---------|
| **Conversation → Platform** | Ingress rules, caller, account-owner note (personal), optional `<CallerAccess>` when caller is not an active member |
| **ToolUsage / Capabilities** | Only tools present in the live schema (`getToolsForUser`) |
| **Limits** | Media duration caps; **`<Transcription>` note only on WA dedicated** (GemiX TTS voices in history); personal + Discord get the generic `read_file` on attachment tags line; Discord redirect (tell **the user** about dedicated WA for missing features) |
| **toolUnavailableMessage** | Runtime errors if the model calls a blocked tool (third person: “tell the user…”) |

Voice on **personal** is not in the schema and is **not** described in Platform (avoids implying `music_creator` / other tools are unavailable).

## Ingress & batch

- **While GemiX is answering**: new messages are **discarded**, not queued.
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

- **MAX_HISTORY**: 50; quotes outside window → `REPLY_OUTSIDE_HISTORY_PREFIX`
- **History fetch timeout**: 15s; if incomplete, reference prune skipped; Discord still runs **age-only** prune (4h)
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

### ONCE_PER_ROUND

`read_music_stats`, `read_server_rules`, `web_x_search`, `generate_image`, `generate_video`, `build`
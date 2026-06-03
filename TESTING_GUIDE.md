# GemiX v2.0 - Comprehensive Testing Guide

**Purpose**: This document provides a complete checklist to verify that all features of GemiX work correctly after updates, refactors, or before production releases.

**Testing Philosophy**:
- Test from **all platforms** where possible: WhatsApp Dedicated, WhatsApp Personal, Discord.
- Always test both as **Admin** and **Active Member** (and non-member where applicable).
- For complex tools (especially `build` and Imagine), perform multiple tests with different configurations.
- Document any unexpected behavior with screenshots + exact prompt + attachments used.

**Current Date Note**: Today is the 1st of the month → Music Wrap notification has already been sent and verified.

---

## 1. General System Tests

### 1.1 Basic Conversation
- Test normal multi-turn conversation
- Test memory recall (`update_memory` + asking about stored info)
- Test language switching via memory
- Test emoji usage policy (should be sparing by default)

### 1.2 Maintenance Mode
- Enable `MAINTENANCE_MODE=true`
- Test as non-admin → should receive maintenance message
- Test as admin → should still work normally
- Test scheduled tasks during maintenance

### 1.3 System Messages & History
- Verify that scheduled reminders / wraps / releases appear with `[System]` tag **only in dedicated WA private 1:1 chats** (not personal admin WA, not groups, not Discord)
- Test that the bot correctly ignores `[System]` messages in history
- Test release notifications (if a new release is available)

### 1.4 Attachments & History
- Send files (with and without caption/text) on WA dedicated + personal. Verify:
  - No duplicate "current user message" turns in the prompt sent to the model.
  - Pure attachment (no text) does not inject the filename as fake user text.
  - Text files (.txt, .js, etc.) inline as `<FileContent path="...">` (no preceding `[Attachment]` tag for the *current* turn).
  - `<FileContent>` does not include a `size="..."` attribute.

---

## 2. Core Tool Testing

### 2.1 web_x_search
**Test Cases**:
1. Basic research query
2. `full_team=true` (4x multi-agent)
3. `search_images=true` (should return images + save them)
4. Fact-checking with date constraints
5. Query requiring X (Twitter) posts

**Attachments**: None usually needed.

**Platforms**: All

### 2.2 read_file
**Test Cases**:
1. Read text file from history → `<FileContent>` in tool result
2. Read PDF from history → tool returns text + `input_file` tunnel URL (dual parts); model/xAI processes PDF server-side
3. Read image → tunnel URL (dual parts); vision on xAI side; **max 10 images per main-brain turn** via repeated `read_file`
4. Read audio → tunnel URL; transcription/STT on xAI side (not local STT in Node)
5. Try to read non-existent file
6. Tunnel validation failure (oversize / too long) → attachment tag in history/current turn includes explicit error note in parentheses (not silent tag-only)

**Attachments**: Send various media types in previous messages.

### 2.3 send_voice_message
**Platforms**: **WA dedicated only** (private + group). **Do not test on WA personal** — tool is absent from schema; model should reply with text + attachments only.

**Test Cases**:
1. Normal voice message (current chat) — dedicated private
2. Voice message to another member (as admin/active member)
3. Voice message with `includeAttachments=true`
4. Very long text (should be truncated or handled gracefully)

**Attachments**: Test with and without buffered files.

**Personal regression**: On personal admin chat, ask GemiX (with `@gemix`) to send a voice → tool must not appear / call must be rejected; reply should be text (+ files if any). Confirm `music_creator` still works on personal.

### 2.4 send_whatsapp_message / send_email
**Test Cases** (Admin only for external):
- Send to self
- Send to another active member
- Send to external contact (admin only)
- Send with attachments

**Note**: Test both WhatsApp and Email delivery.

### 2.5 schedule_tasks + read_my_tasks + remove_my_tasks
**Test Cases**:
1. One-time reminder (current chat)
2. Recurring daily/weekly task
3. Task for another member (admin)
4. Group task (WhatsApp groups)
5. Read tasks (filter by group/personal)
6. Remove specific tasks

**Complex**: Create multiple recurring tasks and verify they fire correctly over time.

---

## 3. Media Generation Tools

### 3.1 generate_image + generate_video
**Test Cases** (multiple configurations):

**Basic**:
- Simple image prompt
- Simple video prompt (10s)

**Reference Images** (most important):
1. 1 reference image → image-to-image
2. 1 reference image → image-to-video
3. 3 reference images → image-to-image (style/subject consistency)
4. 5 reference images → video (reference-to-video)
5. Mix of history files + current turn attachments as references

**Aspect Ratio**:
- Test `16:9`, `9:16`, `1:1`, `4:3`

**Attachments Strategy**:
- Send reference images in the same message
- Send reference images in previous messages (history)
- Use images previously generated by GemiX

### 3.2 music_creator
**Test Cases**:
1. Basic music prompt
2. Very specific style + instruments
3. Test length (should be ~30 seconds)

---

## 4. Build Agent & Skills (Most Critical Area)

The `build` tool is the most complex. It must be tested extensively with real skills.

### 4.1 General Build Agent Behavior
- Simple text file creation
- Multi-step task with several tool calls
- Task requiring code execution (`code_interpreter`)
- Task that exceeds quota (should fail gracefully)
- Very long-running task (test round budget)

### 4.2 Skills Testing Matrix

For **each skill**, test the following:

#### **docx Skill**
- Create new document from scratch
- Fill a template (use `fill_template.js`)
- Edit existing document (accept/reject changes)
- Convert to PDF
- Complex document with TOC, footnotes, images

**Test files to attach**:
- `docx/templates/*.docx` (if any)
- Reference images

#### **pdf Skill**
- Fill PDF forms
- Create PDF from scratch (reportlab)
- Merge PDFs
- Extract text from PDF
- Convert PDF to images (for verification)

#### **pptx Skill**
This is one of the most complex — test thoroughly:

- Use existing templates from `pptx/templates/`
- Create presentation from scratch
- Edit existing presentation
- Add charts, tables, images
- Use `search_templates.py` + render

**Important**: Test multiple templates.

#### **xlsx Skill**
- Create spreadsheet with formulas
- Read existing Excel
- Generate charts
- Complex data processing

#### **ffmpeg Skill**
- Audio conversion (mp3 → ogg/opus)
- Video trimming / basic editing
- Extract audio from video
- Generate waveform / thumbnail

**Test with real media files** (send voice messages, videos, etc.).

### 4.3 Advanced Build Scenarios
1. **"Create a full report"** — PDF + DOCX + images + charts
2. **"Build a presentation from research"** — web_x_search → build pptx
3. **"Process uploaded files"** — attach PDFs/images → extract + generate new document
4. **"Multi-skill pipeline"** — e.g. extract data from Excel → create PPTX → generate PDF summary

---

## 5. Attachments & Media Pipeline

### 5.1 Attachment Collision & Renaming
- Send two files with the same name in one message
- Send file that already exists in history
- Verify the agent receives correct `<AttachmentNotes>`

### 5.2 History vs Current Turn Attachments
- Use files from previous conversations
- Use files from current message
- Mix of both as reference images for Imagine / Build

### 5.3 Tunnel Attachments (`localtunnel`)
- Generate image/video → verify it is accessible via public URL
- **Incoming** WA/Discord attachments and **`read_file`** on history media use the same tunnel (`input_file` URL), not base64 in API bodies
- Imagine reference images use tunnel URLs to the CLI (no base64 to Hermes)
- Send large file → verify fallback message with temporary link works
- API request logs: `requestAttachments` shows `tunnel_url` / `input_file`, not `base64:…` placeholders

### 5.4 Voice Message Pipeline
- **Dedicated WA — user voice**: history shows voice attachment tag only (no `<Transcription>`); model uses `read_file` on the tag when needed
- **Dedicated WA — GemiX voice**: `send_voice_message` delivers; history/quoted GemiX audio may include `<Transcription>…</Transcription>` when TTS text is stored (`history_meta` / voice cache)
- **Personal**: no `send_voice_message`; GemiX replies text + files only; user/Account Owner voice = tag + `read_file` only; system prompt **Limits** must **not** mention `<Transcription>`

---

## 6. Platform-Specific Tests

### 6.1 WA Personal (admin account)

| Test | Expected |
|------|----------|
| Message **without** `@gemix` | No GemiX reply |
| Message with `@gemix` | Turn runs |
| **Quote-only** reply to GemiX (no `@gemix`) | **No** turn (ingress requires `@gemix` in body) |
| Quote-only **with** `@gemix` in body | Turn runs; quote context rebuilt at batch fire |
| Rapid multi-message burst | Single merged turn; lock not lost at fire |
| GemiX text + footer then 2+ file-only messages | History labels all as **GemiX** (not Account Owner) |
| Admin file with **caption** after GemiX burst | Block ends; caption message = Account Owner |
| Other user writes between GemiX files | GemiX block ends |
| `music_creator` / `build` / imagine | Tools available (not confused with missing voice) |
| Inspect **Limits** in system prompt | No line about `<Transcription>`; generic `read_file` on attachment tags only |
| User or admin sends voice note | History tag only; no `<Transcription>` in rebuilt history |
| Non-active caller | No `send_email` / `send_whatsapp_message` / statute / music stats in schema; `<CallerAccess>` in prompt |
| Active member caller | Delivery + statute tools available |

### 6.2 WA Dedicated
- Group: mention or reply-to-bot required
- Private: every message
- Voice (`send_voice_message`) works
- GemiX voice in history may show `<Transcription>`; user voice does not
- **Limits** in prompt mentions GemiX voice + `<Transcription>` (not generic “any voice attachment”)
- `[System]` only in dedicated **private** 1:1 history labels

### 6.3 Discord
- Statute via `<RulesContext>` in prompt (no `read_server_rules` tool)
- `set_conversation_title` forced on first thread message only
- Thread storage isolated per `channel.id`
- User asks for voice/build/schedule → model should explain dedicated WA (not offer those tools)
- History prune age-only (4h) if history fetch times out

---

## 7. Scheduler & Notifications

- Create recurring task → verify it fires
- Create one-time task for future
- Test task for another user (admin)
- Verify Music Wrap (already tested this month)
- Test Release Notifications (if applicable)

---

## 8. Error Handling & Edge Cases

- Send invalid arguments to tools
- Try to use admin-only tools as non-admin
- Try to use tools as non-active member
- Send extremely large files
- Send corrupted files
- Long conversation (test context window / pruning)
- Maintenance mode + scheduled tasks

---

## 9. Build Agent Specific Stress Tests

- Task that requires many rounds (near `BUILD_MAX_ROUNDS`)
- Task that writes many files (quota testing)
- Task using `bash` with complex commands (yt-dlp, ffmpeg, libreoffice)
- Task that uses skills + external research (`web_x_search`)
- Task with reference images passed via attachments

---

## 10. Regression Checklist (Quick)

- [ ] All tools appear in schema when they should (per platform + active member)
- [ ] Personal: no `send_voice_message`; dedicated: has voice
- [ ] Non-active member: missing tools match `<CallerAccess>` / tool errors
- [ ] Memory updates persist across restarts (personal = shared `memory_personal_<chatId>`)
- [ ] Attachments from history are still usable
- [ ] Proxy allowlist is respected (try downloading from blocked domain)
- [ ] Tunnel attachments work
- [ ] Dedicated: GemiX TTS voice may have `<Transcription>` in history; user voice = tag only
- [ ] Personal: no `<Transcription>` in Limits or history; GemiX block labeling correct

## 11. Post-refactor verification pack (2026-06)

Run after changes to batch, personal history, tools, or prompts.

### A. Prompt / tools coherence
1. Personal + active member: inspect system prompt — no `send_voice_message` in ToolUsage; `music_creator` present if expected.
2. Personal + non-active: `<CallerAccess>` lists only missing member tools (not voice).
3. Personal **Limits**: no `<Transcription>` line; dedicated **Limits**: “GemiX voice messages…” + `<Transcription>` only.
4. Discord: Limits mention telling **the user** about dedicated WA; no `<Transcription>` line; no first-person “use the dedicated account” as if the model should switch accounts.

### B. Batch & lock
1. Send 3 quick messages on personal with `@gemix` → one reply.
2. While GemiX is typing, send another message → **ignored** (not queued).
3. Quote a message sent 5s earlier in same burst → quote content present in merged turn.

### C. Personal history blocks
1. Trigger GemiX with text+footer + 2 PDFs (file-only WA messages).
2. Reload / next `@gemix` turn: history shows **GemiX** for text and both files.
3. Admin sends image **with caption** right after → labeled Account Owner.

### D. Tool guards
1. Personal: hallucinated `send_voice_message` → clear error; text reply still possible.
2. Discord: `build` / `music_creator` blocked with “tell the user…” dedicated WA wording.
3. Non-active: `send_email` blocked on WA and Discord.

### E. Media ingress
1. Audio > max duration → `(too long…)` note, not sent as native part.
2. Unsupported WA sticker type → `[Attachment: …]` tag shape (not bare `[file.ext]`).
3. Office doc on **current** message → tag-only, not tunneled to model (no base64 in API calls).

**Document Version**: 2026-06-03  
**Last Major Update**: Unified `aiFileDelivery` policy (tunnel / inline / tag-only), docs aligned with xAI server-side media processing

---

## Testing Order Recommendation

1. **Basic conversation + memory**
2. **Simple tools** (`web_x_search`, `read_file`)
3. **Media generation** (Imagine + Music)
4. **Delivery tools** (voice, wa, email)
5. **Scheduler**
6. **Skills** (start with simpler: xlsx, docx → then pptx, pdf)
7. **Build agent** (most complex — do last)
8. **Cross-platform + edge cases**

---

When performing tests, always note:
- Platform used
- User role (Admin / Active Member)
- Exact prompt
- Attachments used (with filenames)
- Result (success / partial / failure + error message)

This document should be updated after every major change or release.
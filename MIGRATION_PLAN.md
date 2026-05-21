# Piano migrazione GemiX → Hermes (xAI Grok via SuperGrok OAuth)

Documento di pianificazione e tracking della migrazione totale dell'ecosistema AI di GemiX dal mix attuale (OpenRouter / xAI key diretta / Gemini / SearXNG / Lyria) al solo proxy **Hermes Agent** che parla con Grok via abbonamento SuperGrok.

---

## 1. Stato attuale (mappato dalla codebase)

### 1.1 Punto di ingresso AI unico
Tutta la chat principale passa per **una sola funzione**: `callAI` in `src/ai/aiProvider.js`. Sotto il cofano:
- transport `fetch` raw via `src/ai/apiClient.js` (`callModel`/`callApiWithRetry`),
- `HERMES_BASE_URL = 'http://127.0.0.1:8000/v1'` da `.env`,
- bearer `HERMES_API_KEY` da `.env`,
- modello unico `GROK_MODEL` da `.env`.

### 1.2 Sub-chiamate AI sparse
| File | Modello / endpoint | Scopo | Stato |
|---|---|---|---|
| `src/ai/audioTranscriber.js` | Hermes `/v1/stt` (xAI STT) | Trascrive audio prima della call principale | ✅ Attivo (Step 3) |
| `src/ai/audioProcessor.js` | — | Walk messages, sostituisce audio con `<Transcription>` | ✅ Attivo |
| `src/ai/videoDescriber.js` | `VIDEO_DESCRIBER_MODEL` (Gemini via OpenRouter) | Descrive video prima della call principale | ✅ Attivo |
| `src/tools/webXSearch.js` | `MULTI_AGENT_MODEL` via Hermes `/v1/responses` | Ricerca web + X/Twitter delegata al team multi-agent | ✅ Attivo (Step 2/3) |
| `src/tools/musicCreator.js` | `MUSIC_MODEL` (Lyria via OpenRouter) | Generazione musica streaming SSE | ⚠️ Mantenuto su OpenRouter |
| `src/tools/voiceMessage.js` | Hermes `/v1/tts` (xAI TTS) | TTS vocale | ✅ Attivo (Step 3) |
| `src/tools/imagineGenerator.js` | Hermes `/v1/images/generations` + `/v1/videos/generations` (Grok Imagine) | Generazione immagini/video | ✅ Attivo (Step 7) |

### 1.3 Web search (post Step 2)
- `src/tools/webXSearch.js` → `grok-4.20-multi-agent` via `POST https://api.x.ai/v1/responses` con tool nativi `web_search` + `x_search`. Copre anche il page-browsing (incluso in `web_search` xAI).
- `src/tools/imageSearch.js` → SearXNG self-hosted (`SEARXNG_URL=http://localhost:8888`). Mantenuto: xAI non espone un endpoint di ricerca immagini.
- ❌ `src/tools/webSearch.js` — eliminato (Step 2).
- ❌ `src/tools/browsePage.js` — eliminato (Step 2).

### 1.4 Logica agentic_unlock
Quando la AI invoca il tool `agentic_unlock`:
- `userCtx.agenticUnlocked = true`,
- la lista tool viene ricostruita (rimuove gateway, aggiunge `write_file`, `edit_file`, `bash`, `attach_file`),
- viene appeso al system prompt il `agenticBriefing` (tutto lo stato progetti + skills + sandbox layout),
- round budget: 5 → 20.

FAST e AGENTIC sono lo stesso modello Grok 4.3. Il flag `agenticUnlocked` controlla solo la tool list visibile, l'iniezione del briefing e il round budget.

---

## 2. Step 1 — Migrazione a Hermes (completato: 2026-05-19)

### 2.1 Cosa è cambiato
1. **Configurazione Hermes** in `.env`: `HERMES_BASE_URL`, `HERMES_API_KEY`, `GROK_MODEL`.
2. **`src/config/constants.js`**: `OPENROUTER_BASE_URL` mantenuta solo per Lyria/video describer.
3. **`src/config/env.js`**: rimosse `OPENROUTER_API_KEY` (mantenuta solo per Lyria/video), `FAST_MODEL`, `AGENTIC_MODEL`, `EMBEDDING_MODEL`, `BROWSE_PAGE_MODEL`, `MEDIA_DESCRIBER_MODEL`. Aggiunte `HERMES_BASE_URL`, `HERMES_API_KEY`, `GROK_MODEL`.
4. **`src/ai/aiProvider.js`**: usa `GROK_MODEL` per entrambe le modalità, provider `'Grok'`.
5. **Eliminati**: `src/ai/mediaDescriber.js`, `src/ai/pageSummarizer.js`, `src/rag/regolamentoRag.js`.
6. **`src/tools/browsePage.js`**: summarizer inline su Hermes (poi eliminato in Step 2).
7. **Discord RAG**: regolamento iniettato full-context in `<RulesContext>` via `src/utils/regolamento.js`.
8. **`src/ai/tools.js`**: rimosso `TOOL_MUSIC_CREATOR` dalla lista tool (music_creator rimane nel dispatcher ma non viene offerto al modello).
9. **`src/ai/systemPrompt.js`**: `<MediaHandling>` aggiornato.
10. **`src/utils/footer.js`**: display name → Grok.

### 2.2 Variabili `.env` post Step 1
```dotenv
HERMES_BASE_URL=http://127.0.0.1:8000/v1
HERMES_API_KEY=dummy
GROK_MODEL=grok-4.3-latest
XAI_API_KEY=...
XAI_TTS_VOICE=leo
XAI_TTS_ENABLED=true
SEARXNG_URL=http://localhost:8888
OPENROUTER_API_KEY=...
MUSIC_MODEL=google/lyria-3-clip-preview
VIDEO_DESCRIBER_MODEL=google/gemini-2.5-flash-lite
```

**Variabili rimosse**: `FAST_MODEL`, `AGENTIC_MODEL`, `EMBEDDING_MODEL`, `BROWSE_PAGE_MODEL`, `MEDIA_DESCRIBER_MODEL`.

---

## 3. Step 1.5 — Media pre-processing (completato: 2026-05-19)

Grok 4.3 via Hermes non ingerisce audio/video nativamente in modo affidabile. Reintrodotto pre-processing dedicato.

### Audio — xAI STT via Hermes (`/v1/stt`)
- `src/ai/audioTranscriber.js`: chiama `${HERMES_BASE_URL}/stt` con `HERMES_API_KEY` (Step 3 ha rimosso la chiamata diretta a `api.x.ai`).
  - `language: 'auto'`, `format: 'true'` (ITN). Risposta JSON: `result.text`.
- `src/ai/audioProcessor.js`: walk messages, sostituisce ogni audio part con `<Transcription>…</Transcription>`.
  - Supporta `input_audio` e `image_url` con MIME `audio/*`.
  - Duration cap via `ffprobe` (`MAX_AUDIO_DURATION_S = 120s`).
  - Cache trascrizioni in history.

### Video — Gemini via OpenRouter
- `src/ai/videoDescriber.js`: chiama `OPENROUTER_BASE_URL/chat/completions` con `VIDEO_DESCRIBER_MODEL`.
  - Formato: `{ type: 'video_url', video_url: { url: 'data:video/*;base64,...' } }`.
  - Duration cap (`MAX_VIDEO_DURATION_S = 15s`). Cache descrizioni in history.
  - Risposta JSON schema: `{ description: string }`.

### Integrazione
- `src/handler.js`: `describeVideoInMessages` + `processAudioInMessages` prima del loop AI.

---

## 4. Step 2 — Eliminazione SearXNG per web/X search (completato: 2026-05-19)

### 4.1 Obiettivo
Eliminare la dipendenza da SearXNG per la ricerca web e X/Twitter, sfruttando i tool nativi xAI (`web_search`, `x_search`) tramite `grok-4.20-multi-agent`. Il modello principale (Grok 4.3) non chiama i tool xAI nativi direttamente — li delega al team multi-agent.

### 4.2 Architettura
```
Grok 4.3 (Hermes /v1/chat/completions)
  └─ chiama tool: web_x_search(prompt, effort)
       └─ POST {HERMES_BASE_URL}/responses
            model: grok-4.20-multi-agent
            tools: [web_search, x_search]   ← tool nativi xAI server-side
            → ResearchReport con citations
```

Il `web_search` xAI include già il page-browsing, quindi `browse_page` è ridondante.

### 4.3 Cosa è cambiato

| File | Azione | Note |
|---|---|---|
| `src/tools/webXSearch.js` | ✅ Creato | Multi-agent caller, retry 2×, timeout 5min, parsing output+citations |
| `src/tools/webSearch.js` | 🗑️ Eliminato | Sostituito da `webXSearch` |
| `src/tools/browsePage.js` | 🗑️ Eliminato | Page-browsing incluso in `web_search` xAI |
| `src/ai/tools.js` | ✅ Aggiornato | Rimossi `TOOL_WEB_SEARCH`/`TOOL_BROWSE_PAGE`, aggiunto `TOOL_WEB_X_SEARCH` |
| `src/tools/index.js` | ✅ Aggiornato | Dispatcher: `web_x_search` sostituisce i due case precedenti; `ONCE_PER_ROUND_TOOLS` impedisce chiamate duplicate nello stesso round |
| `src/handler.js` | ✅ Aggiornato | `AGENTIC_TOOL_NAMES`, `DEFERRED_TOOL_NAMES` aggiornati |
| `src/ai/agenticBriefing.js` | ✅ Aggiornato | Esempio in `<ExecutionPhases>` |
| `src/config/env.js` | ✅ Aggiornato | Aggiunta `MULTI_AGENT_MODEL` |
| `src/utils/fetch.js` | ✅ Aggiornato | Commenti docstring |
| `.env` | ✅ Aggiornato | Aggiunta `MULTI_AGENT_MODEL=grok-4.20-multi-agent` |

### 4.4 Cosa NON è cambiato
- **`image_search`**: continua su SearXNG. xAI non espone un endpoint di ricerca immagini.
- **`SEARXNG_URL`**: rimane in `.env` e `env.js` (usato da `imageSearch.js`).
- **TTS/STT**: invariati.
- **Hermes**: rimane il transport unico per la chat principale.

### 4.5 Variabili `.env` post Step 2
```dotenv
# Aggiunta
MULTI_AGENT_MODEL=grok-4.20-multi-agent

# Mantenuta (solo per image_search)
SEARXNG_URL=http://localhost:8888
```

### 4.6 Edge case gestiti
1. **`HERMES_API_KEY` assente**: tool ritorna `{success: false, error: ...}` senza crash.
2. **`MULTI_AGENT_MODEL` assente**: idem.
3. **Timeout multi-agent** (>5min): errore retryable, notifica admin, risposta esplicita al modello.
4. **Risposta vuota**: errore esplicito, il modello può ritentare con prompt più specifico.
5. **Prompt > 4000 char**: troncato, marcato `truncated_prompt="true"` nell'XML.
6. **`effort` invalido**: coerced a `'low'` (default sicuro).
7. **Citations assenti**: `citations="0"` nell'XML, nessun crash.

### 4.7 Note architetturali
- `web_x_search` chiama `${HERMES_BASE_URL}/responses` (Step 3 ha unificato l'auth: stesso `HERMES_API_KEY` di tutto il resto).
- Le call `effort=high` possono durare 2-4 minuti. Usare `low` come default.
- `web_x_search` è in `ONCE_PER_ROUND_TOOLS` in `tools/index.js`: se il modello chiama lo stesso tool più volte nello stesso round (es. due `web_x_search` identici), la seconda chiamata viene bloccata con un errore esplicito. Questo vale anche per `read_music_stats`, `read_server_rules` e `agentic_unlock`.

### 4.8 Checklist Step 2
- [x] `src/tools/webXSearch.js` — creato e verificato
- [x] `src/tools/webSearch.js` — eliminato
- [x] `src/tools/browsePage.js` — eliminato
- [x] `src/ai/tools.js` — aggiornato
- [x] `src/tools/index.js` — aggiornato (`ONCE_PER_ROUND_TOOLS`)
- [x] `src/handler.js` — aggiornato
- [x] `src/ai/agenticBriefing.js` — aggiornato
- [x] `src/config/env.js` — `MULTI_AGENT_MODEL` aggiunto
- [x] `src/utils/fetch.js` — commenti aggiornati
- [x] `.env` — `MULTI_AGENT_MODEL` aggiunto
- [x] `node --check` su tutti i file modificati: OK
- [x] `getDiagnostics` su tutti i file modificati: nessuna diagnostica
- [x] Grep finale: zero riferimenti residui a `webSearch`/`browsePage` in `src/`
- [ ] **Da fare sul VPS dopo deploy**: `pm2 restart "GemiX"`, smoke test live (ricerca web + X)

---

## 5. Step 3 — Eliminazione `XAI_API_KEY` (completato: 2026-05-20)

### 5.1 Obiettivo
Rimuovere completamente la dipendenza da `XAI_API_KEY` e da `https://api.x.ai/...` come endpoint diretti. Tutte le funzionalità xAI (TTS, STT, multi-agent research) ora passano dal proxy Hermes con `HERMES_API_KEY`, esattamente come la chat principale Grok 4.3.

### 5.2 Cosa è cambiato

| File | Azione | Note |
|---|---|---|
| `src/ai/audioTranscriber.js` | ✅ Aggiornato | `XAI_STT_URL` → `${HERMES_BASE_URL}/stt`, auth con `HERMES_API_KEY` |
| `src/tools/webXSearch.js` | ✅ Aggiornato | `XAI_RESPONSES_URL` → `${HERMES_BASE_URL}/responses`, auth con `HERMES_API_KEY` |
| `src/tools/voiceMessage.js` | ✅ Aggiornato | `XAI_TTS_URL` → `${HERMES_BASE_URL}/tts`, auth con `HERMES_API_KEY` |
| `src/config/env.js` | ✅ Aggiornato | Rimossa export `XAI_API_KEY` |
| `src/config/constants.js` | ✅ Aggiornato | Rimossa costante `XAI_TTS_URL` |
| `.env` | ✅ Aggiornato | Rimossa `XAI_API_KEY` |
| `SERVER_SETUP.md` | ✅ Aggiornato | Endpoint Hermes elencati: `/tts`, `/stt`, `/responses`, `/chat/completions` |

### 5.3 Architettura post Step 3
Tutte le chiamate verso xAI passano da Hermes:

```
GemiX
  ├─ chat principale → POST {HERMES_BASE_URL}/chat/completions  (model: GROK_MODEL)
  ├─ web_x_search    → POST {HERMES_BASE_URL}/responses         (model: MULTI_AGENT_MODEL)
  ├─ STT audio       → POST {HERMES_BASE_URL}/stt
  └─ TTS voce        → POST {HERMES_BASE_URL}/tts
```

Tutte autenticate con lo stesso `HERMES_API_KEY` (placeholder `dummy`: il proxy ignora la chiave e usa il token OAuth SuperGrok interno).

### 5.4 Edge case gestiti
1. **`HERMES_API_KEY` assente**: ognuna delle tre funzioni ritorna `null` o errore strutturato senza crash. Il check è già presente in tutti e tre i file.
2. **Hermes proxy down**: `audioTranscriber` ritorna `null` (e il messaggio "transcription unavailable (service error)" viene iniettato), `webXSearch` notifica admin e ritorna errore al modello, `voiceMessage` cade automaticamente sul fallback Google Translate (per il TTS) o notifica admin.
3. **`XAI_TTS_ENABLED=false`**: il fallback Google Translate continua a funzionare invariato (la flag controlla solo se tentare il TTS xAI prima del fallback).
4. **Hermes proxy non risponde a `/tts`/`/stt`/`/responses`**: errori HTTP normali, retry/notifica admin invariati. Se il proxy non monta questi endpoint, occorre aggiornare la config del proxy lato VPS — NON serve toccare la codebase.

### 5.5 Note architetturali
- **Single point of failure**: ora se Hermes va giù, anche TTS/STT/research vanno giù. Prima alcune di queste funzionavano anche senza Hermes (chat principale a parte). Trade-off accettato per zero chiavi API a pagamento nel repo.
- **`XAI_TTS_VOICE` resta**: è solo il voice id (`leo`, `eve`, ecc.), non una credenziale. Mantenuto in `.env`.
- **`XAI_TTS_ENABLED` resta**: flag operativa per disattivare il TTS xAI quando il proxy non lo supporta o si vuole forzare il fallback Google Translate. Mantenuta in `.env`.

### 5.6 Variabili `.env` post Step 3
**Rimossa**: `XAI_API_KEY`.

```dotenv
# AI API - XAI features fronted by Hermes (TTS/STT + multi-agent research)
# Endpoints: ${HERMES_BASE_URL}/tts, /stt, /responses
XAI_TTS_VOICE=leo
MULTI_AGENT_MODEL=grok-4.20-multi-agent

# SYSTEM MODES
XAI_TTS_ENABLED=true
```

### 5.7 Checklist Step 3
- [x] `src/ai/audioTranscriber.js` — migrato a Hermes
- [x] `src/tools/webXSearch.js` — migrato a Hermes
- [x] `src/tools/voiceMessage.js` — migrato a Hermes
- [x] `src/config/env.js` — `XAI_API_KEY` rimossa
- [x] `src/config/constants.js` — `XAI_TTS_URL` rimossa
- [x] `.env` — `XAI_API_KEY` rimossa
- [x] `SERVER_SETUP.md` — endpoint Hermes documentati
- [x] `node --check` su tutti i file modificati: OK
- [x] `getDiagnostics` su tutti i file modificati: nessuna diagnostica
- [x] Grep finale: zero riferimenti a `XAI_API_KEY` o `api.x.ai` in `src/`
- [ ] **Da fare sul VPS dopo deploy**: verificare che il proxy Hermes esponga `/v1/tts`, `/v1/stt`, `/v1/responses`. Se no, aggiornare config Hermes. Poi `pm2 restart "GemiX"` e smoke test (vocale, transcript, ricerca web).

---

## 6. Step 4 — Capacità di contesto e history (completato: 2026-05-20)

### 6.1 Verifica del compromesso media in history
**Pattern attuale** (verificato leggendo `src/platforms/whatsapp/shared.js` e `src/platforms/discord/client.js`):
- Solo il turno corrente passa media binari come content multimodale (via `mediaToContentPart` in `buildIncomingContentParts` / Discord client). Le quote/reply allo stesso messaggio possono includere il media originale come parte multimodale, sempre solo per il turno attivo.
- Tutta la cronologia precedente è puro testo: ogni messaggio è una stringa `[DD/MM/YYYY, HH:MM] Sender: …` che incorpora `[Attachment: history/<file>]`, eventualmente arricchita con `<Transcription>`/`<Description>` cached. Niente base64 viene mai ri-iniettato per i turni vecchi.
- L'AI per accedere a un media più vecchio chiama `read_file` sul path indicato dal tag `[Attachment: …]`.

✅ Compromesso già rispettato: niente da modificare.

### 6.2 Cap output e context window
- **`MAX_TOKENS`**: alzato da `8192` a `64_000`. Grok 4.3 supporta context window molto ampia (1M+ token in input, output limit elevato); 64k come output cap è un compromesso tra completezza delle risposte agentiche lunghe e costi.
- **`MAX_HISTORY`**: alzato da `15` a `50` messaggi. Più contesto significa che l'AI rimane consapevole di richieste fatte qualche turno indietro senza dover ricostruire il contesto a ogni round.

Nessuno dei due valori richiede modifiche al transport o ad altri file: vengono letti rispettivamente da `aiProvider.js` e dai costruttori di history su WhatsApp/Discord.

### 6.3 Edge case verificati
1. **History con `[Attachment: …]` non più presente su disco**: il GC esistente (`pruneHistory` in `historySync.js`) cancella i file unreferenced, e il messaggio history conserva il tag testuale come traccia. `read_file` su un path mancante ritorna errore strutturato. OK.
2. **Reply a messaggio fuori dalla cronologia recente**: `extractQuotedMessageContent` (WhatsApp) e il blocco `replyPrefix` (Discord) decidono se reidratare il media. Già protetti da `isQuotedInRecentHistory` per evitare di trasportare base64 vecchi senza necessità.
3. **`<Description>` legacy**: messaggi vecchi possono avere `<Description kind="audio|video">` già nel testo (cache da Step 1.5). Grok li tratta come testo plain — coerente con il prompt aggiornato in `<MediaHandling>`.

---

## 7. Step 5 — RAG embeddings (rimandato)

In standby. Sarà ripreso solo quando si vorrà estendere il RAG ad altri corpora oltre al regolamento Discord (full-context).

---

## 8. Step 6 — Tool `music_creator` (mantenuto)

`music_creator` rimane attivo e visibile al modello su WhatsApp. Funziona via OpenRouter con il modello Lyria di Google. Nessuna modifica prevista.

---

## 9. Step 7 — Image/video generation (completato: 2026-05-20)

### 9.1 Obiettivo
Esporre Grok Imagine come due tool nativi GemiX (`generate_image` e `generate_video`) tramite il proxy Hermes (`/v1/images/generations` e `/v1/videos/generations`). Entrambi sono disponibili per qualsiasi utente (membro attivo o no), in modalità agentic e non, su tutte le piattaforme **eccetto Discord**.

### 9.2 Architettura
```
Grok 4.3 (Hermes /chat/completions)
  ├─ chiama function tool: generate_image(prompt, reference_images?, aspect_ratio?)
  │    └─ POST {HERMES_BASE_URL}/images/generations  (model: IMAGE_GEN_MODEL)
  │         response_format: "b64_json"
  │         → buffer PNG → responseCtx.attachments → AUTO-DELIVERED
  │
  └─ chiama function tool: generate_video(prompt, reference_images?, aspect_ratio?)
       └─ POST {HERMES_BASE_URL}/videos/generations  (model: VIDEO_GEN_MODEL)
            duration: 10, resolution: "720p", n: 1, response_format: "b64_json"
            → buffer MP4 → responseCtx.attachments → AUTO-DELIVERED
```

Backend fissa i parametri "tecnici" (`n=1`, `duration=10`, `resolution=720p`, `response_format=b64_json`), il modello sceglie solo `prompt`, `reference_images` e `aspect_ratio`.

### 9.3 Reference images
`reference_images` accetta path ai file che l'AI può già vedere (stessa policy di `read_file` / `attach_file`):
- **Non-agentic**: nome file della chat history (es. `"foto.jpg"` o `"sub/foto.jpg"`). Il backend prefissa automaticamente `history/` per coerenza con `read_file`. Niente menzione di `/readonly/` o `/workspace/` nella description del tool — l'AI in non-agentic non li vede.
- **Agentic**: path assoluti (`/readonly/history/...`, `/readonly/searched_images/...`, `/workspace/{temp|output|code}/...`) **oppure** bare filename (auto-risolto a chat history come per `read_file`).

Il path viene validato da `isPathAllowed` (la stessa funzione usata da `read_file`/`attach_file`), letto da disco, controllato per estensione (PNG/JPG/JPEG/WEBP/GIF/BMP), MIME e dimensione (max 8 MB), e infine convertito in base64 prima dell'invio al proxy.

**Niente URL, niente buffer arbitrari**: l'AI non scarica immagini dal web — usa solo file già accessibili (sia che provengano da `image_search` con `save_to_disk=true`, da chat history, o da output di un progetto). Questo elimina download opachi e mantiene la superficie del tool coerente con il resto della codebase.

### 9.4 Limiti hard-coded
| Tool | Max ref images | Aspect ratios | Output |
|---|---|---|---|
| `generate_image` | 3 | `1:1`, `16:9`, `9:16`, `4:3`, `3:4` (omesso = automatico) | PNG |
| `generate_video` | 7 (1 → image-to-video, 2-7 → reference-to-video) | `16:9` (default), `9:16`, `1:1` | MP4 720p, 10s |

- Prompt cap: 2000 char (truncato con avviso nel risultato).
- Singola reference image: max 8 MB.
- Timeout: 3 min per immagini, 8 min per video (request abort + notifica admin in caso di errore o timeout).

### 9.5 Cosa è cambiato

| File | Azione | Note |
|---|---|---|
| `src/tools/imagineGenerator.js` | ✅ Creato | Implementazione `generateImage` + `generateVideo`, condivide `_resolveReferenceImages` e `_postJson`. |
| `src/ai/tools.js` | ✅ Aggiornato | Nuovi builder `buildGenerateImageTool` / `buildGenerateVideoTool` con descrizioni dinamiche per agentic / non-agentic. Registrati nella tool list dopo `image_search`, condizionati a `!isDiscord`. |
| `src/tools/index.js` | ✅ Aggiornato | Import + dispatcher `case 'generate_image'` / `case 'generate_video'` con notifica intermedia. Entrambi aggiunti a `ONCE_PER_ROUND_TOOLS`. |
| `src/config/env.js` | ✅ Aggiornato | `IMAGE_GEN_MODEL` e `VIDEO_GEN_MODEL` aggiunti a `REQUIRED` e all'export. |
| `.env` | ✅ Aggiornato | `IMAGE_GEN_MODEL=grok-imagine-image-quality`, `VIDEO_GEN_MODEL=grok-imagine-video`. Endpoint Imagine documentati nel commento. |
| `src/ai/systemPrompt.js` | ✅ Aggiornato | `<PoweredBy>` ora elenca anche `generate_image` / `generate_video` come capability Grok. |

### 9.6 Edge case gestiti
1. **Discord**: i tool non sono nella tool list (`!isDiscord` in `getToolsForUser`). Se per errore venissero invocati, il whitelist enforcement in `handler.js` li respinge senza chiamare il dispatcher.
2. **Non-agentic + path assoluto**: `isPathAllowed` rifiuta con "Access denied: Access to advanced storage denied. Unlock agentic mode first." (stesso comportamento di `read_file`).
3. **Reference image non esistente / corrotta / troppo grande / formato non supportato**: errore esplicito con il path che ha causato il problema.
4. **Una sola reference per video**: inviata come `reference_image` (singolare). Più di una: inviata come `reference_images` (array) — gestito dal backend.
5. **Risposta vuota / URL al posto di base64**: il parser tenta b64_json → b64 → fetch della URL temporanea inline (xAI URL scadono in pochi minuti, conversione subito in base64 per mantenere tutto in memoria coerente con il resto delle attachments).
6. **`HERMES_API_KEY` / `IMAGE_GEN_MODEL` / `VIDEO_GEN_MODEL` mancanti**: errore strutturato senza crash.
7. **Same round, due chiamate**: bloccate da `ONCE_PER_ROUND_TOOLS` (`generate_image` o `generate_video` può essere chiamato al massimo una volta per round → il modello può comunque chiamare entrambi nello stesso round, ma non due immagini o due video insieme).
8. **Aspect ratio non valido**: errore con la lista degli ammessi. Se omesso, il campo non viene incluso nel body della request (alcuni build del proxy rifiutano il valore letterale `"auto"`).
9. **Prompt > 2000 char**: troncato con marker nel messaggio di risposta finale.
10. **Output vuoto / base64 invalido**: errore esplicito + notifica admin.

### 9.7 Notifiche intermedie
Coerenti con il pattern esistente (PDF, video describe, research):
- Image gen → 🎨 "Sto generando l'immagine, attendi un attimo..."
- Video gen → 🎬 "Sto generando il video (può richiedere fino a un paio di minuti), attendi un attimo..."

Dedup automatico per (call, kind) tramite `markNotifiedInCall` — se il modello ritenta nello stesso round dopo errore, la notifica non si ripete (anche se di fatto non può, per via di `ONCE_PER_ROUND_TOOLS`).

### 9.8 Pulizia delivery buffer e descrizioni dei tool

In contemporanea con l'aggiunta di `generate_image` / `generate_video` è stato unificato il modello del **delivery buffer** del bot:

- **Rimosso** il filtro selettivo `[image:N]` per `image_search`. Ora ogni risultato di `image_search` finisce nel buffer come tutti gli altri allegati (PDF, immagini generate, video generati, file di `output/`, `attach_file`, `formal_request_pdf`, `music_creator`). L'AI non può più scegliere "in finale" quali immagini inviare: tutto ciò che è nel buffer arriva all'utente con la risposta. **Niente eccezioni, niente codice morto**.
- Rimossi: `_imageSearchId`, `_imageSearchNextId`, `reserveImageIds` da `responseCtx`; `stripImageTags` da `utils/text.js`; il blocco di filtraggio in `handler.js`; gli ID nel `<ImageSearchResults>` XML; il commento in `voiceMessage.js`; il typedef `_imageSearchId` in `attachments.js`.
- Le descrizioni dei tool che producono allegati ora dicono solo "pushed to the delivery buffer" senza ripetere ogni volta "auto-delivered to the current user / use includeAttachments=true". La logica del buffer è spiegata **una volta sola** nel `<Behavior>` del system prompt:
  > Delivery buffer: any tool that produces a file ... pushes the result into a per-call buffer. Everything in the buffer is sent AUTOMATICALLY to the current user with your reply. To forward those same files to another recipient, call a delivery tool ... with includeAttachments=true.
- L'agentic briefing non duplica più questa spiegazione: `<Layout>` e `<FileDelivery>` rimandano a `<Behavior>` con un breve "pushed to the delivery buffer".
- Anche le skill `pptx`/`docx` SKILL.md sono state aggiornate: `Auto-delivery` → `Output buffer`, con riferimento al concetto unificato.
- **Verifica architetturale**: `output/` files e qualsiasi file generato/aggiunto al buffer **vengono inclusi automaticamente** nei delivery tool (`send_email`, `send_whatsapp_message`, `send_voice_message`) quando `includeAttachments=true`. Non esiste più una categoria "files che si vedono solo nella chat corrente": il buffer è uno solo. Confermato leggendo `handler.js` (i delivery tool prendono `responseCtx.attachments` che è popolato anche da `bash`/`write_file` quando si scrive in `output/` via `projectRun.js`).

### 9.9 Variabili `.env` post Step 7
**Aggiunte**:
```dotenv
IMAGE_GEN_MODEL=grok-imagine-image-quality
VIDEO_GEN_MODEL=grok-imagine-video
```

### 9.10 Checklist Step 7
- [x] `src/tools/imagineGenerator.js` — creato (path resolution + chiamate Hermes + parsing risposta + buffering attachments)
- [x] `src/ai/tools.js` — `buildGenerateImageTool`, `buildGenerateVideoTool` aggiunti, registrati condizionati a `!isDiscord`
- [x] `src/tools/index.js` — import, dispatcher, `ONCE_PER_ROUND_TOOLS` aggiornato, notifiche intermedie
- [x] `src/config/env.js` — `IMAGE_GEN_MODEL` / `VIDEO_GEN_MODEL` in REQUIRED + export
- [x] `.env` — modelli aggiunti, commenti endpoint aggiornati
- [x] `src/ai/systemPrompt.js` — `<PoweredBy>` aggiornato + nuovo blocco `<Behavior>` che spiega il delivery buffer una sola volta
- [x] **Cleanup `[image:N]`**: rimosso il filtro selettivo da `handler.js`, da `tools/index.js`, da `imageSearch.js`; `stripImageTags` rimosso da `utils/text.js` e dai callsite; `_imageSearchId` rimosso da `responseCtx` e dal typedef di `attachments.js`; voiceMessage commento aggiornato.
- [x] **Cleanup descrizioni tool**: `image_search`, `attach_file`, `write_file`, `generate_formal_request_pdf`, `generate_image`, `generate_video`, `send_voice_message`, `send_whatsapp_message`, `send_email` — tutti ora dicono "pushed to the delivery buffer" o "Set includeAttachments=true to forward the buffered files" senza ripetere la meccanica auto-delivery.
- [x] **Cleanup briefing agentico**: `<Layout>` e `<FileDelivery>` allineati al concetto di buffer unificato.
- [x] **Cleanup skill markdown**: `pptx/SKILL.md` e `docx/SKILL.md` da `Auto-delivery` → `Output buffer`.
- [x] **Cleanup tool runtime messages**: `attachFile.js` (`message: 'File pushed to the delivery buffer.'`), `projects.js` (`/workspace/output/` "pushed to the delivery buffer"), `imagineGenerator.js` (image/video success messages).
- [x] `node --check` su tutti i file modificati: OK
- [x] `getDiagnostics` su tutti i file modificati: nessuna diagnostica
- [ ] **Da fare sul VPS dopo deploy**: verificare che il proxy Hermes esponga `/v1/images/generations` e `/v1/videos/generations` (entrambi formato OpenAI SDK con `b64_json`). Se no, aggiornare config Hermes. Poi `pm2 restart "GemiX"` e smoke test (text-to-image, image-to-image con reference da history, text-to-video, image-to-video con singola reference, reference-to-video con 2-3 reference, ricerca immagini con `image_search` — tutte le immagini devono arrivare automaticamente, niente più filtraggio).

---

## 10. Step 8 — Eliminazione `code_execution`, adozione `code_interpreter` xAI (completato: 2026-05-20)

### 10.1 Obiettivo
Rimuovere il tool custom `code_execution` (eseguito nel Python kernel della sandbox GemiX) e sostituirlo con il tool xAI server-side `code_interpreter`. xAI gestisce il prompt, la sandbox e l'esecuzione del codice; GemiX vede solo la risposta finale del modello.

### 10.2 Architettura post-Step 8
```
Grok 4.3 (Hermes /chat/completions)
  ├─ chiama tool xAI server-side: code_interpreter   ← isolato, no /workspace/, no /readonly/
  └─ chiama function tool GemiX: bash, write_file, edit_file, read_file...
      └─ project sandbox docker (Python kernel via Jupyter)
```

`code_interpreter` è disponibile **sempre** fuori da Discord (nessun gating dietro `agentic_unlock`).
`bash`/`write_file`/`edit_file`/`attach_file` continuano a richiedere `agentic_unlock` come prima.

### 10.3 Cosa è cambiato

| File | Azione | Note |
|---|---|---|
| `src/tools/codeExecution.js` | 🗑️ Eliminato | Sostituito dal tool xAI server-side |
| `src/tools/codeInterpreter.js` | ✅ Creato | Dispatcher verso `/v1/responses` con `{ type: 'code_interpreter' }` |
| `src/ai/tools.js` | ✅ Aggiornato | Rimosso `TOOL_CODE_EXECUTION`; aggiunto `TOOL_CODE_INTERPRETER` come function tool standard (Hermes `/chat/completions` accetta solo `type:'function'`; il dispatcher lo delega a `/v1/responses` dove `code_interpreter` è valido) |
| `src/tools/index.js` | ✅ Aggiornato | Import + `case 'code_interpreter'` aggiunto |
| `src/handler.js` | ✅ Aggiornato | `AGENTIC_TOOL_NAMES`/`DEFERRED_TOOL_NAMES` aggiornati |
| `src/ai/agenticBriefing.js` | ✅ Aggiornato | Aggiunto blocco `<CodeInterpreterBoundary>`, `<PythonSandbox>` rinominato `<ProjectSandbox>` |
| `src/ai/systemPrompt.js` | ✅ Aggiornato | Aggiunto `<ToolBoundaries>` (fuori da Discord) |
| `src/data/skills/{xlsx,pptx,docx,pdf}/SKILL.md` | ✅ Aggiornati | Pattern `code_execution` sostituito con `write_file` (Phase 2) + `bash python …` (Phase 3) |
| `src/sandbox/projectRun.js` | ✅ Aggiornato | Commenti puliti |
| `src/sandbox/sandboxManager.js` | ✅ Aggiornato | Commenti puliti |
| `src/tools/bashTool.js`, `writeFile.js`, `attachFile.js` | ✅ Aggiornati | Commenti e messaggi di errore rivisti |
| `src/utils/{attachments,bgTasks,userPaths}.js` | ✅ Aggiornati | Commenti aggiornati |
| `sandbox/README.md`, `entrypoint.sh`, `preload_models.py` | ✅ Aggiornati | Riferimenti a `code_execution` rimossi |
| `SERVER_SETUP.md` | ✅ Aggiornato | Spiegazione tool server-side xAI |

### 10.4 Cosa NON è cambiato
- **`src/sandbox/sandboxManager.js`, `src/sandbox/projectRun.js`, `src/sandbox/pythonKernel.js`**: invariati a livello di logica. Il Python kernel resta necessario per `bash` (che esegue `subprocess.run` dentro la sandbox), per `write_file` (operazioni atomiche con uid 1000) e `edit_file`.
- **`sandbox/Dockerfile` + `requirements-sandbox.txt`**: NON sono stati alleggeriti. La libreria pesante che era utile a `code_execution` (numpy/scipy/torch/manim ecc.) potrebbe ora non servire più, MA: alcune skill usano `pandas`, `openpyxl`, `python-docx`, `python-pptx`, `reportlab` da bash (e quindi servono nel container), e `pdflatex`/`libreoffice` continuano a essere necessari. Una pulizia del Dockerfile è un follow-up consigliato (ridurrebbe peso immagine ≈ multi-GB), ma richiede audit di ogni script `.py` sotto `src/data/skills/` per stabilire l'elenco minimo. **Raccomandazione**: tenere ora l'immagine così com'è, fare pulizia in un PR dedicato dopo aver verificato in produzione che nessuna skill regredisca.

### 10.5 Edge case gestiti
1. **Hermes `/chat/completions` rifiuta `type:'code_interpreter'`**: Hermes accetta solo `type:'function'` o `type:'live_search'` su `/chat/completions`. `TOOL_CODE_INTERPRETER` è quindi un function tool standard; il dispatcher lo intercetta e lo delega a `/v1/responses` dove `{ type: 'code_interpreter' }` è valido.
2. **Chiamate duplicate nello stesso round**: `code_interpreter` può essere chiamato più volte nello stesso round con codice diverso — è stateless e non scrive nel workspace, quindi non è in `ONCE_PER_ROUND_TOOLS`.
3. **`GROK_MODEL` non configurato**: guard esplicito in `codeInterpreter.js` (oltre al fail-fast in `env.js`).
4. **Risposta vuota**: errore strutturato, il modello può riformulare.
5. **Timeout** (>2min): errore retryable, notifica admin.
6. **Codice > 20k char**: troncato, marcato nel messaggio di risposta.
7. **Discord**: `code_interpreter` non è nella tool list Discord (condizione `if (!isDiscord)` in `getToolsForUser`).
8. **Round budget**: `code_interpreter` non è in `AGENTIC_TOOL_NAMES` — non bumpa il budget a 20 round. Corretto: è stateless e non scrive nel workspace.

### 10.6 Checklist Step 8
- [x] `src/tools/codeExecution.js` — eliminato
- [x] `src/tools/codeInterpreter.js` — creato (dispatcher verso `/v1/responses`)
- [x] `src/ai/tools.js` — `TOOL_CODE_EXECUTION` rimosso, `TOOL_CODE_INTERPRETER` aggiunto come function tool
- [x] `src/tools/index.js` — import + dispatcher `case 'code_interpreter'`
- [x] `src/handler.js` — `AGENTIC_TOOL_NAMES`/`DEFERRED_TOOL_NAMES` aggiornati
- [x] `src/ai/agenticBriefing.js` — blocco `<CodeInterpreterBoundary>`, sandbox rinominata
- [x] `src/ai/systemPrompt.js` — blocco `<ToolBoundaries>` aggiunto
- [x] `src/data/skills/{xlsx,pptx,docx,pdf}/SKILL.md` — pattern aggiornati
- [x] Commenti / messaggi di errore in 7 file di supporto allineati
- [x] `node --check` su tutti i file modificati: OK
- [x] `getDiagnostics` su tutti i file modificati: nessuna diagnostica
- [ ] **Da fare sul VPS dopo deploy**: `pm2 restart "GemiX"`, smoke test live (`code_interpreter` per math, `bash + write_file` per skills).

---

## 11. Step 9 — Fix UX, badge e refactoring notifiche (completato: 2026-05-20)

### 11.1 Obiettivo
Risolvere cinque problemi emersi nei test e rifattorizzare la logica delle notifiche intermedie:
1. Footer di ricerca mostrava solo `𝕏: N posts` (bug: `num_sources_used` è sempre 0 col proxy Hermes).
2. Notifiche intermedie video sempre al singolare e ripetute a ogni round.
3. Indicatore "sta scrivendo / registrando" su WhatsApp si fermava per ~10s.
4. AI inconsapevole della divisione di responsabilità Gemini ↔ Grok e non avvisava l'utente quando delegava la ricerca.
5. `pdfTranscriptionTracker.js` conteneva logica video/ricerca non correlata ai PDF.

### 11.2 Cosa è cambiato

| File | Azione | Note |
|---|---|---|
| `src/tools/webXSearch.js` | ✅ Aggiornato | `_extractUsageStats` legge `usage.server_side_tool_usage_details.{web_search_calls, x_search_calls}`. `num_sources_used` ignorato (sempre 0 col proxy Hermes). |
| `src/utils/notificationDedup.js` | ✅ Creato | Dedup per (call, kind): `markNotifiedInCall`, `clearCallNotifications`. Builder di messaggi per tutti i tipi: `buildPdfNotificationMessage`, `buildVideoNotificationMessage`, `buildResearchNotificationMessage`. |
| `src/utils/pdfTranscriptionTracker.js` | ✅ Ridotto | Solo logica PDF: contatore attivo per chat (`incrementTranscription`, `decrementTranscription`). Usa `notificationDedup` internamente. `getTranscriptionCount` rimosso (codice morto). |
| `src/utils/media.js` | ✅ Aggiornato | Import statici in cima (rimosso `require` inline). Tracker incrementato solo se ci sono PDF effettivi nel contenuto. `onTranscriptionEnd` rimosso (mai usato). |
| `src/ai/videoDescriber.js` | ✅ Aggiornato | `onStart(pendingCount)` riceve il numero di video non-cached per singolare/plurale. |
| `src/handler.js` | ✅ Aggiornato | Helper `sendIntermediateNotification(ctx, kind, message)` con dedup integrato. `ctx.requestId` propagato per allineare i key di dedup tra pre-processing e tools. `clearCallNotifications` nel `finally`. `resetVoiceCount` aggiunto ai due return voice-only che lo saltavano. `lastAgenticTool` rimosso (variabile mai letta). |
| `src/tools/index.js` | ✅ Aggiornato | `case 'web_x_search'` invia `🔎 Sto consultando il team di ricerca, attendi un attimo...` prima della call (dedup automatico via `userCtx.sendIntermediateNotification`). |
| `src/utils/presence.js` | ✅ Aggiornato | Refresh interval `20s → 10s`. Per-update timeout 4s con `_withTimeout` per evitare stalli. |
| `src/ai/systemPrompt.js` | ✅ Aggiornato | Blocco `<PoweredBy>` (Grok: chat/code_interpreter/web_x_search/TTS/STT; Gemini-Lyria: video description/music_creator). |
| `src/ai/tools.js` | ✅ Aggiornato | `web_x_search`: AI istruita a dire all'utente che ha delegato la ricerca. `music_creator`: annotato "powered by Google Lyria". |
| `src/utils/footer.js` | ✅ Aggiornato | Aggiunta entry `grok-4.3-latest` / `grok-4.3` → `'Grok 4.3'` nella map. |

### 11.3 Edge case gestiti
1. **Più round della stessa call con video/PDF/ricerche**: una sola notifica intermedia per (call, kind). I round successivi restano silenziosi.
2. **Contenuto senza PDF**: il tracker non viene incrementato se non ci sono parti PDF effettive nell'array.
3. **Più video o PDF nello stesso turno**: contatore mostra "N video / N documenti".
4. **Una sola ricerca per round** (vincolo `ONCE_PER_ROUND_TOOLS`): nessuna gestione plurale necessaria.
5. **Notifica con piattaforma sconosciuta**: `sendIntermediateNotification` fallisce silenziosamente (try/catch interno).
6. **Cleanup dedup**: `clearCallNotifications(ctx)` nel `finally` di `handleMessage`. Safety valve: il Set viene svuotato se supera 5000 voci.
7. **Footer badge**: solo `web_search_calls` e `x_search_calls` da `server_side_tool_usage_details`.
8. **Presence stutter su WA**: refresh ogni 10s + timeout 4s per `sendStateTyping/Recording`.
9. **Voice-only senza reset**: `resetVoiceCount` ora chiamato anche nei due return `isVoiceOnly: true`.

### 11.4 Checklist Step 9
- [x] `src/tools/webXSearch.js` — fix conteggio web sources
- [x] `src/utils/notificationDedup.js` — creato (dedup + builders)
- [x] `src/utils/pdfTranscriptionTracker.js` — ridotto a solo logica PDF
- [x] `src/utils/media.js` — import statici, tracker condizionale, `onTranscriptionEnd` rimosso
- [x] `src/ai/videoDescriber.js` — `onStart(count)`
- [x] `src/handler.js` — helper unificato, voice-only reset, `lastAgenticTool` rimosso
- [x] `src/tools/index.js` — notifica `web_x_search`
- [x] `src/utils/presence.js` — interval 10s + per-update timeout
- [x] `src/ai/systemPrompt.js` — `<PoweredBy>`
- [x] `src/ai/tools.js` — descrizioni `web_x_search` e `music_creator`
- [x] `src/utils/footer.js` — entry `grok-4.3-latest` / `grok-4.3`
- [x] `node --check` su tutti i file modificati: OK
- [x] `getDiagnostics` su tutti i file modificati: nessuna diagnostica
- [ ] **Da fare sul VPS dopo deploy**: `pm2 restart "GemiX"`, smoke test live: ricerca complessa (badge `🌐: N sources. 𝕏: M posts.` corretto, AI menziona delega), turno con più PDF/video (singolare-plurale corretto, niente ripetizioni nei round successivi), conversazione lunga su WA (indicatore typing stabile), risposta vocale (footer corretto "Grok 4.3").

---

## 12. Codice morto eliminato (riepilogo cumulativo)

| File / Costante | Step | Note |
|---|---|---|
| `src/ai/mediaDescriber.js` | Step 1 | Grok 4 ingerisce audio/video nativamente |
| `src/ai/pageSummarizer.js` | Step 1 | Logica reintegrata inline in `browsePage.js` con Hermes |
| `src/rag/regolamentoRag.js` | Step 1 | Full-context (regolamento è 24KB ≈ 6k token) |
| `src/tools/webSearch.js` | Step 2 | Sostituito da `webXSearch` (multi-agent xAI) |
| `src/tools/browsePage.js` | Step 2 | Page-browsing incluso in `web_search` xAI nativo |
| `XAI_API_KEY` (env + export) | Step 3 | Tutto passa da Hermes con `HERMES_API_KEY` |
| `XAI_TTS_URL` (constant) | Step 3 | URL hardcoded sostituita da `${HERMES_BASE_URL}/tts` |
| `src/tools/codeExecution.js` | Step 8 | Sostituito dal tool xAI server-side `code_interpreter` |
| `FAST_MODEL`, `AGENTIC_MODEL` | Step 1 | Sostituite da unica `GROK_MODEL` |
| `EMBEDDING_MODEL` | Step 1 | Niente più embeddings |
| `BROWSE_PAGE_MODEL` | Step 1 | `browsePage` usava `GROK_MODEL` |
| `MEDIA_DESCRIBER_MODEL` | Step 1 | |
| `OPENROUTER_BASE_URL` (constant) | Step 3 | Migrata in `.env` |
| `OPENROUTER_API_KEY` (env) | — | Mantenuta solo per Lyria + video describer |
| `MUSIC_MODEL` (env) | — | Mantenuta per Lyria |
| `src/tools/musicCreator.js` | — | Mantenuto: usa OpenRouter + Lyria, non disponibile via xAI |
| Cache `regolamento_rag.json` su disco | Step 1 | Non più letta, innocua, si può cancellare manualmente |

---

## 13. Variabili `.env` — stato attuale (post Step 7)

```dotenv
# AI - Hermes (proxy OpenAI-compatible → Grok via SuperGrok OAuth)
# Tutte le features xAI (chat, code_interpreter, tts, stt, multi-agent, imagine) passano da qui.
HERMES_BASE_URL=http://127.0.0.1:8000/v1
HERMES_API_KEY=dummy
GROK_MODEL=grok-4.3-latest
MULTI_AGENT_MODEL=grok-4.20-multi-agent
IMAGE_GEN_MODEL=grok-imagine-image-quality
VIDEO_GEN_MODEL=grok-imagine-video
XAI_TTS_VOICE=leo
XAI_TTS_ENABLED=true

# OpenRouter — Lyria music generation + Gemini video description
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_API_KEY=...
MUSIC_MODEL=google/lyria-3-clip-preview
VIDEO_DESCRIBER_MODEL=google/gemini-2.5-flash-lite

# Image search (SearXNG — solo per image_search, web/X passano per multi-agent)
SEARXNG_URL=http://localhost:8888

# Discord
BOT_TOKEN=...
GUILD_ID=...

# Email, GitHub, sandbox notify, PDF parser, public URL, music wrap...
# (invariate)
```

**Variabili rimosse nel corso della migrazione**:
- `FAST_MODEL`, `AGENTIC_MODEL`, `EMBEDDING_MODEL`, `BROWSE_PAGE_MODEL`, `MEDIA_DESCRIBER_MODEL`, `XAI_API_KEY`

---

## 14. Regola di split: `.env` vs `src/config/constants.js`

**`.env` (deployment values, secrets, environment-specific)**:
- `HERMES_BASE_URL`, `HERMES_API_KEY` — proxy endpoint e auth
- `GROK_MODEL`, `MULTI_AGENT_MODEL`, `IMAGE_GEN_MODEL`, `VIDEO_GEN_MODEL` — model IDs (possono variare per A/B testing)
- `OPENROUTER_BASE_URL`, `OPENROUTER_API_KEY` — OpenRouter endpoint e auth
- `MUSIC_MODEL`, `VIDEO_DESCRIBER_MODEL` — model IDs per servizi specifici
- `XAI_TTS_VOICE`, `XAI_TTS_ENABLED` — feature flags vocali
- `SEARXNG_URL` — endpoint SearXNG
- `BOT_TOKEN`, `GUILD_ID`, `BOT_EMAIL`, `BOT_PASS`, `GITHUB_TOKEN`, `GITHUB_REPO` — credenziali e config platform
- `GEMIX_NOTIFY_URL`, `OPENDATALOADER_HYBRID_URL`, `GEMIX_PUBLIC_URL` — endpoint interni
- `MAINTENANCE_MODE` — feature flag globale

**`src/config/constants.js` (code-level constants, non-secrets)**:
- `MAX_TOKENS`, `MAX_HISTORY`, `MAX_TOOL_ROUNDS`, `MAX_AUDIO_DURATION_S`, `MAX_VIDEO_DURATION_S` — limiti di sistema
- `PLATFORM_DISCORD`, `PLATFORM_WA_PERSONAL`, `PLATFORM_WA_DEDICATED` — enum piattaforme
- `GEMIX_FOOTER_PREFIX` — formato footer
- Altre costanti di business logic

**Regola**: Se un valore è un segreto, un endpoint, o può variare tra ambienti (dev/staging/prod), va in `.env`. Se è una costante di sistema o di business logic, va in `constants.js`.

---

## 15. Domande frequenti e risposte

### Q: Il team di ricerca ha un prompt di base di sistema oltre a quello di Grok 4.3?

**A**: No. Il team multi-agent (`grok-4.20-multi-agent`) riceve SOLO il prompt dell'utente (il `prompt` passato a `web_x_search`). Non vede il system prompt di Grok 4.3, non vede la cronologia, non vede il contesto di GemiX. È un'entità separata che riceve un brief e ritorna un report.

### Q: Ha accesso soltanto ai tool web_search e x_search di xAI?

**A**: Sì. Il team multi-agent ha accesso SOLO ai tool nativi xAI: `web_search` (che include page-browsing) e `x_search` (X/Twitter). Niente `code_interpreter`, niente `music_creator`, niente tool GemiX. È un'API di ricerca pura.

### Q: Vede il contesto, prompt di GemiX, cronologia conversazione o altro?

**A**: No. Vede SOLO il `prompt` che gli passiamo (il brief di ricerca). Niente contesto, niente cronologia, niente system prompt. È completamente isolato.

---

## 16. Dubbi e domande per il team di ricerca

Prima di fare il deploy, verificare con il team di ricerca (o con la documentazione xAI):

1. **Endpoint `/v1/responses`**: Hermes espone davvero questo endpoint? È compatibile con il formato che usiamo in `webXSearch.js`?
2. **Autenticazione**: Il token `HERMES_API_KEY` funziona per `/v1/responses` come per `/v1/chat/completions`?
3. **Modello `grok-4.20-multi-agent`**: È il nome corretto? Esiste ancora a maggio 2026?
4. **Tool nativi**: `web_search` e `x_search` sono disponibili per questo modello?
5. **Timeout**: 5 minuti è un timeout ragionevole per una ricerca multi-agent?
6. **Risposta**: Il formato della risposta è sempre JSON con `content` e `citations`?

**File da allegare al team di ricerca per verifica**:
- `src/tools/webXSearch.js` — implementazione della call
- `src/config/env.js` — variabili di config
- `.env` — valori di deployment
- `MIGRATION_PLAN.md` — questo documento

---

## 17. Note finali

- `package.json`: zero cambi alle dipendenze.
- `MAX_TOKENS = 64_000`, `MAX_HISTORY = 50` (Step 4).
- History con `<Description>` legacy: messaggi vecchi hanno già `<Description kind="audio|video">` iniettati. Grok li interpreta come testo, funzionano comunque.
- Sandbox Docker: l'immagine è ancora pesante. Step 8 ha rimosso il tool che la sfruttava di più ma lasciato i layer Python intatti per non rompere skills via `bash`. Audit + cleanup è un follow-up dedicato.
- **Prossimi step**: cleanup `REFERENCES.md`, eventuale audit dipendenze sandbox per ridurre l'immagine Docker.

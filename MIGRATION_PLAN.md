# Piano migrazione GemiX → Hermes (xAI Grok via SuperGrok OAuth)

Documento di pianificazione e tracking della migrazione totale dell'ecosistema AI di GemiX dal mix attuale (OpenRouter / xAI key diretta / Gemini / SearXNG / Lyria) al solo proxy **Hermes Agent** che parla con Grok via abbonamento SuperGrok.

> Data: 2026-05-19 — versione iniziale, redatta prima dello Step 1.

---

## 1. Stato attuale (mappato dalla codebase)

### 1.1 Punto di ingresso AI unico
Tutta la chat principale passa per **una sola funzione**: `callAI` in `src/ai/aiProvider.js`. Sotto il cofano:
- transport `fetch` raw via `src/ai/apiClient.js` (`callModel`/`callApiWithRetry`),
- `OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'` codificato in `src/config/constants.js`,
- bearer `OPENROUTER_API_KEY` da `.env`,
- modelli letti da `.env`: `FAST_MODEL` / `AGENTIC_MODEL`.

### 1.2 Sub-chiamate AI sparse
| File | Modello usato | Scopo | Da migrare? |
|---|---|---|---|
| `src/ai/mediaDescriber.js` | `MEDIA_DESCRIBER_MODEL` (Gemini Flash Lite) | Trasforma audio/video in `<Description>` testuale prima della call principale | ❌ **DA ELIMINARE**: Grok 4 ingerisce audio/video nativi |
| `src/ai/pageSummarizer.js` | `BROWSE_PAGE_MODEL` (Qwen 3.5 flash) | Riassume HTML estratto da `browse_page` (modes: summary) | 🔄 Step 2: rinviare al modello principale o riusare un Grok dedicato (è la stessa chiamata su Hermes) |
| `src/rag/regolamentoRag.js` | `EMBEDDING_MODEL` (Qwen embedding 8b) | RAG sul regolamento Discord (24KB di testo) | ❌ **DA SEMPLIFICARE**: il regolamento è 24KB ≈ 6k token; passarlo full-context, eliminare embeddings |
| `src/tools/musicCreator.js` | `MUSIC_MODEL` (Lyria) | Generazione musica streaming SSE | ⚠️ **MANTENUTO su OpenRouter**: Lyria non disponibile via Hermes/Grok. Unica eccezione rimasta. |
| `src/tools/voiceMessage.js` | `XAI_TTS_URL` diretto (api.x.ai) | TTS vocale | ⚠️ Step 3: valutare se il proxy Hermes espone `/v1/audio/speech`; per ora resta diretto via `XAI_API_KEY` |

### 1.3 Web search
- `src/tools/webSearch.js` → SearXNG self-hosted (`SEARXNG_URL=http://localhost:8888`).
- `src/tools/browsePage.js` → fetch HTML + `pageSummarizer`.
- ❌ Nessun tool dedicato a X/Twitter (oggi simulato con `web_search` + `allowed_domains:['x.com']`).
- 🔄 Step 2: introdurre tool `live_search`/`x_search` nativo Grok via Hermes; deprecare SearXNG.

### 1.4 Logica agentic_unlock
Quando la AI invoca il tool `agentic_unlock`:
- `userCtx.agenticUnlocked = true`,
- la lista tool viene ricostruita (rimuove gateway, aggiunge `code_execution`, `write_file`, `edit_file`, `bash`, `attach_file`),
- viene appeso al system prompt il `agenticBriefing` (tutto lo stato progetti + skills + sandbox layout),
- `callAI` switcha al modello `AGENTIC_MODEL` con `effort: 'high'`.

**Decisione richiesta dall'utente**: post-migrazione, FAST e AGENTIC saranno **lo stesso modello Grok 4**. Il flag `agenticUnlocked` continua però a controllare:
- la **tool list visibile** al modello (per non appesantire la finestra di contesto della modalità chat normale con tool inutili),
- l'**iniezione del briefing agentico** in system prompt,
- l'aumento del round budget (5 → 20),
- (eventualmente) il `reasoning.effort` se Grok lo accetta.

---

## 2. Obiettivi dello Step 1 (questo PR)

### 2.1 Cosa cambia
1. **Aggiunta nuova configurazione** Hermes nel `.env`:
   - `HERMES_BASE_URL` (default `http://127.0.0.1:8000/v1`)
   - `HERMES_API_KEY` (placeholder `dummy`, il proxy lo ignora)
   - `GROK_MODEL` (default `grok-4-latest`)
2. **`src/config/constants.js`**: rimossa costante `OPENROUTER_BASE_URL`. Aggiunte `HERMES_BASE_URL` (env-driven), `HERMES_DEFAULT_MODEL`.
3. **`src/config/env.js`**: rimosse `OPENROUTER_API_KEY`, `FAST_MODEL`, `AGENTIC_MODEL`, `EMBEDDING_MODEL`, `BROWSE_PAGE_MODEL`, `MEDIA_DESCRIBER_MODEL`, `MUSIC_MODEL`. Aggiunte `HERMES_BASE_URL`, `HERMES_API_KEY`, `GROK_MODEL`.
4. **`src/ai/aiProvider.js`**:
   - rimosso `describeMediaInMessages`,
   - usa `GROK_MODEL` per entrambe le modalità (nessuna distinzione modello tra fast e agentic),
   - provider rinominato a `'Grok'` nei log,
   - costruzione body conserva `tools` se presenti, niente `reasoning.effort` (non documentato sulla compat OAI di Hermes; lo riaggiungeremo solo se servirà e sarà accettato).
5. **`src/ai/apiClient.js`**: solo rinaming log; resta invariata la logica fetch + retry + log su disco.
6. **Eliminati**:
   - `src/ai/mediaDescriber.js` (Grok ingerisce audio/video direttamente),
   - `src/ai/pageSummarizer.js` (sostituito da nuova chiamata diretta a Hermes nel browsePage),
   - `src/rag/regolamentoRag.js` (sostituito da full-context inline),
   - `src/tools/musicCreator.js` (rimosso dal toolkit; `MUSIC_MODEL` non esiste più).
7. **`src/tools/browsePage.js`**: il summarizer LLM continua a esistere ma chiama Hermes con `GROK_MODEL` direttamente (estratto pulito: una sola helper interna da ~30 righe). Il flag `BROWSE_PAGE_MODEL` viene rimosso dal codice e dall'env.
8. **Discord RAG**: rimossa l'inizializzazione `initRegolamentoRag()` da `src/index.js` e le chiamate `queryRegolamento()` da `src/handler.js`. Il regolamento (24KB) viene letto e iniettato per intero in `<RulesContext>` solo per Discord. Eventuale rimozione successiva del file `src/data/regolamento_rag.json` se presente.
9. **`src/ai/tools.js`**:
   - rimosso `TOOL_MUSIC_CREATOR` e relativi riferimenti,
   - rimosso `getToolsForUser`-injection di `TOOL_MUSIC_CREATOR`,
   - tutto il resto invariato.
10. **`src/tools/index.js`** (executeTool dispatcher): rimosso il case `music_creator`.
11. **Cache descrizioni media** in `src/utils/historySync.js`: le funzioni `getStoredHistoryMediaDescription`/`storeHistoryMediaDescription` restano disponibili per **legacy compat** (history vecchia ha già `<Description>` salvati e li riusiamo finché esistono — niente perdita di dati). I call site nelle piattaforme che leggono history le mantengono. Niente più scrittura nuova: senza `mediaDescriber`, il pre-call non genera più descrizioni.
12. **System prompt** (`src/ai/systemPrompt.js`): aggiornato il blocco `<MediaHandling>` per riflettere che ora audio/video sono ingeriti direttamente da Grok (senza più `<Description>`). I `<Description>` storici in cronologia vanno ancora menzionati come dati legacy informativi.
13. **`src/handler.js`**: nessun cambiamento strutturale, solo rimozione `queryRegolamento` e relativa import.

### 2.2 Cosa NON cambia in questo step
- **Tool**: tutti i tool restano com'erano. `web_search` continua a usare SearXNG. `browse_page` continua a esistere. Nessun nuovo tool xAI nativo.
- **TTS**: `voiceMessage.js` continua a chiamare `https://api.x.ai/v1/tts` con `XAI_API_KEY` diretto. Migrazione a `/v1/audio/speech` di Hermes rimandata a Step 3.
- **PDF parsing**: `OpenDataLoader hybrid` resta invariato per ora. Step successivo valuterà se Grok può ingerire i PDF direttamente.
- **Sandbox / scheduler / piattaforme** (Discord, WhatsApp): zero modifiche.
- **Logging API** (`src/logs/api-*.json`): formato invariato.

### 2.3 Variabili `.env` post-migrazione (questo step)
```dotenv
# AI - Hermes (proxy OpenAI-compatible verso Grok via SuperGrok OAuth)
HERMES_BASE_URL=http://127.0.0.1:8000/v1
HERMES_API_KEY=dummy
GROK_MODEL=grok-4-latest

# xAI TTS diretto (verrà migrato a Hermes /v1/audio/speech in Step 3)
XAI_API_KEY=...
XAI_TTS_VOICE=leo
XAI_TTS_ENABLED=true

# Web search
SEARXNG_URL=http://localhost:8888

# Discord
BOT_TOKEN=...
GUILD_ID=...

# Email, GitHub, music wrap, sandbox notify, PDF parser, public URL ...
# (invariate)
```

**Variabili rimosse**:
- `OPENROUTER_API_KEY`
- `FAST_MODEL`
- `AGENTIC_MODEL`
- `EMBEDDING_MODEL`
- `BROWSE_PAGE_MODEL`
- `MEDIA_DESCRIBER_MODEL`
- `MUSIC_MODEL`

---

## 3. Step successivi (futuri PR)

### Step 2 — Eliminazione SearXNG e adozione Live Search nativo Grok
**Obiettivo**: eliminare la dipendenza da SearXNG self-hosted (porta 8888 sul VPS) sfruttando i tool `live_search` di Grok via Hermes.

**Modifiche previste**:
- Verifica che il proxy Hermes esponga il parametro `search_parameters` (Grok Live Search).
- Sostituire `src/tools/webSearch.js` con un thin wrapper che invoca `chat/completions` con `search_parameters: { mode: 'on', sources: [{ type: 'web' }] }` e ritorna i citation.
- Aggiungere tool dedicato **`x_search`** (oggi simulato con `web_search` + `allowed_domains:['x.com']`) usando `sources: [{ type: 'x' }]`.
- Rimuovere `SEARXNG_URL` dall'env e dal codice.
- `browse_page`: valutare se `live_search` con un solo URL specifico copre il caso d'uso, oppure mantenere il tool con summarizer ma su Hermes.
- Decisione: tenere `browse_page` per quando l'utente fornisce un URL diretto e vuole un'analisi profonda (Live Search non sempre fa fetch del raw HTML).

### Step 3 — Migrazione TTS al proxy Hermes
**Obiettivo**: rimuovere `XAI_API_KEY` dal repo e usare il proxy come unico endpoint xAI.

**Modifiche previste**:
- Verifica che Hermes esponga `/v1/audio/speech` con voice id compatibili (`leo`, `eve`).
- Sostituire `xaiTTS()` in `src/tools/voiceMessage.js` con una chiamata `POST ${HERMES_BASE_URL}/audio/speech` (header `Authorization: Bearer ${HERMES_API_KEY}`).
- Rimuovere `XAI_API_KEY` e `XAI_TTS_URL` dall'env.

### Step 4 — Rivisitazione gestione history e media
**Domanda aperta dall'utente**: *"il tool `read_file` per la cronologia diventa inutile? Includiamo direttamente tutti i media nella cronologia nella chiamata dato che non dobbiamo più badare a token, o meglio mantenere così per non sprecare contesto?"*

**Analisi**:
- Pro inclusione totale dei media in history: zero round AI sprecato per `read_file`, l'utente può riferirsi a "il vocale di ieri" e Grok lo "ricorda" davvero.
- Contro: ogni round agentico (anche solo bash/code) trasporta MB di base64 in input; latenza e costo conteggiati ancora dal piano SuperGrok.
- **Compromesso suggerito**: includere SOLO il media dell'**ultimo turno** in history come content multimodale (cosa che già succede), e per i turni più vecchi mantenere il tag `[Attachment: file.ext]` + tool `read_file` on-demand. Esattamente come oggi, ma senza la mediazione di `<Description>` (Grok può ingerire l'audio direttamente quando l'utente fa `read_file`).
- **Effetto immediato** (già coperto da Step 1): senza più `mediaDescriber`, l'audio in history non ha più `<Description>` precomputato. La cache esistente (`getStoredHistoryMediaDescription`) viene letta solo se popolata da turni passati; nuove descrizioni non vengono più generate. Il sistema funziona perché Grok può leggere il media nativamente quando viene riallegato (via `read_file`).

### Step 5 — RAG embeddings (se necessario)
**Stato**: dopo Step 1 il regolamento Discord è full-context. Se in futuro si vuole estendere il RAG ad altri corpora più grandi, valutare:
- provider embeddings dedicato (Voyage, Cohere) come unica eccezione,
- oppure `live_search` su un knowledge graph, se Grok supporta sources custom.
- **Per ora**: nessuna azione.

### Step 6 — Eliminazione del tool `music_creator`
**Stato**: rimosso già in Step 1. Se in futuro xAI rilascia un endpoint music gen via Hermes, lo si re-aggiunge da capo (non è blocking).

### Step 7 — Image generation (futuro)
- Verificare se Hermes espone `/v1/images/generations` (Aurora di xAI).
- Se sì, aggiungere tool `image_generation` (oggi inesistente).

### Step 8 — Code execution server-side
**Domanda aperta**: il proxy Hermes potrebbe esporre il `code_execution` xAI server-side. Tuttavia GemiX ha la propria sandbox Docker isolata con più capacità (filesystem, yt-dlp, libreoffice, pdf parser). **Decisione**: mantenere la sandbox locale; il tool `code_execution` di GemiX ha priorità sull'eventuale tool xAI omonimo (come da specifica Hermes).

---

## 4. Code morto eliminato in Step 1

| File / Costante | Status | Note |
|---|---|---|
| `src/ai/mediaDescriber.js` | 🗑️ Eliminato | Grok 4 ingerisce audio/video nativamente |
| `src/ai/pageSummarizer.js` | 🗑️ Eliminato | Logica reintegrata inline in `browsePage.js` con Hermes |
| `src/rag/regolamentoRag.js` | 🗑️ Eliminato | Full-context (regolamento è 24KB ≈ 6k token) |
| `src/tools/musicCreator.js` | 🟡 Mantenuto su OpenRouter | Lyria non disponibile via Hermes/Grok. Unica eccezione rimasta. |
| `OPENROUTER_API_KEY` (env) | 🟡 Mantenuta solo per Lyria | |
| `MUSIC_MODEL` (env) | 🟡 Mantenuta solo per Lyria | |
| `OPENROUTER_BASE_URL` (constant) | 🟡 Mantenuta solo per Lyria | |
| `FAST_MODEL`, `AGENTIC_MODEL` | 🗑️ Rimosse | Sostituite da unica `GROK_MODEL` |
| `EMBEDDING_MODEL` | 🗑️ Rimossa | Niente più embeddings |
| `BROWSE_PAGE_MODEL` | 🗑️ Rimossa | `browsePage` usa `GROK_MODEL` |
| `MEDIA_DESCRIBER_MODEL` | 🗑️ Rimossa | |
| `MUSIC_MODEL` | 🗑️ Rimossa | |
| Cache `regolamento_rag.json` su disco | ⚠️ Lasciato (innocuo, non più letto) | Si auto-pulisce con eventuale GC futuro |

---

## 7. Step 1.5 — Media pre-processing (audio STT + video description)

> Completato: 2026-05-19

### Contesto
Dopo Step 1 si è verificato che Grok 4.3 via Hermes **non ingerisce audio/video nativamente** in modo affidabile tramite `input_audio` content parts. Si è quindi reintrodotto un pre-processing step prima della chiamata principale, usando servizi dedicati.

### Cosa è stato fatto

#### Audio — xAI STT (`/v1/stt`)
- Creato `src/ai/audioTranscriber.js`: chiama `https://api.x.ai/v1/stt` con `XAI_API_KEY`.
  - Parametri: `language: 'auto'`, `format: 'true'` (Inverse Text Normalization).
  - Risposta JSON: `result.text` (non testo plain — l'endpoint Whisper OpenAI è stato sostituito da xAI a aprile/maggio 2026).
  - **Endpoint corretto**: `/v1/stt` (non `/v1/audio/transcriptions` che non esiste più su xAI).
- Creato `src/ai/audioProcessor.js`: walk dei messages, sostituisce ogni audio part con `<Transcription>…</Transcription>`.
  - Supporta sia `input_audio` che `image_url` con MIME `audio/*`.
  - Check durata via `ffprobe` (`getMediaDurationSec`): audio > `MAX_AUDIO_DURATION_S` (120s) viene saltato.
  - Cache trascrizioni in history (`getStoredHistoryVoiceTranscription`).

#### Video — Gemini via OpenRouter
- Creato `src/ai/videoDescriber.js`: chiama `OPENROUTER_BASE_URL/chat/completions` con `VIDEO_DESCRIBER_MODEL` (es. `google/google/gemini-2.5-flash-lite`).
  - **Formato video corretto per OpenRouter/Gemini**: `{ type: 'video_url', video_url: { url: 'data:video/*;base64,...' } }` — NON `image_url` (rifiutato per video).
  - Check durata via `ffprobe`: video > `MAX_VIDEO_DURATION_S` (15s) viene saltato.
  - Risposta JSON schema: `{ description: string }`.
  - Cache descrizioni in history (`getStoredHistoryMediaDescription`).
- Aggiunta variabile `VIDEO_DESCRIBER_MODEL` a `src/config/env.js` (era già in `.env`).

#### Integrazione in handler
- `src/handler.js`: chiamate a `describeVideoInMessages` e `processAudioInMessages` aggiunte subito dopo il push del messaggio utente, prima del loop AI. Entrambe wrapped in try/catch.

#### System prompt
- `src/ai/systemPrompt.js`: `<MediaHandling>` aggiornato — rimossi dettagli tecnici interni (endpoint, provider), mantenuti solo i limiti operativi (`audio ≤ Xs → <Transcription>`, `video ≤ Xs → <Description>`).
- Pulizia generale del prompt: rimossi tag verbosi (`<ToolExecution>`, `<ResponsePreferences>` ridondanti), accorciati testi inutilmente lunghi.

### Variabili `.env` aggiunte/modificate
```dotenv
VIDEO_DESCRIBER_MODEL=google/google/gemini-2.5-flash-lite
# XAI_API_KEY già presente — ora usata anche per STT oltre che TTS
```

### Checklist Step 1.5
- [x] `src/ai/audioTranscriber.js` — xAI `/v1/stt`, risposta JSON, `language: auto`, `format: true`
- [x] `src/ai/audioProcessor.js` — walk messages, cache, duration cap
- [x] `src/ai/videoDescriber.js` — Gemini via OpenRouter, formato `video_url`, duration cap
- [x] `src/config/env.js` — export `VIDEO_DESCRIBER_MODEL`
- [x] `src/handler.js` — integrazione pre-processing prima del loop AI
- [x] `src/ai/systemPrompt.js` — aggiornamento `<MediaHandling>` e pulizia prompt



1. **History con `<Description>` legacy**: messaggi vecchi hanno già `<Description kind="audio|video">…</Description>` iniettati nel testo. Grok li interpreta come descrizioni testuali pre-fatte, **funzionano comunque** (è del testo come un altro). Il system prompt continua a menzionarli per coerenza.
2. **Cache file `.kiro/`/`src/data/regolamento_rag.json`**: il file su disco non viene più letto. Innocuo, ma se l'utente vuole pulirlo è una `del` manuale.
3. **`MEDIA_DESCRIBER_MODEL not configured`**: l'unica branch che usa questo log path è in `mediaDescriber.js` che ora viene eliminato → branch sparisce.
4. **`browse_page` con LLM error**: se il summarizer fallisce, il fallback "raw" continua a funzionare (l'utente può chiamare di nuovo con `mode: 'raw'`).
5. **Round budget**: invariato (5 → 20 con `agenticUnlocked`). La transizione FAST→AGENTIC del modello scompare ma il salto del budget round resta.
6. **`reasoning.effort`**: oggi viene passato a OpenRouter (Qwen lo capisce). Hermes/Grok via OAI proxy potrebbe non averlo in spec. Lo rimuoviamo dal body in Step 1; lo si riaggiunge solo dopo conferma compatibilità.
7. **`HTTP 401` se Hermes non in esecuzione**: il `callApiWithRetry` gestisce già il retry e poi notifica l'admin. Niente da fare.
8. **`MAX_TOKENS = 8192`**: per Grok 4 va probabilmente alzato (Grok 4 supporta context window molto più ampia). Non blocking ma da rivedere in Step 4.

---

## 6. Checklist Step 1

- [x] Aggiunta sezione Hermes a `SERVER_SETUP.md`
- [x] Creazione `MIGRATION_PLAN.md`
- [x] Aggiornamento `.env` (rimosse var OpenRouter, aggiunte Hermes)
- [x] Aggiornamento `src/config/env.js`
- [x] Aggiornamento `src/config/constants.js`
- [x] Refactor `src/ai/aiProvider.js`
- [x] Refactor `src/ai/apiClient.js` (rinaming log)
- [x] Refactor `src/tools/browsePage.js` (chiamata Hermes inline)
- [x] Eliminazione `src/ai/mediaDescriber.js`
- [x] Eliminazione `src/ai/pageSummarizer.js`
- [x] Eliminazione `src/rag/regolamentoRag.js` + dir
- [x] ~~Eliminazione `src/tools/musicCreator.js`~~ → **ripristinato** (mantenuto su OpenRouter per Lyria)
- [x] Aggiornamento `src/ai/tools.js` (rimosso `TOOL_MUSIC_CREATOR`)
- [x] Aggiornamento `src/tools/index.js` (rimosso case `music_creator`)
- [x] Aggiornamento `src/handler.js` (rimossa `queryRegolamento`)
- [x] Aggiornamento `src/index.js` (rimossa `initRegolamentoRag`, aggiunto preflight Hermes)
- [x] Aggiornamento `src/ai/systemPrompt.js` (`<MediaHandling>` aggiornato per ingestion nativa)
- [x] Nuovo `src/utils/regolamento.js` (loader full-context con cache)
- [x] Aggiornamento `src/utils/footer.js` (display name → Grok)
- [x] Verifica codice morto residuo (grep clean) e diagnostiche
- [x] Smoke test sintattico Node `--check` su tutti i file modificati
- [ ] **Da fare sul VPS dopo deploy**: `npm install` (nessuna nuova dep aggiunta), `pm2 restart "GemiX"`, smoke test live (`/help` o messaggio admin in maintenance)

### Note finali Step 1
- `package.json`: zero cambi alle dipendenze. Tutto il transport AI già usava `fetch` nativo. Versione lasciata a `1.7.5` (alzarla a `2.0.0-rc1` quando Step 2 chiude SearXNG).
- Cache regolamento: il file `src/data/regolamento_rag.json` (se mai esistito) non viene più letto e può essere cancellato manualmente sul VPS (`rm src/data/regolamento_rag.json`). Innocuo se rimane.
- `MAX_TOKENS = 8192` mantenuto invariato. Da rivalutare in Step 4 quando si misura il context budget reale di Grok 4 via Hermes.

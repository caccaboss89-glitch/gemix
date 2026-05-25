# Analisi pulizia GemiX v2 — proposta architetturale (revisione 3)

> Documento autonomo. Chi legge dopo non ha il contesto della conversazione: tutto quello che serve è qui dentro. Non eseguire ancora niente — è un'analisi, non un piano operativo. Tutte le decisioni qui dentro sono state validate dall'utente proprietario del progetto.


## 0. Cosa è successo prima

L'utente sta finalizzando GemiX v2.0 (vedi `Aggiornamento.txt`) e fa una pulizia profonda. Da quando paga indirettamente le chiamate LLM via abbonamento SuperGrok attraverso Hermes Agent (vedi `SERVER_SETUP.md`), non deve più ottimizzare round/costi. Ha già riscritto la skill PDF seguendo `src/data/skills/REWRITE_METHOD.md` ma il sistema è ancora troppo complesso e sporco.

Tre problemi principali nel codice attuale:

1. **Sistema progetti custom**: `gemix-project create/switch/delete/cleanup/quota/copy-to-project/delete-storage`, max 10 progetti per utente, quota 1 GB, lock per progetto, crash recovery slot, briefing pieno di liste progetti+file+README. È un guardrail pesante che la chat ufficiale di Grok non ha (lì un workspace c'è e basta).
2. **Parser PDF dedicato** (microservizio Python `[GemiX] PDF-Parser` su porta 5002, OCR/hybrid): ogni PDF parsato viene esploso in `/readonly/history/<name>/{<name>.pdf, transcription.md, assets/}`. La history JSON aggiorna i puntatori, il tool `read_file` ha ~150 righe di logica di canonical resolution PDF→folder, le skill hanno sezioni "Don't Use This Skill For Plain Reading" / "When You Need The Original PDF File", e le immagini estratte perdono qualità.
3. **Asimmetria nei tool media**: `image_search` ha `save_to_disk` (e solo se agentic_unlocked); `generate_image`/`generate_video`/`music_creator` no. Incoerente.

L'utente ha eseguito una serie di test curl reali sul VPS contro Hermes — risultati completi con precisi comandi eseguiti da leggere come reference in `RESEARCH.md`. Sintesi delle scoperte (questo cambia tutto):

- **`/v1/chat/completions`** (l'endpoint OpenAI-compatibile usato oggi) → immagini base64 OK, ma **PDF/audio/video falliscono o tornano "Empty content block"**.
- **`/v1/responses`** (endpoint xAI nativo, già usato dal multi-agent research team) → **supporta `input_file` con `file_url` pubblico** per PDF, audio parlato, video e immagini. Pre-processing (STT, frame extraction, OCR) server-side xAI, non Hermes. Grok riceve testo/frame estratti in tag dedicati (`<DOCUMENT>`, `<AUDIO>`, frame).
- **File locali**: impossibili. Solo URL HTTPS pubblici. Né `file:///...` né `data:...;base64` funzionano su `/v1/responses`.
- **Audio parlato**: ottimo (trascrizione xAI integrata).
- **Audio musicale/sonoro**: Grok riceve solo tag `<AUDIO>` vuoto → rifiuta. Limite del modello.
- **Video con audio parlato**: ottimo (frame + trascrizione voce).
- **PDF nativo + scansionato**: ottimo (testo + immagini + struttura, OCR incluso).
- **Limiti**: 48 MB/file (xAI), n=1 file consigliato per chiamata (n>1 a volte causa refusal), durata video pratica ~2-3 min.
- **Imagine** (image/video gen): **non esposto su HTTP** — resta esclusivamente via CLI `hermes -z` (bridge `bridge/imagine.sh`).

L'utente ha già un tunnel HTTPS pubblico per allegati: `[GemiX] Tunnel-Allegati` (`localtunnel` su porta 9998, subdomain `gemix-attachments.loca.lt`, vedi `SERVER_SETUP.md`). Oggi usato come fallback per allegati grandi. Diventa la spina dorsale della nuova architettura.

L'utente vuole inoltre:
- Modello dedicato `grok-build-0.1` per la modalità agentic (analogo al multi-agent del team di ricerca).
- Workspace per utente/gruppo, cross-platform per stesso utente, con TTL inattività.
- Pattern sub-agent isolato per l'agentic (analogo a `web_x_search`) — ora ha senso perché i file passano via URL pubblico, non più via cronologia in-memory.
- File ingestion uniforme: niente più pre-processing custom (base64 immagini, STT separato, video describer Gemini, parser PDF dedicato), niente più tag XML iniettati. Tutto via `input_file` URL.
- `code_interpreter` mantenuto sul main (tool xAI server-side professionale, sandbox isolata xAI, utile per simulazioni veloci che non producono file). E disponibile anche dentro l'agente.


## 1. Decisioni di design (sintesi)

| Domanda | Scelta | Perché |
| :--- | :--- | :--- |
| Endpoint LLM principale | **Migrazione globale a `/v1/responses`** | Unico endpoint che accetta PDF/audio/video. Già usato per multi-agent. Hermes lo proxy. |
| Parser PDF dedicato | **Eliminato** (pm2 stop + rimozione codice) | Grok 4.3 fa OCR+text+images server-side via `input_file` PDF. |
| STT audio + video describer separati | **Eliminati** | Grok 4.3 trascrive audio parlato e descrive video frame+voice via `input_file`. |
| Audio musicale/sonoro / parlato non chiaro | **Nessun fallback custom** — istruzione nel system prompt main | L'AI riceve tag vuoto, l'istruzione le dice di informare l'utente. |
| Imagine (image/video gen) | **Invariato** (CLI bridge) | Non esposto via HTTP. |
| Music creator (Lyria) | **Invariato** (OpenRouter) | Lyria non è su xAI. |
| File ingestion lato programma | **URL-based via tunnel pubblico** | Niente più base64 inline + STT custom + video describer + parser PDF. Un solo flusso: ottieni URL → `input_file`. |
| Sistema progetti `gemix-project` | **Eliminato** | Sostituito dall'agentic come sub-agent isolato. |
| Modalità agentic principale | **Sub-agent isolato `build` con modello dedicato `grok-build-0.1`** | Pattern già validato (`web_x_search`). Contesto pulito, modello specifico. |
| Workspace agentic | **Per utente/gruppo, cross-platform**, persistente, **TTL 4h dall'ultima interazione utente con GemiX** | L'utente cita esplicitamente questo modello (gruppo WA = workspace condiviso del gruppo; utente = workspace cross-platform). |
| Layout workspace | **Nessuna struttura fissa**: una root vuota, l'AI ci scrive quello che vuole | L'utente vuole zero cartelle di sistema. L'unica eccezione fuori dal workspace è `/skills/` read-only. |
| Passaggio file dall'host all'agente | **URL pubblici scaricati fisicamente nella root del workspace prima di lanciare l'agente** | Fix unificato per il rinaming-on-collision (vedi §2.3). |
| Fonti dei file allegati a `build` | **Sia history sia buffer turno corrente** | Senza buffer, l'agente non potrebbe usare immagini/video/musica appena generati nel turno corrente. |
| Output dell'agente verso l'host | **Tag `<DELIVER>filename1, filename2</DELIVER>`** alla fine della risposta finale | Niente cartella di sistema dedicata, niente tool dedicato (rischio dimenticanza). Il system prompt ricorda il tag ad ogni round. |
| `code_interpreter` | **Mantenuto sul main + esposto anche al sub-agent** | Tool ortogonale per simulazioni veloci. |
| `attach_file` | **Eliminato** | Con la delivery via DELIVER non serve più. |
| `save_to_disk` su `image_search` | **Eliminato** | Asimmetria sanata: dentro `build` salva sempre in workspace; nel main non persiste. |
| Skill (PDF/DOCX/XLSX/PPTX) | **Vivono nel sub-agent**, montate read-only su `/skills/` | L'host non le vede. |
| Tool sub-agent | `write_file`, `edit_file`, `bash`, `read_file`, `image_search`, `web_x_search`, `code_interpreter` | Niente `generate_image/video/music_creator` nell'agente: se serve un asset generato, l'host lo genera e glielo passa come allegato. |
| Listing workspace nel main | **`<UserWorkspace files="N">` nel system prompt main** quando il workspace non è vuoto | L'utente chiede "hai ancora il PDF di prima?" → GemiX risponde senza chiamare `build`. |
| Lock workspace | **1 chiamata `build` per volta per workspace_id** | Evita race su file. Concorrenti aspettano o ricevono errore. |


## 2. Architettura proposta

### 2.1 Diagramma logico

```
┌──────────────────────────────────────────────────────────────────────┐
│ GemiX MAIN (Grok 4.3 — chat brain)                                   │
│ Endpoint: /v1/responses                                              │
│                                                                      │
│ Tool list (ridotta, niente tool agentici):                           │
│   web_x_search                                                       │
│   image_search          (no save_to_disk; niente persistenza)        │
│   generate_image        (Imagine via CLI)                            │
│   generate_video        (Imagine via CLI)                            │
│   music_creator         (Lyria via OpenRouter)                       │
│   code_interpreter      (xAI server-side)                            │
│   read_file             (filename → URL pubblico → input_file)       │
│   send_voice_message / send_whatsapp_message / send_email            │
│   schedule_tasks / read_my_tasks / remove_my_tasks                   │
│   update_memory / read_server_rules / read_music_stats               │
│   toggle_release_notify / bug_report                                 │
│   generate_formal_request_pdf (Discord)                              │
│   ─────────────────────────────                                      │
│   build (NEW)           ← sub-agent agentic (vedi 2.2)               │
│                                                                      │
│ System prompt include <UserWorkspace> se non vuoto.                  │
└──────────────────────────────────────────────────────────────────────┘
                              │ build({ prompt, attachments[] })
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ GemiX BUILD (Grok-Build-0.1 — engineering sub-agent)                 │
│ Endpoint: /v1/responses                                              │
│                                                                      │
│ Workspace: data/users/<workspaceId>/build_workspace/                 │
│   (nessuna struttura fissa, root vuota all'avvio)                    │
│                                                                      │
│ Read-only mounts:                                                    │
│   /skills/  (PDF/DOCX/XLSX/PPTX/REWRITE_METHOD per riferimento)      │
│                                                                      │
│ Tool list:                                                           │
│   write_file / edit_file / bash / read_file                          │
│   image_search / web_x_search / code_interpreter                     │
│                                                                      │
│ Output finale: testo + <DELIVER>filename1, filename2</DELIVER>       │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.2 Workspace ID e logica multi-utente

Il workspace è identificato da `workspaceId`, calcolato così:

| Contesto | workspaceId | Chi ci accede |
| :--- | :--- | :--- |
| Gruppo WhatsApp (qualunque membro) | `group:<groupId>` | Solo messaggi di quel gruppo |
| Utente non-active, WA personale + dedicato | `user:<storageId>` | Stesso utente in entrambe le piattaforme WA |
| Utente active (membro), WA personale + dedicato + Discord | `user:<storageId>` | Stesse 3 piattaforme dello stesso membro |

Discord per non-active è già impossibile a livello server (server limitato a membri attivi), quindi non ci sono edge case da gestire.

`storageId` esiste già nel codice (`src/utils/userPaths.js` `resolveStorageId`) ed è cross-platform per stesso utente. La risoluzione gruppo è già nel codice (`groupId` nel ctx). Niente nuova logica di identità da aggiungere — solo il prefisso `group:` vs `user:` come discriminator.

Path host: `data/users/<workspaceId>/build_workspace/` (con `<workspaceId>` come `group_<id>` o `user_<storageId>`, sanitizzato per filesystem).

### 2.3 Layout workspace e file passing

**Root del workspace = unica directory in cui l'AI lavora.** Niente subdir di sistema (`code/`, `temp/`, `output/`, `inbox/` non esistono).

Quando GemiX-Main chiama `build({ prompt, attachments: ["report.pdf", "logo.png"] })`:

1. **Risoluzione filename**: per ogni nome in `attachments`, l'host cerca:
   - prima nel **buffer del turno corrente** (file generati da `image_search`/`generate_image`/`generate_video`/`music_creator` o caricati nel messaggio utente)
   - poi nella **cronologia chat** (filename matching, già implementato)
   - se trovato → ottiene URL pubblico (vedi §2.4) e scarica fisicamente nella root del workspace
   - se non trovato → errore strutturato all'host con la lista dei file mancanti (l'AI riprova senza)
2. **Collisione nome**: se nella root del workspace esiste già un file con lo stesso nome:
   - rinomina il nuovo file in `name(1).ext`, `name(2).ext`, …
   - scrive nelle istruzioni passate all'agente: "Il file che mi hai chiesto di chiamare `report.pdf` esiste già in workspace e si è dovuto rinominare in `report(1).pdf`. Usa questo nome nelle operazioni."
3. **Stato workspace**: l'host costruisce un blocco `<WorkspaceState>` con elenco completo dei file (root + sub-cartelle create dall'AI) con `name + size + age`. L'agente lo vede ad ogni round (rebuild prima di ogni AI call così riflette le scritture appena fatte).
4. **Ritorno**: l'agente lavora, alla fine emette messaggio finale con `<DELIVER>file_a.pdf, file_b.png</DELIVER>`. L'host parsa il tag, verifica che ogni file esista nel workspace, lo aggiunge al `responseCtx.attachments` del turno main per la consegna automatica all'utente. I file restano nel workspace dopo la consegna (servono per "modifica il PDF di prima").

**Perché entrambi history + buffer**: senza il buffer, se l'utente chiede *"genera un'immagine X e includila in un PDF"*, l'host fa `generate_image` (asset nel buffer) → poi `build` con `attachments: ["image.png"]` → l'agente lavora con quel file. Senza il supporto buffer questo workflow sarebbe impossibile o richiederebbe round extra.

### 2.4 File ingestion uniforme

Sostituisce: base64 inline immagini, STT separato, video describer Gemini, parser PDF dedicato, tag XML iniettati manualmente.

**Strategia URL pubblico**:

| Sorgente | Strategia per ottenere URL HTTPS pubblico |
| :--- | :--- |
| Allegato Discord | URL CDN nativo (`message.attachments[i].url`) — è già pubblico HTTPS, non serve tunnel |
| Allegato WhatsApp (whatsapp-web.js) | **Da verificare in fase di implementazione**: la libreria espone un URL pubblico? Se sì, usarlo. Se no, download in `/tmp/<random>/<filename>` → esposizione via tunnel `gemix-attachments.loca.lt` → cleanup dopo TTL ridotto (vedi §2.7) |
| File generato dai tool media nel turno corrente | Scrittura in `/tmp/<random>/<filename>` → URL via tunnel |
| File da cronologia GemiX (già su disco) | URL via tunnel |

**Tool `read_file` lato main** (semplificato drasticamente):
- Input: `filename.ext` (solo nome, niente path) — cerca nel buffer turno + history
- Effetto: aggiunge il file al messaggio utente del **round successivo** come `input_file` con `file_url` pubblico (l'AI lo vede al ciclo dopo)
- Tipi non supportati da xAI (binari come `.zip`, `.exe`, `.dll`, `.tar.gz`, `.7z`, `.iso`, `.dmg`): rifiuto con errore "binary archive — only the agent can inspect via bash. Call build with this file as attachment if needed."
- Tipi text-based piccoli (`.txt`, `.md`, `.json`, `.py`, ≤ 50 KB): inline come `input_text` con header `[file: name.ext]`. Sopra 50 KB → `input_file` URL (xAI accetta? va testato; in fallback inline troncato).

**Tool `read_file` lato sub-agent**:
- Input: nome file presente nel workspace (qualunque sub-cartella creata dall'AI)
- Effetto: legge il file nello stesso modo del main (URL pubblico → input_file nel round successivo dell'agente)
- I file in `/skills/` sono leggibili anch'essi ma sempre come testo (sono `.md`)

**Cosa scompare dal codice**:
```
src/ai/audioTranscriber.js              eliminato
src/ai/audioProcessor.js                eliminato
src/ai/videoDescriber.js                eliminato
src/utils/pdfStructure.js               eliminato
src/utils/historySync.js                rimuovere persistParsedPdfToHistory
src/utils/media.js                      rimuovere transcribeDocumentsInMessageContent
src/tools/readFile.js                   riscritto da zero (host) + nuova versione per sub-agent
[GemiX] PDF-Parser microservizio        pm2 stop / pm2 delete + rimozione da SERVER_SETUP.md
```

**Notifica admin su MIME non supportato**: `apiClient.js` notifica già errori API generici. Aggiungere check dedicato: se la risposta xAI menziona "unsupported file type" / "invalid mime", `notifyAdmin` con MIME e estensione, e l'AI riceve errore strutturato per rispondere all'utente.

### 2.5 Tool `build` (sub-agent) — schema

```js
{
  name: 'build',
  description:
    'Hand a build/code/document task to the engineering sub-agent (Grok-Build). ' +
    'The agent has its own isolated workspace, persistent across calls within the session ' +
    '(4h inactivity TTL), and returns the task result plus any deliverable files. ' +
    'Available tools inside build: write_file, edit_file, bash, read_file, image_search, ' +
    'web_x_search, code_interpreter. ' +
    'NOT available inside build: generate_image, generate_video, music_creator. ' +
    'If you need a generated asset (image/video/song) inside the build task, generate it FIRST ' +
    'in the main loop, then pass it via attachments[].',
  parameters: {
    prompt:
      'Detailed task instructions in English. Include desired output format, constraints, ' +
      'and how each attached file should be used.',
    attachments:
      'Array of filenames (with extension) referring to files in the current-turn buffer ' +
      'or in chat history. The host fetches each file, places it in the agent workspace root, ' +
      'and resolves filename collisions automatically (renames to name(1).ext etc.). ' +
      'Empty/omit if no files are needed.',
  },
  required: ['prompt'],
}
```

**Vincoli runtime**:
- 1 chiamata per turno main (in `ONCE_PER_ROUND_TOOLS`)
- Lock per `workspaceId`: chiamate concorrenti aspettano (timeout 30s) o ricevono errore "build busy"
- Round budget interno 60, hard timeout 10 min

### 2.6 System prompt sub-agent

Bozza concettuale (in inglese, coerente con `REWRITE_METHOD.md`):

```xml
<SystemPrompt role="GemiX-Build">
  <Identity>
    GemiX-Build, the engineering sub-agent of GemiX. Powered by grok-build-0.1.
    Your reasoning and tool calls are in English. Final user-facing text in Italian.
  </Identity>

  <Mission>
    Execute the build/code/document task delegated by GemiX-Main. Produce
    deliverables in the workspace root and announce them via <DELIVER>.
  </Mission>

  <Workspace>
    Working directory: /workspace/   (writable, no fixed structure)
    Skills reference:  /skills/      (read-only)
    Quota: 500 MB. Files persist across build calls within the same session.
  </Workspace>

  <WorkspaceState>
    {dynamic listing rebuilt at every round}
  </WorkspaceState>

  <AttachmentNotes>
    {if any files were renamed on collision, the host explains the new names here}
  </AttachmentNotes>

  <Tools>
    write_file / edit_file / bash / read_file / image_search / web_x_search / code_interpreter
  </Tools>

  <Skills>
    {skills index — only build-relevant: pdf, docx, xlsx, pptx}
    Read full skill via read_file on /skills/<name>/SKILL.md when needed.
  </Skills>

  <Delivery>
    End your final response with <DELIVER>file1.ext, file2.ext</DELIVER> listing
    files in the workspace root to send to the user. An empty <DELIVER></DELIVER>
    means "no files, just text response". The tag is REQUIRED on the final
    response — files NOT listed will not reach the user.
  </Delivery>

  <Pitfalls>
    - bash: standalone calls only — no &&, ||, ;, |, redirection, subshells.
    - Always absolute paths under /workspace/ or /skills/.
    - read_file refuses binary archives (.zip etc.) — use bash (unzip, etc.) instead.
    - yt-dlp: max 1080p, allowed domains youtube/x/instagram/tiktok/facebook.
    - Files passed as attachments are in /workspace/ root; check <AttachmentNotes>
      for any rename-on-collision before referencing them.
  </Pitfalls>
</SystemPrompt>
```

### 2.7 Tunnel allegati: capacity, sicurezza, TTL

Il `localtunnel` esistente passa da fallback a strada principale per ogni file passato al modello (eccetto Discord che ha CDN nativo). Implicazioni:

- **Token URL**: ≥ 128 bit random, mappato a path filesystem reale, validato server-side
- **TTL token**:
  - File da history (esistenza permanente su disco): 24h dall'ultimo accesso, poi rotazione token
  - File da cartella temporanea (download WhatsApp on-demand): 1h dall'invio xAI, poi rotazione + cleanup file
- **Listing**: disabilitato (no directory traversal, no enumeration)
- **MIME validation**: server-side prima di servire (no upload-then-execute pattern)
- **Bottleneck**: se `localtunnel` non regge il carico stimato (~500 download/giorno) → migrazione a Cloudflare Tunnel o Caddy con dominio dedicato. Non bloccante per la v2.0.

### 2.8 TTL workspace e cleanup

**TTL = 4 ore dall'ultima interazione utente con GemiX** (qualunque interazione su qualunque piattaforma associata a quel `workspaceId`, non solo chiamate `build`).

- Ogni turno main aggiorna `last_activity_at` per `workspaceId`
- Cron orario: per ogni `workspaceId` con `last_activity_at < now - 4h` → wipe workspace + shutdown sandbox container
- Workspace > quota 500 MB: scritture bloccate (errore strutturato all'agente con MB rimanenti). L'agente sa che deve cancellare prima di scrivere ancora.

### 2.9 Listing workspace lato main

Quando GemiX-Main viene invocato, se il workspace per il `workspaceId` corrente non è vuoto, il system prompt include:

```xml
<UserWorkspace files="N" total_size_mb="M">
  - report.pdf  (1.2 MB, 3h ago)
  - logo.png    (320 KB, 3h ago)
  - draft.md    (8 KB, 2h ago)
  ...up to 30 entries, then "and N more"...
</UserWorkspace>
```

L'AI può rispondere in autonomia a richieste tipo *"hai ancora il PDF di prima?"* senza chiamare `build`. Se l'utente chiede di consegnarlo *"come allegato"* GemiX-Main può chiamare `build` con istruzione "send back report.pdf as deliverable" — è il modo più pulito perché solo l'agente conosce DELIVER e tocca i file.

## 3. Edge case e gestione

| Caso | Gestione |
| :--- | :--- |
| Workspace > 48 MB su singolo file | OK per delivery utente. Se l'agente prova a `read_file` quel file dopo, fallisce (limite xAI). Errore esplicito al sub-agent. |
| DELIVER referenzia file inesistente | Skip silenzioso + log warning + nota nel result tool: "files not found: x.pdf". |
| Agente raggiunge round budget senza DELIVER | Ritorna ultimo messaggio testuale + DELIVER vuoto. Main informato. |
| Agente non emette DELIVER affatto | Ritorna messaggio + DELIVER vuoto. Funziona come "risposta solo testo". |
| Race condition rinaming durante turno | I file rinominati sono già nel workspace prima del primo round agente. `<WorkspaceState>` riflette stato reale ad ogni round. |
| 2 chiamate `build` simultanee (utente parla in 2 chat WA) | Lock per `workspaceId`. Seconda chiamata aspetta 30s o errore "build busy, retry shortly". |
| Tunnel down al momento del passing | Errore strutturato, `notifyAdmin`, AI risponde all'utente "sistema allegati momentaneamente non disponibile". |
| File con caratteri speciali nel nome | Sanitize lato host prima di scrivere in workspace (consistente con `sanitizeFilename` esistente). Comunicato all'agente in `<AttachmentNotes>` se il nome è cambiato. |
| Attachment richiesto non trovato | Errore strutturato all'AI main: lista file mancanti, AI può rispondere all'utente "non trovo il file X" o riprovare con un altro nome. |
| Workspace pieno e agente vuole scrivere | `write_file`/`edit_file`/`bash` ritornano errore "quota exceeded — clean up before continuing". L'agente decide cosa cancellare. |
| Audio musicale o parlato non chiaro | xAI ritorna tag `<AUDIO>` vuoto o trascrizione vuota. Istruzione system prompt main: "se non hai testo da un audio è perché non si capiva — informa l'utente". |
| MIME non supportato (raro) | API ritorna errore. `apiClient.js` notifica admin (logica generale) + check dedicato per messaggio "unsupported mime" con notifica più precisa. |


## 4. Eliminazioni concrete

### 4.1 Codice da rimuovere

```
src/sandbox/projectRun.js            riscritto (rimossa logica project-aware)
src/sandbox/sandboxManager.js        pool key da (storageId, projectName) a (workspaceId)
src/tools/projects.js                eliminato
src/tools/gemixProjectCmds.js        eliminato
src/tools/attachFile.js              eliminato
src/tools/readFile.js                eliminato e riscritto (host) + nuovo per sub-agent
src/utils/pdfStructure.js            eliminato
src/utils/historySync.js             rimuovere persistParsedPdfToHistory (resto invariato)
src/ai/audioTranscriber.js           eliminato
src/ai/audioProcessor.js             eliminato
src/ai/videoDescriber.js             eliminato
src/utils/media.js                   rimuovere transcribeDocumentsInMessageContent
src/ai/agenticBriefing.js            eliminato
```

### 4.2 Configurazione da rimuovere/aggiungere

Rimossi da `src/config/constants.js`:
```
MAX_PROJECTS_PER_USER
MAX_TOOL_ROUNDS_AGENTIC
INTERRUPTED_RUN_TTL_MS
PROJECT_STATE_LOCK_TTL_MS
```

Aggiunti:
```
BUILD_WORKSPACE_TTL_MS = 4 * 60 * 60 * 1000   // 4 ore
BUILD_WORKSPACE_QUOTA_MB = 500
BUILD_MAX_ROUNDS = 60
BUILD_HARD_TIMEOUT_MS = 10 * 60 * 1000        // 10 min
BUILD_LOCK_WAIT_MS = 30 * 1000                // 30s lock acquire timeout
TUNNEL_TOKEN_TTL_HISTORY_MS = 24 * 60 * 60 * 1000
TUNNEL_TOKEN_TTL_TEMP_MS = 60 * 60 * 1000     // 1h
```

`.env` (env.js): aggiungere `BUILD_MODEL=grok-build-0.1`. Rimuovere variabili Gemini (videoDescriber).

### 4.3 Cleanup `SERVER_SETUP.md`

Sezione `[GemiX] PDF-Parser` (porta 5002, opendataloader-pdf-hybrid) → rimossa completamente. Tunnel-Allegati va promosso da "fallback" a "componente core" (passing principale dei file al modello).

### 4.4 Tool da rimuovere/cambiare nel main

| Tool | Azione |
| :--- | :--- |
| `agentic_unlock` | Rimosso |
| `write_file` (main) | Rimosso |
| `edit_file` (main) | Rimosso |
| `bash` (main) | Rimosso |
| `attach_file` | Rimosso |
| `image_search` | Parametro `save_to_disk` rimosso |
| `read_file` | Riscritto: filename → URL pubblico → `input_file` next round |
| `build` | Aggiunto |

## 5. Sandbox manager — modifiche

`pool key` cambia da `(storageId, projectName)` a **`(workspaceId)`**. Un container per workspace. TTL idle resta `SANDBOX_IDLE_TTL_MS` (15 min). TTL workspace separato (4h inattività utente) → wipe contenuto + shutdown container.

Bind mount nel container:
- `/workspace/` → `data/users/<workspaceId>/build_workspace/` (rw)
- `/skills/` → `src/data/skills/` (ro)

Eliminato il bind di `/readonly/history/` e `/readonly/searched_images/`. L'agente accede ai file dell'utente solo via `attachments` (host che li scarica nel workspace al lancio della chiamata `build`).

## 6. Skill — adattamento al nuovo sistema

Le skill restano in `src/data/skills/<name>/`. Modifiche al contratto:

1. **Path**: i riferimenti a `/readonly/history/`, `/readonly/searched_images/`, `/workspace/{code|temp|output|inbox}/` vanno sostituiti da `/workspace/` (root unica).
2. **Sezioni "Don't Use This Skill For Plain Reading"**: la lettura/parsing dei file utente la fa GemiX-Main (Grok 4.3) prima di delegare a `build`. Se il file finisce nel workspace, vuol dire che `build` deve **operare** su di esso (manipolazione, inclusione, trasformazione), non riassumerlo. La sezione cambia tono in quella direzione.
3. **Lettura skill**: il sub-agent ha `/skills/` montato read-only. Nel system prompt c'è l'index. Per leggere full content, `read_file /skills/pdf/SKILL.md` o `read_file /skills/pdf/reference.md`.
4. **Nessuna skill è esposta all'host main**. L'AI principale capisce dal contesto utente che è un task `build` (creazione/manipolazione documento) e delega.

`REWRITE_METHOD.md` resta: una volta completato tutto servirà riscrivere ogni skill per riflettere i cambiamenti effettuati (es. spiegare come parsare i PDF dato che il parser di gemix non sarà più disponibile), nuovi path e uso tools + tutti i miglioramenti da applicare in base alle references delle skill ufficiali di XAI.

## 7. Imagine, music, web search — invariati sul main

- `generate_image`/`generate_video`: invariati (CLI bridge), restano sul main.
- `music_creator`: invariato (Lyria via OpenRouter).
- `web_x_search`: invariato.
- Tutti **NON** disponibili al sub-agent (per scelta esplicita: se serve un asset generato, il main lo prepara prima e lo passa via `attachments`).

## 8. Footer ricerche e badge

Oggi il main accumula `responseCtx.researchStats` da `web_x_search`. Va esteso:

- Se il sub-agent ha fatto `web_x_search` internamente, le stats ritornano nell'output di `build` (`{ success, message, delivered, research_stats }`)
- L'host somma al suo `responseCtx.researchStats`
- Il badge "🌐: N sources. 𝕏: N posts." si calcola una volta sola alla fine del turno main: usi dell'agente + usi del team di ricerca.

## 9. Round/contesto: stima del payoff

| Voce | Oggi | Dopo |
| :--- | :--- | :--- |
| Tool nel main loop (WA, agentic OFF) | ~16 | ~14 (rimossi `agentic_unlock`+`attach_file`, aggiunto `build`) |
| Tool nel main loop (WA, agentic ON) | ~20 | n/a — agentic non esiste più sul main |
| Briefing agentic (system prompt extra) | ~120 righe | 0 (vive nel sub-agent) |
| Sezioni PDF nelle skill (host context) | ~80 righe | 0 (skill non visibili al main) |
| Tool description (read_file, image_search, ecc.) | — | ~30 righe in meno |
| Microservizi Linux | 4 | 3 (no PDF-Parser) |
| Codice JS host | baseline | ~1500-2000 righe in meno |
| Codice JS sub-agent | 0 | ~500-700 righe in più |
| Endpoint LLM principali | 2 | 1 (`/v1/responses`) |

## 10. Rischi e mitigazioni

| Rischio | Mitigazione |
| :--- | :--- |
| Grok-Build-0.1 non gestisce volume tool calls di 4.3 | Test su task reali. Fallback temporaneo a 4.3 anche per build se non regge. |
| `localtunnel` non regge il carico | Switch pianificato a Cloudflare Tunnel o Caddy con dominio dedicato. Non bloccante v2.0. |
| File >48 MB | Pre-check host: messaggio sistema "file troppo grande", suggerisci compressione. |
| Audio non parlato | Nessun fallback custom — istruzione system prompt main. |
| Sub-agent loop infinito | Hard timeout 10 min + max 60 round. |
| Workspace orfani | Cron orario: TTL 4h inattività → wipe + shutdown sandbox. |
| Token URL leakati | Token 128 bit + TTL + log accessi. |
| Multi-turno iterabile | `output/` non esiste, ma i file persistono nel workspace. `<UserWorkspace>` nel main + `<WorkspaceState>` nel sub-agent garantiscono visibilità. |
| WhatsApp URL pubblico non disponibile dalla libreria | Download in cartella temporanea + tunnel + cleanup. Da verificare in fase di implementazione. |
| Discord URL CDN scade | Verificare TTL CDN Discord. Se inferiore a quanto serve a xAI per fetch, mirror via tunnel come fallback. |

## 11. Cose da verificare prima di partire (validation gate)

1. **`/v1/responses` ↔ function calling completo**: verificare con curl che accetti tools type `function`, tool_calls multipli, parallelism, tool_choice come `/chat/completions`. RESEARCH lo cita ma non lo testa con tool calls. **Test obbligatorio.**
2. **Compatibilità OpenAI SDK con `/v1/responses`**: `openai` ha `responses.create()`? Se sì, drop-in. Altrimenti chiamate raw `fetch` (già usate per `webXSearch.js`).
3. **`grok-build-0.1` accessibile su Hermes**: stesso endpoint? Stessa auth? Beta limitata? Da testare con curl.
4. **Tunnel allegati**: capacity 500 download/giorno stimati. Stress test prima del rollout.
5. **Cold start sub-agent**: latenza prima `build` (sandbox boot ~10-20s + agent init). Soglia accettabile <30s. Se no, container preallocati per utenti recenti.
6. **TTL workspace 4h**: feasibility UX. Se troppo corto comunicare chiaramente all'utente. Eventualmente alzare a 24h con quota più piccola (200 MB).
7. **WhatsApp URL pubblico**: la libreria `whatsapp-web.js` espone URL pubblici per i media in chat? Da verificare. Se no, fallback download+tunnel.
8. **Discord CDN URL TTL**: gli URL `cdn.discordapp.com` scadono dopo ~24h. Verificare che xAI fetchi prima.
9. **`input_file` per text-based generic**: `/v1/responses` accetta `.txt`/`.md`/`.py`/`.csv` come `input_file`? RESEARCH non lo testa. Test obbligatorio. Fallback: inline `input_text`.

## 12. Ordine di implementazione consigliato

Step rilasciabili indipendentemente, ognuno con valore:

1. **Migrazione globale a `/v1/responses`** (preserva tutto il resto). Schema messaggi, function calling, file inline come oggi (immagini base64). Rilasciabile, niente regressioni.
2. **Tunnel-based file passing**: estendere il tunnel da fallback a strada principale; salvataggio token con TTL; URL builder. Solo per allegati nuovi (cronologia esistente continua via base64).
3. **Drop parser PDF + STT + video describer**: i file ora passano via `input_file` URL. Test set rappresentativo PDF/audio/video.
4. **Sub-agent `build` infrastruttura**: nuovo client `/v1/responses` con modello `grok-build-0.1` (inizialmente puoi testare con 4.3 e poi switchare via env). Workspace per `workspaceId`. Tool list interna. `<DELIVER>` parser. Lock per workspaceId.
5. **Switch tool list main**: rimuovi `agentic_unlock`, `write_file`, `edit_file`, `bash`, `attach_file` dal main; aggiungi `build`. Listing `<UserWorkspace>` nel main system prompt.
6. **Cleanup**: `gemix-project*`, `agenticBriefing`, `pdfStructure`, `attachFile`, `audio*`/`videoDescriber`, microservizio PDF parser. Delete-only PR, basso rischio.
7. **Skill rewrite PDF (per riflettere le modifiche dell'amibente di gemix)** + **DOCX/XLSX/PPTX rewrite sulle references XAI fornite dall'utente**: le skill scritte direttamente per il sub-agent migliorate secondo src\data\skills\REWRITE_METHOD.md e adattate al nuovo ambiente.

## 13. TL;DR per chi prende in mano il codice

- L'host (Grok 4.3 chat brain) si pulisce: niente più tool agentici, niente briefing agentic, niente skill nel system prompt, niente parser PDF, niente STT/video describer custom.
- L'agentic = tool unico `build` che delega a sub-agent (Grok-Build-0.1).
- Workspace per utente/gruppo cross-platform, **root unica senza struttura fissa**, persistente con TTL 4h inattività utente, quota 500 MB.
- File passano via URL pubblico (Discord CDN nativo, altrove tunnel `gemix-attachments.loca.lt`) come `input_file` su `/v1/responses`.
- Allegati a `build`: lista filename, l'host scarica nel workspace, rinomina su collisione, comunica all'agente i nomi reali.
- Delivery dell'agente via tag `<DELIVER>file1.ext, file2.ext</DELIVER>` alla fine del messaggio finale.
- `code_interpreter` resta sul main + esposto anche al sub-agent.
- `image_search` e `web_x_search` esposti sia al main sia al sub-agent.
- `generate_image`/`generate_video`/`music_creator` solo sul main.
- Skill vivono nel sub-agent (mount `/skills/` read-only).
- Endpoint unico `/v1/responses`. Audio musicale → tag vuoto, istruzione system prompt main.

Per la conversazione successiva: leggi questo file e basta. Inizia dal validation gate (§11), poi ordine di §12.

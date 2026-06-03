# GemiX — Guida test rapida

**Aggiornato:** 2026-06-03 · Refactor `aiFileDelivery` (tunnel / `<FileContent>` / tag)

## Chi puoi testare adesso

| Situazione | Cosa fare |
|------------|-----------|
| **Tu = admin, `MAINTENANCE_MODE=true`** | Tutto in questa guida. Gli altri utenti vedono solo il messaggio di manutenzione — **non** puoi verificare member / non-member / tool bloccati per ruolo. |
| **Più utenti / manutenzione off** | Riprendi `PLATFORM_BEHAVIOR.md` e la matrice ruoli; non è coperta qui. |

**Piattaforme utili da solo:** WA Dedicated (privato), WA Personal (`@gemix`), Discord (thread forum). Scegli **1–2** canali per il pack file; non serve ripetere tutto su tutti e tre.

---

## Pack A — Allegati e `read_file` (priorità dopo refactor)

Obiettivo: confermare tunnel, testo inline, tag, errori espliciti.

### A1 — Messaggio corrente (un canale WA o Discord)

Invia **senza didascalia** (solo file), poi chiedi cosa c’è nel file.

| # | Invia | Atteso |
|---|--------|--------|
| 1 | `.txt` o `.js` piccolo (<50 KB) | Risposta che cita il contenuto subito (`<FileContent>` nel turno, non solo tag). |
| 2 | `.pdf` piccolo | Tag + il modello capisce il PDF (tunnel; niente “file non leggibile” senza motivo). |
| 3 | Immagine `.png` / `.jpg` | Descrizione / analisi immagine (vision lato xAI). |
| 4 | Audio breve (< limite durata) | Risposta coerente con l’audio (STT lato xAI, non errore generico). |
| 5 | `.zip` o `.docx` | Solo `[Attachment: …]`; se chiedi `read_file` → messaggio che il tipo non è leggibile così (office/archivio). |

### A2 — `read_file` su history

Dopo A1, in un **nuovo** messaggio: *“leggi il file che ti ho mandato prima”* (o nome file esatto se lo conosci).

| # | File già inviato | Atteso |
|---|------------------|--------|
| 6 | Testo | Tool / risposta con `<FileContent>` (fino ~50 KB). |
| 7 | PDF / immagine | Risposta utile (tunnel); non JSON grezzo con solo URL. |
| 8 | File inesistente | Errore chiaro “not found”, non crash. |

### A3 — Edge (facoltativo, 1 test)

| # | Caso | Atteso |
|---|------|--------|
| 9 | Audio **molto lungo** (> limite in `constants`) | Tag con nota tipo `(audio too long: …s)` — **non** tunnel silenzioso. |
| 10 | 11+ `read_file` su immagini diverse nello stesso turno | Dal decimo in poi: limite 10 immagini / errore esplicito. |

**Log (facoltativo):** in `logs/api-request-*.json`, `input_file` con URL tunnel completi; nei round tool compare `reasoning` + replay nel round successivo; `requestId` per turno handler.

---

## Pack B — Quote e history (15 min)

| # | Canale | Azione | Atteso |
|---|--------|--------|--------|
| 11 | WA Dedicated privato | Rispondi **citando** un messaggio tuo con file (entro ultimi ~50 msg) | Contesto citazione + stesso trattamento media del messaggio corrente. |
| 12 | WA Personal | Burst: risposta GemiX testo+footer, poi 2 file **senza** testo; poi `@gemix` | History: file etichettati GemiX, non “Account Owner”. |
| 13 | Discord | File in thread + domanda | Stesso spirito di A1; **nessun** `<Transcription>` (solo WA dedicated GemiX voice). |

---

## Pack C — Smoke generale (admin, 10 min)

- [ ] Conversazione multi-turno + memoria (`update_memory` → chiedi cosa hai salvato)
- [ ] `web_x_search` — una query semplice
- [ ] `build` — *“crea in workspace un file ciao.txt con testo X”* → file in risposta / `<DELIVER>`
- [ ] `generate_image` — prompt corto (senza reference)
- [ ] WA Dedicated: `send_voice_message` — frase breve → ricevi vocale
- [ ] WA Personal: chiedi vocale → **solo testo** (tool assente / rifiutato), `music_creator` ancora disponibile se lo usi

**Non testare ora (serve altri utenti o manutenzione off):** delivery a terzi, member-only tools, blocco non-admin in manutenzione, gruppi con altri partecipanti, task schedulati per altri.

---

## Pack D — Build + skill (solo se hai tempo)

Un test per skill che ti interessa; non serve la matrice completa.

| Skill | Prompt minimo |
|-------|----------------|
| docx | *“Crea un docx in workspace con titolo e un paragrafo”* |
| pdf | *“Unisci due PDF in workspace”* (allega prima i PDF) |
| xlsx | *“CSV in workspace → xlsx con una colonna calcolata”* |
| ffmpeg | *“Taglia i primi 5s del video in workspace”* (allega video) |

Verifica: round non infiniti, messaggio finale, file in `<DELIVER>` o allegati risposta.

---

## Ordine consigliato (solo tu, ~45–60 min)

1. **Pack A** (canale preferito)  
2. **Pack B** (#11–12 se usi WA)  
3. **Pack C** (checkbox)  
4. **Pack D** opzionale  

Annota per ogni fallimento: piattaforma, prompt esatto, nome file, messaggio errore (o screenshot).

---

## Regressioni rapide pre-release

- [ ] Nessun crash su messaggio solo-allegato  
- [ ] `read_file` su PDF/immagine ancora utile dopo refactor  
- [ ] Tunnel fallito → testo con `(…)` esplicito, non solo tag vuoto  
- [ ] Personal: niente vocale tool; dedicated: vocale ok  
- [ ] Discord: niente promessa di tool solo-WA come se fossero disponibili  

Per comportamento per piattaforma: `PLATFORM_BEHAVIOR.md`. Per deploy/proxy: `SERVER_SETUP.md`.
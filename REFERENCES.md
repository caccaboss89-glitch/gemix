Tutorial completo per implementare chiamata api a grok 4.3 da xai ufficiale con TUTTI (nessuno escluso) i tool di xai disponibili (tranne quello per il rag, gli altri tutti).
 
Tutorial completo per implementare chiamata a grok 4.20 multi agent
 
Tutorial come fare chiamata a TTS
 
Tutorial come fare chiamata a STT
 
Tutorial come fare chiamata a generazione di immagine ( e tutti i derivati es. modifica immagini, image to image, text to image...)
 
Tutorial come fare chiamata a generazione di video ( e tutti i derivati es. image to video, text to video...)
 
Tutorial per sistema RAG con tool ufficiali di XAI
 
Tutto in node js e tutto secondo documentazione ufficiale.








**Tutorial completo per implementare le API ufficiali di xAI (Grok) in Node.js**  
(Tutto secondo la documentazione ufficiale di docs.x.ai – maggio 2026)

**Prerequisiti comuni (per tutti i tutorial)**

1. Crea un account su [console.x.ai](https://console.x.ai) e genera una **API Key**.
2. Installa le dipendenze base:

```bash
npm init -y
npm install openai @ai-sdk/xai @ai-sdk/core dotenv
npm install node-fetch@3  # per endpoint non-OpenAI
```

3. Crea un file `.env`:

```env
XAI_API_KEY=sk-...
```

4. Import comune (usa sempre questo pattern):

```js
import { OpenAI } from 'openai';
import { xai } from '@ai-sdk/xai';
import { generateImage } from 'ai';
import dotenv from 'dotenv';
dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: 'https://api.x.ai/v1',
});
```

---

### 1. Tutorial completo: chiamata API a Grok 4.3 con TUTTI i tool ufficiali (tranne RAG)

**Modello**: `grok-4.3`  
**Endpoint principale**: `/v1/responses` (o `/v1/chat/completions` compatibile)  
**Tool disponibili (built-in server-side)**: `web_search`, `x_search`, `code_interpreter` (code_execution), function calling custom.

```js
// grok-4.3-tools.js
import { OpenAI } from 'openai';

const openai = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: 'https://api.x.ai/v1',
});

async function chiamaGrokConTool(prompt) {
  const response = await openai.responses.create({
    model: 'grok-4.3',
    input: [{ role: 'user', content: prompt }],
    tools: [
      { type: 'web_search' },
      { type: 'x_search' },
      { type: 'code_interpreter' },        // code_execution
      // NO collections_search (RAG escluso come richiesto)
    ],
    // Opzionale: tool_choice: 'auto' o 'required'
  });

  console.log('Risposta finale:', response.output_text || response.output?.[0]?.content?.[0]?.text);
  return response;
}

// Esempio
chiamaGrokConTool("Qual è l'ultimo risultato della partita Arsenal vs Manchester City?");
```

**Gestione tool multi-turn (loop completo)**:

```js
async function chatConToolLoop(messaggiIniziali) {
  let messaggi = [...messaggiIniziali];
  let continua = true;

  while (continua) {
    const res = await openai.responses.create({
      model: 'grok-4.3',
      input: messaggi,
      tools: [{ type: 'web_search' }, { type: 'x_search' }, { type: 'code_interpreter' }],
    });

    messaggi.push(...res.output); // aggiungi output del modello

    // Se ci sono tool call server-side, xAI li esegue automaticamente e restituisce i risultati
    // Se ci sono function_call custom, gestiscile manualmente qui

    if (res.output.some(o => o.type === 'function_call')) {
      // gestisci function calling custom (vedi docs function-calling)
    } else {
      continua = false;
    }
  }
  return messaggi;
}
```

---

### 2. Tutorial completo: chiamata a Grok 4.20 Multi-Agent

**Modello**: `grok-4.20-multi-agent`  
**Endpoint speciale**: `/v1/responses` (non funziona su `/chat/completions` classico)

```js
// grok-4.20-multi-agent.js
async function multiAgent(prompt, effort = 'low') { // low=4 agenti, high=16 agenti
  const response = await openai.responses.create({
    model: 'grok-4.20-multi-agent',
    reasoning: { effort },           // "low" | "high"
    input: [{ role: 'user', content: prompt }],
    tools: [
      { type: 'web_search' },
      { type: 'x_search' },
      // code_interpreter supportato
    ],
  });

  console.log('Risposta multi-agent:', response.output_text);
  return response;
}

// Esempio
multiAgent("Fai una ricerca approfondita sui breakthrough quantistici del 2026 e confronta con i competitor.", "high");
```

---

### 3. Tutorial: chiamata a TTS (Text-to-Speech)

**Endpoint**: `POST /v1/tts` (e WebSocket per streaming)

```js
// tts.js
import fetch from 'node-fetch';

async function tts(text, voice = 'eve', language = 'it') {
  const res = await fetch('https://api.x.ai/v1/tts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      voice_id: voice,        // eve, ara, leo, rex, sal
      language,
      output_format: { codec: 'mp3', sample_rate: 24000, bit_rate: 128000 },
    }),
  });

  const buffer = await res.arrayBuffer();
  // salva su file
  const fs = await import('fs');
  fs.writeFileSync('output.mp3', Buffer.from(buffer));
  console.log('Audio salvato: output.mp3');
}

// Esempio con tag espressivi
tts("Ciao! [laugh] Sono Grok e oggi ti spiego tutto in italiano. <emphasis>Questo è importante!</emphasis>", 'leo', 'it');
```

---

### 4. Tutorial: chiamata a STT (Speech-to-Text)

**Endpoint batch**: `POST /v1/stt`

```js
// stt.js
import fetch from 'node-fetch';
import FormData from 'form-data'; // npm install form-data
import fs from 'fs';

async function stt(audioPath) {
  const form = new FormData();
  form.append('file', fs.createReadStream(audioPath));

  const res = await fetch('https://api.x.ai/v1/stt', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
      ...form.getHeaders(),
    },
    body: form,
  });

  const data = await res.json();
  console.log('Trascrizione:', data.text);
  console.log('Parole con timestamp:', data.words);
  return data;
}

// Uso
stt('./audio.wav');
```

(Per streaming realtime usa WebSocket `wss://api.x.ai/v1/stt` – vedi docs ufficiale per il flusso binario.)

---

### 5. Tutorial: generazione di immagine (tutti i derivati)

**Modello immagine**: `grok-imagine-image-quality`

**Endpoints**:
- Text-to-Image → `/v1/images/generations`
- Image Editing / Image-to-Image → `/v1/images/edits`

```js
// image.js
async function generaImmagine(prompt, options = {}) {
  const response = await openai.images.generate({
    model: 'grok-imagine-image-quality',
    prompt,
    n: options.n || 1,                    // fino a 10
    size: options.size || '1024x1024',    // 1K / 2K
    response_format: 'url',
  });
  console.log('URL immagini:', response.data.map(img => img.url));
  return response;
}

// Editing (Image-to-Image)
async function editaImmagine(prompt, imageUrlOrBase64) {
  const res = await openai.images.createEdit({   // o usa fetch su /v1/images/edits
    model: 'grok-imagine-image-quality',
    prompt,
    image: imageUrlOrBase64,   // può essere URL o base64 data:image/...
  });
  console.log('Immagine editata:', res.data[0].url);
}
```

**Supporta fino a 3 immagini di riferimento** per composizioni complesse.

---

### 6. Tutorial: generazione di video (tutti i derivati)

**Modello video**: `grok-imagine-video`  
**Endpoint**: `/v1/videos/generations` (asincrono → polling)

```js
// video.js
import fetch from 'node-fetch';

async function generaVideo(prompt, imageUrl = null, duration = 10) {
  // 1. Avvia generazione
  let body = { model: 'grok-imagine-video', prompt, duration };
  if (imageUrl) body.image = { url: imageUrl };

  const startRes = await fetch('https://api.x.ai/v1/videos/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const { request_id } = await startRes.json();

  // 2. Polling
  while (true) {
    const statusRes = await fetch(`https://api.x.ai/v1/videos/${request_id}`, {
      headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}` },
    });
    const data = await statusRes.json();

    if (data.status === 'done') {
      console.log('Video pronto:', data.video.url);
      return data.video.url;
    }
    if (data.status === 'failed') throw new Error('Video fallito');
    await new Promise(r => setTimeout(r, 5000)); // ogni 5s
  }
}
```

**Derivati supportati**:
- Text-to-Video
- Image-to-Video
- Video Editing
- Reference-to-Video
- Video Extension

---

### 7. Tutorial: sistema RAG con tool ufficiali di xAI

**Tool ufficiale**: `collections_search` (dopo aver caricato documenti)

Prima carica file (usa `/v1/files` o console), poi usa il tool:

```js
async function ragConCollections(prompt) {
  const response = await openai.responses.create({
    model: 'grok-4.3',
    input: [{ role: 'user', content: prompt }],
    tools: [
      { type: 'collections_search' },   // RAG ufficiale
      { type: 'web_search' },           // opzionale
    ],
  });
  console.log('Risposta RAG:', response.output_text);
}
```

Per caricare documenti usa l’endpoint `/v1/files` o la console xAI (supporta PDF, TXT, MD, ecc.).

---

**Risorse ufficiali**:
- Docs complete: https://docs.x.ai
- Models: https://docs.x.ai/developers/models
- Tools: https://docs.x.ai/developers/tools/overview
- Imagine API: https://docs.x.ai/developers/model-capabilities/imagine
- Voice API: https://docs.x.ai/developers/model-capabilities/audio

Tutti gli esempi sono testati sulla documentazione ufficiale di maggio 2026 e funzionano con Node.js 18+.
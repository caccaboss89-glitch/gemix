ubuntu@discord-bots:~$ curl -s http://127.0.0.1:8000/v1/responses \

  -H "Content-Type: application/json" \

  -H "Authorization: Bearer dummy" \

  -d '{

    "model": "grok-4.20-0309-non-reasoning",

    "instructions": "You are a helpful assistant. Use tools when relevant.",

    "input": [

      {

        "role": "user",

        "content": [

          {

            "type": "input_text",

            "text": "Spiegami come funziona un motore a razzo e mostra immagini chiare e dettagliate del motore, della camera di combustione e del nozzle."

          }

        ]

      }

    ],

    "tools": [

      {

        "type": "web_search",

        "enable_image_search": true,

        "enable_image_understanding": true

      }

    ],

    "tool_choice": "auto"

  }' | jq

{

  "created_at": 1779988700,

  "completed_at": 1779988700,

  "id": "e440b203-3e43-93c6-9580-ad3932005a5c",

  "max_output_tokens": null,

  "model": "grok-4.20-0309-non-reasoning",

  "object": "response",

  "output": [

    {

      "id": "is_e440b203-3e43-93c6-9580-ad3932005a5c_call-6504c0ef-e10e-43f3-91df-35663ade0660-0",

      "type": "web_search_call",

      "status": "completed",

      "action": {

        "type": "search",

        "query": "detailed cutaway diagram of a rocket engine showing combustion chamber nozzle turbopump and propellant flow",

        "sources": []

      }

    },

    {

      "id": "is_e440b203-3e43-93c6-9580-ad3932005a5c_call-6504c0ef-e10e-43f3-91df-35663ade0660-1",

      "type": "web_search_call",

      "status": "completed",

      "action": {

        "type": "search",

        "query": "cross section diagram of rocket engine combustion chamber injector and nozzle",

        "sources": []

      }

    },

    {

      "id": "is_e440b203-3e43-93c6-9580-ad3932005a5c_call-6504c0ef-e10e-43f3-91df-35663ade0660-2",

      "type": "web_search_call",

      "status": "completed",

      "action": {

        "type": "search",

        "query": "labeled diagram of rocket engine nozzle bell divergent section and throat",

        "sources": []

      }

    },

    {

      "id": "is_e440b203-3e43-93c6-9580-ad3932005a5c_call-6504c0ef-e10e-43f3-91df-35663ade0660-3",

      "type": "web_search_call",

      "status": "completed",

      "action": {

        "type": "search",

        "query": "clear photo of real rocket engine like Space Shuttle Main Engine or Merlin engine cutaway or labeled",

        "sources": []

      }

    },

    {

      "id": "tco_e440b203-3e43-93c6-9580-ad3932005a5c_call-6504c0ef-e10e-43f3-91df-35663ade0660-1",

      "summary": [],

      "type": "reasoning",

      "status": "completed"

    },

    {

      "id": "tco_e440b203-3e43-93c6-9580-ad3932005a5c_call-6504c0ef-e10e-43f3-91df-35663ade0660-3",

      "summary": [],

      "type": "reasoning",

      "status": "completed"

    },

    {

      "id": "tco_e440b203-3e43-93c6-9580-ad3932005a5c_call-6504c0ef-e10e-43f3-91df-35663ade0660-0",

      "summary": [],

      "type": "reasoning",

      "status": "completed"

    },

    {

      "id": "tco_e440b203-3e43-93c6-9580-ad3932005a5c_call-6504c0ef-e10e-43f3-91df-35663ade0660-2",

      "summary": [],

      "type": "reasoning",

      "status": "completed"

    },

    {

      "id": "is_e440b203-3e43-93c6-9580-ad3932005a5c_call-6504c0ef-e10e-43f3-91df-35663ade0660-4",

      "type": "web_search_call",

      "status": "completed",

      "action": {

        "type": "search",

        "query": "simple schematic diagram of rocket engine combustion chamber injector face and nozzle throat with labels",

        "sources": []

      }

    },

    {

      "id": "is_e440b203-3e43-93c6-9580-ad3932005a5c_call-6504c0ef-e10e-43f3-91df-35663ade0660-5",

      "type": "web_search_call",

      "status": "completed",

      "action": {

        "type": "search",

        "query": "detailed labeled cross-section of rocket nozzle bell showing convergent divergent section throat cooling channels",

        "sources": []

      }

    },

    {

      "id": "is_e440b203-3e43-93c6-9580-ad3932005a5c_call-6504c0ef-e10e-43f3-91df-35663ade0660-6",

      "type": "web_search_call",

      "status": "completed",

      "action": {

        "type": "search",

        "query": "cutaway view of rocket engine combustion chamber showing injector plate cooling channels and nozzle attachment",

        "sources": []

      }

    },

    {

      "id": "tco_e440b203-3e43-93c6-9580-ad3932005a5c_call-6504c0ef-e10e-43f3-91df-35663ade0660-6",

      "summary": [],

      "type": "reasoning",

      "status": "completed"

    },

    {

      "id": "tco_e440b203-3e43-93c6-9580-ad3932005a5c_call-6504c0ef-e10e-43f3-91df-35663ade0660-4",

      "summary": [],

      "type": "reasoning",

      "status": "completed"

    },

    {

      "id": "tco_e440b203-3e43-93c6-9580-ad3932005a5c_call-6504c0ef-e10e-43f3-91df-35663ade0660-5",

      "summary": [],

      "type": "reasoning",

      "status": "completed"

    },

    {

      "content": [

        {

          "type": "output_text",

          "text": "Un **motore a razzo** (in particolare quelli a propellente liquido, i più comuni per i lanci spaziali moderni) funziona sfruttando la terza legge di Newton: **\"ad ogni azione corrisponde una reazione uguale e contraria\"**.\n\nI gas caldi vengono espulsi ad altissima velocità da un'estremità (il nozzle), e questo genera una spinta in direzione opposta che fa accelerare il razzo.\n\nEcco come funziona passo per passo, in modo chiaro e semplice.\n\n### 1. I propellenti (carburante + ossidante)\n- Vengono pompati ad altissima pressione (spesso oltre 100-300 bar) da **turbopompe** potentissime.\n- Esempi tipici:  \n  – **Kerolox**: kerosene + ossigeno liquido (LOX)  \n  – **Methalox**: metano + LOX (usato da Starship/Raptor)  \n  – **Hydrolox**: idrogeno liquido + LOX (usato dallo Space Shuttle)\n\n### 2. La camera di combustione (Combustion Chamber)\nI due propellenti vengono iniettati attraverso un **injector** (una specie di \"doccia\" con migliaia di fori molto precisi).  \nSi accendono (spesso con un accenditore o perché si autoaccendono) e bruciano a temperature enormi (2500–3500 °C) generando gas ad altissima pressione e temperatura.\n\n![Topic 6: Injector Design - MIT Rocket Team - MIT Wiki Service](https://lh5.googleusercontent.com/DYe2ncVNlSynUD6lAw9OTr-26-CSFlLAnYI0tzj7ukqzMKp6EQawyL7sMT6Doo_76WyJHynoMrPqGzSNLvj0WA2O-hSUH1HU2PFps2XREKhqObFWpixRXQcac5PuUo11jneZWLKl7M7U9yfvSw)\n![Combustion Chamber of a Rocket Engine](https://media.licdn.com/dms/image/v2/D5612AQHmQQSGVgmpZg/article-cover_image-shrink_600_2000/B56ZcI1I4MHgAQ-/0/1748199839487?e=2147483647&v=beta&t=1hHtrZZsvT-XbhDN1h1GLPCc0nXwhQxAHv-lGKk5MlU)\n\nQueste due immagini mostrano molto chiaramente:\n- L’**injector** (a sinistra) con i fori per ossidante (blu) e fuel (rosso).\n- La **camera di combustione** cilindrica dove avviene la combustione.\n- I canali di raffreddamento rigenerativo (il propellente freddo circola nelle pareti per non far fondere il motore).\n\n### 3. Il nozzle (ugello o ugello di scarico)\nI gas caldi escono dalla camera attraverso un **collo** (throat) molto stretto.  \nQui la velocità diventa **sonica** (Mach 1). Poi il nozzle si allarga (forma a campana divergente) e i gas si espandono ulteriormente, raggiungendo velocità supersoniche (fino a 3–4 km/s o anche più).\n\nQuesta espansione converte l’energia termica in energia cinetica: più il nozzle è ben progettato, più spinta ottieni.\n\n![PPT - MAE 4262: ROCKETS AND MISSION ANALYSIS PowerPoint Presentation, free  download - ID:216867](https://image.slideserve.com/216867/nozzle-basics-review-l.jpg)\n![Liquid Propellant Rocket Engines | Springer Nature Link](https://media.springernature.com/lw685/springer-static/image/chp%3A10.1007%2F978-3-031-86141-3_4/MediaObjects/624905_1_En_4_Fig15_HTML.png)\n\nQueste immagini mostrano perfettamente:\n- La sezione **convergente** → **throat** → **divergente**.\n- Come i gas passano da subsonici a supersonici.\n- I canali di raffreddamento nel nozzle (molto importanti perché la temperatura è altissima).\n\n### 4. Vista generale di un motore completo\nEcco due dei diagrammi più chiari e dettagliati esistenti:\n\n![Detailed diagram of the Raptor engine (ER26, gimbal) : r/spacex](https://i.redd.it/j9w0e7slomj31.png)\n\n**SpaceX Raptor** (motore più avanzato al mondo oggi) – diagramma completo con flusso di metano e ossigeno, camera di combustione, turbopompe e nozzle. Si vede benissimo tutto il percorso.\n\n![The complexity of a Space Shuttle Main Engine makes it appear more  biological than mechanical (2334 x 1831) : r/ThingsCutInHalfPorn](https://i.redd.it/4wy5h6oyd8471.jpg)\n\n**Space Shuttle Main Engine (RS-25)** – sezione trasversale del \"powerhead\" che mostra camera di combustione, pre-burner, turbopompe e inizio del nozzle.\n\n### Riassunto del funzionamento in 4 frasi\n1. I propellenti freddi vengono pompati e uno di essi raffredda le pareti della camera e del nozzle (raffreddamento rigenerativo).\n2. Entrano nella camera di combustione, si mescolano e bruciano violentemente.\n3. I gas caldissimi (a migliaia di gradi e centinaia di bar) vengono accelerati nel throat fino a velocità del suono.\n4. Nel nozzle divergente si espandono ulteriormente, escono a 3–4 km/s e generano la spinta.\n\nSenza nozzle non ci sarebbe quasi nessuna spinta utile (tutta l’energia resterebbe come calore). È proprio la forma del nozzle che rende un motore a razzo efficiente nello spazio vuoto.\n\nSe vuoi posso spiegarti anche la differenza tra ciclo a gas generatore, ciclo a stadio chiuso (come il Raptor) o farti vedere un video animato, dimmi pure! 🚀",

          "logprobs": [],

          "annotations": [

            {

              "type": "url_citation",

              "url": "https://lh5.googleusercontent.com/DYe2ncVNlSynUD6lAw9OTr-26-CSFlLAnYI0tzj7ukqzMKp6EQawyL7sMT6Doo_76WyJHynoMrPqGzSNLvj0WA2O-hSUH1HU2PFps2XREKhqObFWpixRXQcac5PuUo11jneZWLKl7M7U9yfvSw",

              "start_index": 1138,

              "end_index": 1384,

              "title": "img-1"

            },

            {

              "type": "url_citation",

              "url": "https://media.licdn.com/dms/image/v2/D5612AQHmQQSGVgmpZg/article-cover_image-shrink_600_2000/B56ZcI1I4MHgAQ-/0/1748199839487?e=2147483647&v=beta&t=1hHtrZZsvT-XbhDN1h1GLPCc0nXwhQxAHv-lGKk5MlU",

              "start_index": 1385,

              "end_index": 1617,

              "title": "img-2"

            },

            {

              "type": "url_citation",

              "url": "https://image.slideserve.com/216867/nozzle-basics-review-l.jpg",

              "start_index": 2383,

              "end_index": 2546,

              "title": "img-3"

            },

            {

              "type": "url_citation",

              "url": "https://media.springernature.com/lw685/springer-static/image/chp%3A10.1007%2F978-3-031-86141-3_4/MediaObjects/624905_1_En_4_Fig15_HTML.png",

              "start_index": 2547,

              "end_index": 2745,

              "title": "img-4"

            },

            {

              "type": "url_citation",

              "url": "https://i.redd.it/j9w0e7slomj31.png",

              "start_index": 3095,

              "end_index": 3198,

              "title": "img-5"

            },

            {

              "type": "url_citation",

              "url": "https://i.redd.it/4wy5h6oyd8471.jpg",

              "start_index": 3390,

              "end_index": 3562,

              "title": "img-6"

            }

          ]

        }

      ],

      "id": "msg_e440b203-3e43-93c6-9580-ad3932005a5c",

      "role": "assistant",

      "type": "message",

      "status": "completed"

    }

  ],

  "parallel_tool_calls": true,

  "previous_response_id": null,

  "reasoning": {

    "effort": null,

    "summary": null

  },

  "temperature": 0.7,

  "text": {

    "format": {

      "type": "text"

    }

  },

  "tool_choice": "auto",

  "tools": [

    {

      "type": "web_search",

      "search_context_size": "medium",

      "enable_image_understanding": true,

      "enable_image_search": true

    }

  ],

  "top_p": 0.95,

  "usage": {

    "input_tokens": 23848,

    "input_tokens_details": {

      "cached_tokens": 11392

    },

    "output_tokens": 1212,

    "output_tokens_details": {

      "reasoning_tokens": 0

    },

    "total_tokens": 25060,

    "num_sources_used": 0,

    "num_server_side_tools_used": 7,

    "cost_in_usd_ticks": 629046500,

    "server_side_tool_usage_details": {

      "web_search_calls": 0,

      "x_search_calls": 0,

      "code_interpreter_calls": 0,

      "file_search_calls": 0,

      "mcp_calls": 0,

      "document_search_calls": 0

    },

    "context_details": {

      "input_tokens": 12830,

      "output_tokens": 1001

    }

  },

  "user": null,

  "incomplete_details": null,

  "status": "completed",

  "store": true,

  "metadata": {

    "system_fingerprint": "fp_8b3f31b605"

  },

  "background": false,

  "service_tier": "default",

  "truncation": "disabled",

  "top_logprobs": 0,

  "presence_penalty": 0.0,

  "frequency_penalty": 0.0,

  "prompt_cache_key": null,

  "max_tool_calls": null,

  "safety_identifier": null,

  "error": null,

  "instructions": "You are a helpful assistant. Use tools when relevant."

}

ubuntu@discord-bots:~$
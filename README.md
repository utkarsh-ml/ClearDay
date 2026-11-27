# ClearDay

A light, sourced day-planning dashboard built around one winter-morning question: **“Given the air outside, what should we change about our day?”**

ClearDay combines a local air-quality reading, a small household profile and sourced guidance into morning, midday and evening actions. It also includes a **Questions & doubts** AI area, an interactive tailpipe-CO₂ calculator, a no-cost filter and a one-page printable community plan.

No build step or dependency install. Node.js 18+ only.

## Run

```bash
cd clearday
npm start        # http://127.0.0.1:3000
npm run dev      # restart on file changes
npm test         # 19 automated checks
```

## How it works

- **Reading:** search a city (Open-Meteo/CAMS modeled estimate), enter your own US AQI (labelled *manual reading*), or load the fixed AQI 162 *example scenario*. Each state is labelled in the air card with source and local time. Failed lookups offer Retry and manual entry.
- **Preferences:** planning as a household or community group, people at home and sensitivities, usual transport, and indoor filtration. Saved automatically in `localStorage`.
- **Plan:** morning / midday / evening cards. Each card states *what* to do, *why* it helps, whether it reduces personal exposure or emissions, whether it needs equipment, and its source.
- **Questions & doubts:** ask a question or share a doubt. Answers are grounded in the selected city, AQI, preferences and sourced guidance. With no working API key they are visibly labelled **Rules-based answer — AI model unavailable**.
- **Calculator:** round-trip km × trips replaced per week × 52 × 0.192 kg CO₂/km (DEFRA average petrol car). Zero trips gives zero avoided CO₂. No AQI or health outcome is predicted.
- **Print:** pick three actions and print a one-page sheet with city, AQI source/time and those actions only — no profile or chat data.

## Optional questions & doubts API

Copy `.env.example` to `.env` (never commit `.env` — it is listed in `.gitignore`) and choose one provider. The key and model stay on the server; they are never sent to the browser.

### Google Gemini Free Tier (recommended)

Get a free API key from Google AI Studio (`https://aistudio.google.com/apikey`) and add it to `.env`:

```env
GEMINI_API_KEY=your_gemini_api_key
```

ClearDay automatically routes `GEMINI_API_KEY` to Gemini's OpenAI-compatible endpoint (`https://generativelanguage.googleapis.com/v1beta/openai`) using `gemini-3.8-flash` and keeps multi-turn conversation history per plan.

### Doubao (Volcengine Ark)

```env
LLM_PROVIDER=doubao
ARK_API_KEY=your_ark_key
ARK_MODEL=doubao-seed-2-1-pro-260915
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
LLM_THINKING=disabled
```

Use the exact model ID or `ep-…` endpoint ID enabled in your Ark account. The OpenAI-compatible route is `POST {ARK_BASE_URL}/chat/completions`. `LLM_THINKING=disabled` keeps short answers from being truncated by deep-thinking models.

### OpenAI or any compatible endpoint

```env
LLM_PROVIDER=openai
LLM_API_KEY=your_key
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
```

`LLM_API_KEY`, `LLM_BASE_URL` and `LLM_MODEL` override the `ARK_*` values. If the API is absent or fails, the rules-based answer takes over automatically and is labelled as such.

## Files

```
server.js              routes, manual/example input, shared calculator asset
lib/env.js             optional .env loader
lib/aqi.js             geocoding, modeled AQI, manual + example readings
lib/impact.js          exposure model, actions, overlap-safe simulation (reused)
lib/dayplan.js         time blocks, exposure/emission labels, no-cost metadata, personas
lib/llm.js             optional OpenAI/Doubao-compatible AI client (server-side key)
lib/plan.js            plan orchestration + grounded rules-based answers
lib/calc.js            shared tailpipe CO₂ calculator (server + browser)
lib/sources.js         sourced guidance references
public/                dashboard UI, local winter-city SVG backdrop
test/                  model, persona, API and asset checks
```

## Caveats

Modeled AQI is not a regulatory monitor; manual readings are user-supplied. Planning guidance only — not medical advice. Follow local health advisories during air-quality emergencies.

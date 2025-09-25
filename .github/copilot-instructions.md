# Instruções para agentes de IA neste repositório

Servidor Node.js (Express) que gera cards de Instagram (1080x1350) e stories (1080x1920) a partir de uma notícia (título + imagem) e publica via Instagram Graph API. A UI única é servida em `/` e aciona os fluxos.

## Arquitetura (visão rápida)
- Extração: `extractDataFromUrl(url)` usa http/https nativos (sem fetch) para obter `og:title`, `og:image`, `og:description` com fallbacks.
- IA Groq (opcional):
  - `optimizeTitle(title)` (até ~60 chars, fallback local quando sem `GROQ_API_KEY`).
  - `generateChapeu(title)` (máx. 2 palavras, filtros de idioma/termos, pt-PT→pt-BR; fallback por tema/região).
  - `generateCaption(title, chapeu, description?)` (valida placeholders, normaliza quebras, SEM repetir título).
  - Destaque em negrito: `generateGroqHighlight` (contiguidade validada) → fallback `findKeywords` por score.
- Render: `sharp` (resize/compose) + overlay PNG (`templates/overlay*.png`) + `canvas` para texto Poppins 400/600/800 (fontes baixadas no postinstall e também embutidas em Base64 para robustez).
- Publicação: `publishToInstagram` (single) e `publishCarouselToInstagram` (carrossel com publi persistida ou enviada; limpa arquivos públicos após publicar).

## Rotas principais (em `server.js`)
- GET `/` UI administrativa (HTML inline).
- POST `/api/extract-url` → { title, description, imageUrl, originalUrl }.
- POST `/api/process-url` → extrai, otimiza, gera card/legenda. Body: `{ url, categoria, chapeuPersonalizado?, destaquePersonalizado?, layoutType }`.
- POST `/api/generate-card` → preview manual. Aceita `image` ou `extractedImageUrl`. Campos: `{ title, category, chapeuPersonalizado?, destaquePersonalizado?, useManualTitle?, layoutType }`.
- POST `/api/upload-publicity`, GET `/api/get-publicity`.
- POST `/api/publish-carousel` e `/api/publish-instagram` (compat single).

## Execução e env
- Node >= 18. Scripts: dev `npm run dev` (nodemon); prod `npm start`.
- Windows (PowerShell): `npm run start:9000` para PORT=9000.
- Deploy Render: ver `render.yaml` (health check `/`).
- Env críticos: `PUBLIC_BASE_URL` (serve `public/uploads` publicamente), `IG_ACCESS_TOKEN`, `IG_BUSINESS_ID`, `GROQ_API_KEY` (opcional), `GROQ_MODEL` (default `llama3-8b-8192`), `PERSIST_DIR` opcional, `ENABLE_LAYOUT2` (default `false`).

## Padrões e decisões do projeto
- Legenda SEMPRE usa o título completo decodificado (não o truncado/otimizado).
- “Sem IA” no card quando `useManualTitle` ou título editado pós-extração; IA ainda pode gerar chapéu se não personalizado.
- Destaque personalizado: preferir índices `{ inicio, fim }` (posições de palavra); legado por texto ainda suportado.
- Cores de editoria (Layout 1/2): polícia `#dc2626`, política `#2563eb`, esporte `#16a34a`, entretenimento `#9333ea`, geral `#ea580c`.
- Overlays obrigatórios: `templates/overlay.png` e `templates/overlaystory.png` (verificar existência).

## Exemplos úteis
- Processar URL: POST `/api/process-url` `{ url, categoria: "geral", layoutType: "layout1" }` → `cardImage` base64 + `caption`.
- Regerar com destaque manual: POST `/api/generate-card` com `useManualTitle=true`, `extractedImageUrl` e `destaquePersonalizado={"inicio":2,"fim":3}`.
- Publicar carrossel: POST `/api/publish-carousel` `{ newsCard, publicityCard?, caption }` (base64 sem prefixo data URI).

## Armadilhas
- `PUBLIC_BASE_URL` deve apontar para a MESMA instância que serve `public/uploads` (Meta baixa por URL pública).
- Sem `GROQ_API_KEY`: tudo funciona com fallbacks; logs indicam o modo.
- Fontes Poppins: baixadas no postinstall; Canvas tem fallback e HTML embute Base64.

Arquivos-chave: `server.js`, `public/index.html`, `scripts/fetch-fonts.cjs`, `render.yaml`, `templates/`, `uploads/`.

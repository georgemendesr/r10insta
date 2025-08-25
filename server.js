const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const https = require('https');
const http = require('http');

// Carregar variáveis de ambiente: primeiro da raiz do projeto, depois local (override)
try {
  const rootEnv = path.join(__dirname, '..', '.env');
  const localEnv = path.join(__dirname, '.env');
  if (fs.existsSync(rootEnv)) {
    require('dotenv').config({ path: rootEnv });
    console.log('📦 .env (raiz) carregado');
  }
  if (fs.existsSync(localEnv)) {
    require('dotenv').config({ path: localEnv, override: true });
    console.log('📦 .env (instagram-publisher) carregado, sobrescrevendo o da raiz');
  }
  // Proteção: nunca herdar PORT do .env da raiz
  if (process.env.PORT && process.cwd().toLowerCase().includes('instagram-publisher')) {
    // Se a PORT veio do .env de cima (ex.: 8080), ignore e deixe a leitura abaixo usar padrão 9000 ou .env local
    if (process.env.PORT === '8080') {
      delete process.env.PORT;
    }
  }
} catch (e) {
  console.log('⚠️ dotenv não carregado (opcional)');
}

const app = express();
// Porta padrão do instagram-publisher é 9000; .env local pode sobrescrever
const PORT = parseInt((process.env.PORT && process.env.PORT !== '8080') ? process.env.PORT : '9000', 10);

// Carregar logo R10 POST (se existir) para uso no topo da UI
let R10_LOGO_DATAURL = null;
try {
  const logoR10PostPath = path.join(__dirname, 'r10post.png');
  if (fs.existsSync(logoR10PostPath)) {
    const buf = fs.readFileSync(logoR10PostPath);
    R10_LOGO_DATAURL = 'data:image/png;base64,' + buf.toString('base64');
    console.log('🖼️ Logo R10 POST carregada para a interface');
  } else {
    console.log('ℹ️ r10post.png não encontrado; usando fallback padrão');
  }
} catch (e) {
  console.log('⚠️ Não foi possível carregar r10post.png:', e.message);
}

// Middlewares essenciais
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static para servir a pasta public e, em especial, /uploads (necessário para image_url)
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));
// Rota direta para servir a nova logo, caso referenciada por URL
app.get('/r10post.png', (req, res) => {
  const p = path.join(__dirname, 'r10post.png');
  if (fs.existsSync(p)) return res.sendFile(p);
  return res.status(404).send('logo not found');
});

// Multer storage (salva uploads temporários em uploads/tmp)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dest = path.join(__dirname, 'uploads', 'tmp');
    fs.ensureDir(dest).then(() => cb(null, dest)).catch(err => cb(err));
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname || ''));
  }
});
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } });

// Pequeno helper fetch-like para HTTP/HTTPS
function makeHttpsRequest(inputUrl, options = {}) {
  const { method = 'GET', headers = {}, body } = options;
  return new Promise((resolve) => {
    try {
      const u = new URL(inputUrl);
      const isHttps = u.protocol === 'https:';
      const mod = isHttps ? https : http;
      const reqOptions = {
        method,
        headers,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + (u.search || '')
      };
      const req = mod.request(reqOptions, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const text = buffer.toString('utf8');
          const response = {
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: res.headers,
            text: async () => text,
            json: async () => { try { return JSON.parse(text); } catch { return {}; } },
            buffer: async () => buffer
          };
          resolve(response);
        });
      });
      req.on('error', (err) => {
        resolve({
          ok: false,
          status: 0,
          statusText: err.message,
          headers: {},
          text: async () => '',
          json: async () => ({ error: err.message }),
          buffer: async () => Buffer.alloc(0)
        });
      });
      if (body) {
        if (typeof body === 'string' || Buffer.isBuffer(body)) {
          req.write(body);
        } else {
          const str = JSON.stringify(body);
          req.write(str);
        }
      }
      req.end();
    } catch (err) {
      resolve({
        ok: false,
        status: 0,
        statusText: err.message,
        headers: {},
        text: async () => '',
        json: async () => ({ error: err.message }),
        buffer: async () => Buffer.alloc(0)
      });
    }
  });
}

// Extrator simples de dados de uma página (og:title/description/image)
async function extractDataFromUrl(pageUrl) {
  console.log('🔍 Extraindo dados da URL:', pageUrl);
  
  try {
    const resp = await makeHttpsRequest(pageUrl, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 R10Publisher' } });
    
    console.log('📊 Status da requisição:', resp.status);
    
    if (!resp.ok) {
      console.error('❌ Falha na requisição HTTP:', resp.status, resp.statusText);
      throw new Error(`Falha ao carregar URL (status ${resp.status})`);
    }
    
    const html = await resp.text();
    console.log('📄 HTML recebido com', html.length, 'caracteres');

    function getMeta(content, attr, name) {
      const rx = new RegExp(`<meta[^>]+${attr}=["']${name}["'][^>]*content=["']([^"']+)["'][^>]*>`, 'i');
      const m = content.match(rx);
      return m ? m[1] : '';
    }
    function getTag(content, tag) {
      const rx = new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, 'i');
      const m = content.match(rx);
      return m ? m[1] : '';
    }
    function absoluteUrl(href) {
      try { return new URL(href, pageUrl).href; } catch { return href; }
    }

    let title = getMeta(html, 'property', 'og:title') || getMeta(html, 'name', 'title') || getTag(html, 'title');
    const description = getMeta(html, 'property', 'og:description') || getMeta(html, 'name', 'description') || '';
    let imageUrl = getMeta(html, 'property', 'og:image') || getMeta(html, 'name', 'image') || '';
    if (imageUrl) imageUrl = absoluteUrl(imageUrl);

    // Fallback rudimentar para h1
    if (!title) {
      const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      if (h1) title = h1[1].replace(/<[^>]+>/g, '').trim();
    }

    const result = {
      title: (title || '').replace(/\s+/g, ' ').trim(),
      description: (description || '').trim(),
      imageUrl: imageUrl || '',
      originalUrl: pageUrl
    };
    
    console.log('📋 Dados extraídos:', {
      title: result.title,
      description: result.description.substring(0, 100) + '...',
      imageUrl: result.imageUrl,
      originalUrl: result.originalUrl
    });
    
    return result;
    
  } catch (error) {
    console.error('❌ Erro na extração de dados:', error.message);
    console.error('📍 Stack trace:', error.stack);
    throw error;
  }
}

// Carregar fontes na inicialização do servidor - COM FALLBACK ROBUSTO
let EMBEDDED_FONTS_CSS = '';

try {
  const fontsDir = path.join(__dirname, 'fonts');
  console.log(`🔍 Procurando fontes em: ${fontsDir}`);
  
  // Verificar se arquivos existem antes de tentar carregar
  const regularPath = path.join(fontsDir, 'Poppins-Regular.ttf');
  const semiboldPath = path.join(fontsDir, 'Poppins-SemiBold.ttf');
  const extraboldPath = path.join(fontsDir, 'Poppins-ExtraBold.ttf');
  
  if (fs.existsSync(regularPath) && fs.existsSync(semiboldPath) && fs.existsSync(extraboldPath)) {
    const regularFont = fs.readFileSync(regularPath);
    const semiboldFont = fs.readFileSync(semiboldPath);
    const extraboldFont = fs.readFileSync(extraboldPath);
    
    const regularBase64 = regularFont.toString('base64');
    const semiboldBase64 = semiboldFont.toString('base64');
    const extraboldBase64 = extraboldFont.toString('base64');
    
    EMBEDDED_FONTS_CSS = `
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;800&display=swap');
        @font-face {
          font-family: 'Poppins';
          src: url('data:font/ttf;base64,${regularBase64}') format('truetype'),
               url('/fonts/Poppins-Regular.ttf') format('truetype');
          font-weight: 400;
          font-style: normal;
          font-display: swap;
        }
        @font-face {
          font-family: 'Poppins';
          src: url('data:font/ttf;base64,${semiboldBase64}') format('truetype'),
               url('/fonts/Poppins-SemiBold.ttf') format('truetype');
          font-weight: 600;
          font-style: normal;
          font-display: swap;
        }
        @font-face {
          font-family: 'Poppins';
          src: url('data:font/ttf;base64,${extraboldBase64}') format('truetype'),
               url('/fonts/Poppins-ExtraBold.ttf') format('truetype');
          font-weight: 800;
          font-style: normal;
          font-display: swap;
        }
      </style>
    `;
    
    console.log('✅ Fontes Poppins carregadas com sucesso e embarcadas em Base64');
    console.log(`📏 Tamanhos: Regular=${regularBase64.length} chars, SemiBold=${semiboldBase64.length} chars, ExtraBold=${extraboldBase64.length} chars`);
  } else {
    throw new Error('Arquivos de fonte não encontrados');
  }
} catch (error) {
  console.error('❌ ERRO ao carregar fontes Poppins:', error.message);
  console.log('🔄 Usando Google Fonts como fallback');
  EMBEDDED_FONTS_CSS = `
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;800&display=swap');
    </style>
  `;
}

const INSTAGRAM_CONFIG = {
  BUSINESS_ID: process.env.IG_BUSINESS_ID || '17841401907016879',
  ACCESS_TOKEN: process.env.IG_ACCESS_TOKEN || '',
  GRAPH_API_URL: 'https://graph.facebook.com/v19.0',
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || '' // URL pública onde a Meta consegue baixar as imagens
};

const GROQ_CONFIG = {
  API_KEY: process.env.GROQ_API_KEY || '',
  MODEL: process.env.GROQ_MODEL || 'llama3-8b-8192',
  API_URL: 'https://api.groq.com/openai/v1/chat/completions'
};

// Diretório persistente para armazenar a publi (sobrevive a redeploys)
// Em produção (Render), defina PERSIST_DIR para um disco persistente, ex.: "/data/instagram-publisher"
const PERSIST_DIR = process.env.PERSIST_DIR || path.join(__dirname, 'uploads');

// === Publicidade: geração padrão e obtenção persistente ===
async function generateDefaultPublicityCard() {
  // Cria um card 1080x1350 com fundo escuro e logotipo R10 centralizado + rótulo PUBLICIDADE
  const width = 1080;
  const height = 1350;
  const background = { r: 12, g: 12, b: 12, alpha: 1 }; // fundo #0c0c0c

  // Base sólida
  const base = await sharp({
    create: { width, height, channels: 4, background }
  }).png().toBuffer();

  // Carregar logo
  const logoPath = path.join(__dirname, 'logo-r10-piaui.png');
  let logoBuffer = null;
  try {
    logoBuffer = await fs.readFile(logoPath);
  } catch (e) {
    console.warn('⚠️ Logo não encontrado, continuará sem logo:', logoPath);
  }

  // SVG com textos
  const svg = Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#111"/>
          <stop offset="100%" stop-color="#222"/>
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="${width}" height="${height}" fill="url(#g)"/>
      <text x="540" y="210" text-anchor="middle" fill="#ffffff" font-family="Poppins, Arial" font-size="54" font-weight="800">PUBLICIDADE</text>
      <text x="540" y="1240" text-anchor="middle" fill="#ffffff" font-family="Poppins, Arial" font-size="34" font-weight="600">R10 PIAUÍ — Dá gosto de ver!</text>
    </svg>
  `);

  const composites = [{ input: svg, top: 0, left: 0 }];

  // Se logo existir, redimensiona e centraliza
  if (logoBuffer) {
    const resizedLogo = await sharp(logoBuffer).resize({ width: 700, withoutEnlargement: true }).toBuffer();
    // Posição aproximada central
    const logoTop = Math.round(height / 2) - 220;
    const logoLeft = Math.round((width - 700) / 2);
    composites.push({ input: resizedLogo, top: logoTop, left: logoLeft });
  }

  const buffer = await sharp(base)
    .composite(composites)
    .jpeg({ quality: 92 })
    .toBuffer();

  return buffer;
}

async function getOrCreatePublicityBuffer() {
  await fs.ensureDir(PERSIST_DIR);
  const publicityPath = path.join(PERSIST_DIR, 'publicity-card.jpg');
  if (fs.existsSync(publicityPath)) {
    return fs.readFile(publicityPath);
  }
  // gerar padrão e persistir
  const buf = await generateDefaultPublicityCard();
  await fs.writeFile(publicityPath, buf);
  return buf;
}

// Função para condensar e finalizar título SEM reticências
// Função para otimizar título com Groq (sempre tenta IA, mesmo para títulos curtos)
async function optimizeTitle(title, contextDescription) {
  try {
    console.log(`🤖 Otimizando título: "${title}" (${title.length} caracteres)`);
    
    const response = await makeHttpsRequest(GROQ_CONFIG.API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_CONFIG.API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: GROQ_CONFIG.MODEL,
        messages: [
          {
            role: 'system',
            content: `Você é editor de manchetes jornalísticas para Instagram. Produza títulos curtos (até 70 caracteres), completos e informativos.
Regras inegociáveis:
- Manchete deve ter sujeito + verbo de ação + complemento (predicado). Não retorne apenas nomes ou sujeito solto.
- Não use reticências. Não quebre palavras. Gramática perfeita e natural.
- Não termine em verbo auxiliar ou preposição ("é", "foi", "de", "da", "no", "na").
- Evite terminar apenas em particípio ("nomeado", "anunciado", "confirmado"). Se ocorrer, COMPLETE o cargo/ação.
- Se o cargo específico não estiver claro, use forma genérica, mas completa: "assume cargo" ou "é nomeado para cargo".
- Opção de lead geográfico é válida quando fizer sentido: "Piripiri:" ou "Teresina:".
Exemplos bons: "Prefeitura de Teresina anuncia nova obra"; "José Amâncio Neto é nomeado coordenador"; "Piripiri: secretária assume pasta da Saúde".
Exemplos ruins (NÃO FAZER): "José Amâncio Neto"; "Governador do Piauí"; "Prefeitura anuncia no...".`
          },
          {
            role: 'user',
            content: `Reescreva para uma manchete enxuta e COMPLETA.

TÍTULO ORIGINAL: "${title}"
${contextDescription ? `\nCONTEXTO (descrição da matéria): ${contextDescription}` : ''}

INSTRUÇÕES OBRIGATÓRIAS:
- Máximo 70 caracteres (essencial!)
- Preservar TODAS as informações importantes
- Linguagem clara e direta
- NUNCA cortar palavras no meio (proibido "co...", "no...", etc)
- Manter nomes próprios completos sempre
- Se necessário, reformular completamente em vez de apenas cortar
- Gramática perfeita e natural
 - PROIBIDO usar reticências "..."
 - O título deve ser uma frase/manchete COMPLETA (com conclusão)
 - NUNCA terminar em verbo auxiliar ou preposição (ex.: "é", "foi", "de", "da", "no", "na")
 - Evite terminar com particípios sem complemento (ex.: "nomeado", "anunciado", "confirmado"). Se aparecerem, complete o cargo/ação.

EXEMPLOS ESPECÍFICOS DO QUE FAZER:
❌ PÉSSIMO: "Advogado Piripiriense José Amâncio Neto é nomeado co..."
✅ EXCELENTE: "José Amâncio Neto é nomeado coordenador"

❌ PÉSSIMO: "Prefeitura Municipal de Teresina anuncia no..."
✅ EXCELENTE: "Prefeitura de Teresina anuncia nova obra"

❌ PÉSSIMO: "Governador do Estado do Piauí participa de ev..."
✅ EXCELENTE: "Governador participa de evento importante"

Responda APENAS com o título reformulado, sem aspas ou explicações. O resultado deve caber sozinho e ter sentido completo.`
          }
        ],
        max_tokens: 100,
        temperature: 0.1
      })
    });

    console.log(`📡 Status da resposta Groq: ${response.status}`);
    
    if (response.ok) {
      const data = await response.json();
      console.log(`📝 Resposta Groq completa:`, JSON.stringify(data, null, 2));
      
      const optimizedTitle = data.choices[0]?.message?.content?.trim();
      if (optimizedTitle && optimizedTitle.length > 0) {
        const cleanTitle = optimizedTitle.replace(/^['"]|['"]$/g, '');
        console.log(`✅ Título otimizado: "${cleanTitle}" (${cleanTitle.length} caracteres)`);
        // Normalizar para evitar reticências e final incompleto + corrigir terminações com "nomeado"
        let finalized = finalizeHeadline(cleanTitle, 70);
        finalized = fixNominationEndings(finalized);
        return finalized;
      } else {
        console.log('❌ Resposta da Groq vazia ou inválida');
      }
    } else {
      const errorData = await response.json();
      console.error('❌ Erro na API Groq:', errorData);
    }
  } catch (error) {
    console.error('❌ Erro ao otimizar título:', error.message);
    console.error('❌ Stack:', error.stack);
  }
  
  // Fallback: condensar sem reticências (ainda garantindo final completo)
  console.log(`🔄 Aplicando fallback - condensação do título original sem reticências`);
  let finalized = finalizeHeadline(title, 70);
  finalized = fixNominationEndings(finalized);
  console.log(`🔄 Fallback - título final: "${finalized}"`);
  return finalized;
}

function finalizeHeadline(text, maxLength) {
  console.log(`📏 Finalizando título: "${text}" (${text.length} chars) para máximo ${maxLength}, sem reticências`);
  if (!text) return text;

  // 1) Normalizações básicas
  let t = text
    .replace(/\u2026|\.\.\./g, '') // remove reticências
    .replace(/\s+/g, ' ')
    .trim();

  // 2) Cortar em separadores de subtítulo
  const splitters = [' — ', ' - ', ' – ', ': '];
  for (const s of splitters) {
    if (t.includes(s)) {
      const [head] = t.split(s);
      if (head.length >= maxLength * 0.6) {
        t = head.trim();
        break;
      }
    }
  }

  // 3) Se ainda maior que o limite, remover termos não essenciais
  const removalRounds = [
    /\b(para|por|com|sobre|entre|após|antes|durante)\b/gi,
    /\b(de|da|do|das|dos|no|na|nos|nas)\b/gi,
    /\b(é|foi|será|está|estão|foram|seriam|seriam|será|seriam)\b/gi
  ];
  for (const rx of removalRounds) {
    if (t.length <= maxLength) break;
    t = t.replace(rx, '').replace(/\s+/g, ' ').trim();
  }

  // 4) Se ainda maior, cortar por palavras até caber, SEM '...'
  if (t.length > maxLength) {
    const words = t.split(' ');
    let acc = '';
    for (const w of words) {
      const next = acc ? acc + ' ' + w : w;
      if (next.length <= maxLength) acc = next; else break;
    }
    t = acc.trim();
  }

  // 5) Evitar finais incompletos (preposições/verbos auxiliares)
  const badEndings = new Set(['de','da','do','das','dos','no','na','nos','nas','em','por','para','com','é','foi','será','está','são','foram','nomeado','nomeada','anunciado','anunciada','confirmado','confirmada']);
  let tokens = t.split(' ');
  while (tokens.length > 1 && badEndings.has(tokens[tokens.length - 1].toLowerCase())) {
    tokens.pop();
  }
  t = tokens.join(' ').trim();

  // 6) Casos específicos
  // Evitar terminar com "é nomeado" -> normalizar para não ficar solto
  t = t.replace(/\s+é nomead[oa]$/i, ' nomeado');
  // Se ainda terminar exatamente em "nomeado/nomeada", retire para não ficar truncado (será tratado por fixNominationEndings)
  if (/\bnomead[oa]$/i.test(t)) {
    t = t.replace(/\s*nomead[oa]$/i, '').trim();
  }

  return t;
}

// Correção local para manchetes que terminam em "nomeado/nomeada" sem complemento
function fixNominationEndings(text) {
  if (!text) return text;
  // Se contiver "nomeado/a" mas sem complemento (no final), mude para uma forma completa e curta
  if (/\bnomead[oa]$/i.test(text)) {
    return text.replace(/\bnomead[oa]$/i, 'assume cargo').trim();
  }
  // Evitar "é nomeado" no final sem complemento
  if (/\bé nomead[oa]$/i.test(text)) {
    return text.replace(/\bé nomead[oa]$/i, 'assume cargo').trim();
  }
  return text;
}

// Função para gerar chapéu com Groq AI (palavra complementar)
async function generateChapeu(title) {
  try {
    console.log(`🏷️ Gerando chapéu para: "${title}"`);
    
    const response = await makeHttpsRequest(GROQ_CONFIG.API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_CONFIG.API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: GROQ_CONFIG.MODEL,
        messages: [{
          role: 'user',
          content: `Você é especialista em comunicação jornalística. Escolha APENAS UMA palavra (chapéu) da lista a seguir que melhor complemente a manchete.

TÍTULO: "${title}"

LISTA (ESCOLHA UMA): DESTAQUE, URGENTE, IMPORTANTE, EXCLUSIVO, ATENÇÃO, AGORA, OFICIAL, CONFIRMADO, NOVIDADE, ÚLTIMA HORA

REGRAS:
- NÃO repetir palavra que já esteja no título
- UMA palavra, MAIÚSCULAS, até 12 caracteres
- Responda APENAS com a palavra, sem aspas`
        }],
        max_tokens: 8,
        temperature: 0.1
      })
    });

    console.log(`📡 Status da resposta Groq (chapéu): ${response.status}`);
    
    if (response.ok) {
      const data = await response.json();
      console.log(`📝 Resposta Groq chapéu:`, JSON.stringify(data, null, 2));
      
  const ch = data.choices[0]?.message?.content?.trim().toUpperCase();
      if (ch && ch.length > 0 && ch.length <= 12) {
        const cleanChapeu = ch.replace(/^['"]|['"]$/g, '');
        const allowed = new Set(['DESTAQUE','URGENTE','IMPORTANTE','EXCLUSIVO','ATENÇÃO','AGORA','OFICIAL','CONFIRMADO','NOVIDADE','ÚLTIMA HORA','ULTIMA HORA']);
        if (allowed.has(cleanChapeu)) {
          console.log(`✅ Chapéu gerado: "${cleanChapeu}"`);
          return cleanChapeu.toUpperCase();
        } else {
          console.log('⚠️ Chapéu fora da lista permitida, aplicando fallback');
        }
      } else {
        console.log('❌ Chapéu inválido ou muito longo');
      }
    } else {
      const errorData = await response.json();
      console.error('❌ Erro na API Groq (chapéu):', errorData);
    }
  } catch (error) {
    console.error('❌ Erro ao gerar chapéu:', error.message);
    console.error('❌ Stack:', error.stack);
  }
  
  // Fallback: palavras complementares genéricas
  const fallbacks = ['DESTAQUE', 'NOTÍCIA', 'IMPORTANTE', 'AGORA', 'NOVO', 'URGENTE', 'ATENÇÃO'];
  const selectedFallback = fallbacks[Math.floor(Math.random() * fallbacks.length)];
  console.log(`🔄 Fallback chapéu: "${selectedFallback}"`);
  return selectedFallback.toUpperCase();
  return selectedFallback.toUpperCase();
}

// Função para gerar legenda com Groq (sem categoria)
async function generateCaption(title, chapeu) {
  try {
    console.log(`🤖 Gerando legenda para: "${title}" (chapéu: ${chapeu})`);
    
    const response = await makeHttpsRequest(GROQ_CONFIG.API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_CONFIG.API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: GROQ_CONFIG.MODEL,
        messages: [{
          role: 'user',
          content: `Você é especialista em social media jornalística. Crie uma legenda profissional para Instagram:

TÍTULO: "${title}"
CHAPÉU: "${chapeu}"

INSTRUÇÕES ESPECÍFICAS:
1. Use o título COMPLETO (não corte nem resuma)
2. Adicione uma linha explicativa curta sobre a notícia
3. Inclua chamada para ação "📍 Leia a matéria completa em www.r10piaui.com"
4. Termine com "🔴 R10 Piauí – Dá gosto de ver!"
5. Adicione hashtags: #R10Piauí #Notícias #Piauí

ESTRUTURA EXATA:
[TÍTULO COMPLETO]

[Breve explicação da notícia]

📍 Leia a matéria completa em www.r10piaui.com

🔴 R10 Piauí – Dá gosto de ver!

#R10Piauí #Notícias #Piauí

REGRAS:
- NÃO mencione categoria/editoria
- Use linguagem profissional
- Seja objetivo e claro

Legenda:`
        }],
        max_tokens: 200,
        temperature: 0.2
      })
    });

    console.log(`📡 Status da resposta Groq (legenda): ${response.status}`);
    
    if (response.ok) {
      const data = await response.json();
      console.log(`📝 Resposta Groq legenda:`, JSON.stringify(data, null, 2));
      
      let caption = data.choices[0]?.message?.content?.trim();
      if (caption && caption.length > 0) {
        // Normalizar: remover reticências, linhas extras, e assegurar 1ª linha = título
        caption = caption.replace(/[\u2026]|\.\.\./g, '').replace(/\r/g, '');
        const parts = caption.split('\n').map(s => s.trim()).filter(Boolean);
        if (parts.length > 0) parts[0] = title;
        caption = parts.join('\n\n');
        console.log('✅ Legenda gerada com sucesso (normalizada)');
        return caption;
      } else {
        console.log('❌ Legenda vazia ou inválida');
      }
    } else {
      const errorData = await response.json();
      console.error('❌ Erro na API Groq (legenda):', errorData);
    }
  } catch (error) {
    console.error('❌ Erro ao gerar legenda:', error.message);
    console.error('❌ Stack:', error.stack);
  }
  
  // Fallback: legenda simples com título completo decodificado
  // Decodificar entidades HTML no título
  function decodeHtmlEntitiesFallback(text) {
    const entities = {
      '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': '\'', '&nbsp;': ' ',
      '&aacute;': 'á', '&Aacute;': 'Á', '&agrave;': 'à', '&Agrave;': 'À',
      '&acirc;': 'â', '&Acirc;': 'Â', '&atilde;': 'ã', '&Atilde;': 'Ã',
      '&auml;': 'ä', '&Auml;': 'Ä', '&eacute;': 'é', '&Eacute;': 'É',
      '&egrave;': 'è', '&Egrave;': 'È', '&ecirc;': 'ê', '&Ecirc;': 'Ê',
      '&iacute;': 'í', '&Iacute;': 'Í', '&igrave;': 'ì', '&Igrave;': 'Ì',
      '&icirc;': 'î', '&Icirc;': 'Î', '&oacute;': 'ó', '&Oacute;': 'Ó',
      '&ograve;': 'ò', '&Ograve;': 'Ò', '&ocirc;': 'ô', '&Ocirc;': 'Ô',
      '&otilde;': 'õ', '&Otilde;': 'Õ', '&uacute;': 'ú', '&Uacute;': 'Ú',
      '&ugrave;': 'ù', '&Ugrave;': 'Ù', '&ucirc;': 'û', '&Ucirc;': 'Û',
      '&ccedil;': 'ç', '&Ccedil;': 'Ç'
    };
    return text.replace(/&[a-zA-Z]+;/g, (entity) => entities[entity] || entity);
  }
  
  const titleDecodificado = decodeHtmlEntitiesFallback(title);
  const fallbackCaption = `${titleDecodificado}

Confira todos os detalhes da notícia.

📍 Leia a matéria completa em www.r10piaui.com

🔴 R10 Piauí – Dá gosto de ver!

#R10Piauí #Notícias #Piauí`;
  
  console.log(`🔄 Usando fallback para legenda`);
  return fallbackCaption;
}

// Função para gerar card com Sharp - EXATAMENTE IGUAL AO SISTEMA PRINCIPAL
async function generateInstagramCard(data) {
  const { title, imagePath, categoria, chapeu, destaquePersonalizado, type = 'card' } = data;
  
  console.log('🎨 Gerando card...');
  
  // Usar chapéu fornecido como parâmetro ou gerar automaticamente se não fornecido
  const chapeuFinal = chapeu || await generateChapeu(title);
  // Sempre renderizar o chapéu em CAIXA ALTA no card
  const chapeuUpper = (chapeuFinal || '').toString().trim().toUpperCase();
  console.log(`🏷️ Usando chapéu: "${chapeuFinal}"`);
  
  try {
    // Função para limpar e escapar texto para XML de forma segura
    function escapeXmlText(text) {
      if (!text) return '';
      
      // Primeiro decodifica entidades HTML para caracteres normais
      const decoded = decodeHtmlEntities(text);
      
      // Depois escapa apenas os caracteres XML especiais
      return decoded
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
    }

    // Função para decodificar entidades HTML
    function decodeHtmlEntities(text) {
      if (!text) return '';
      
      const entities = {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&apos;': '\'',
        '&nbsp;': ' ',
        '&aacute;': 'á', '&Aacute;': 'Á',
        '&agrave;': 'à', '&Agrave;': 'À',
        '&acirc;': 'â', '&Acirc;': 'Â',
        '&atilde;': 'ã', '&Atilde;': 'Ã',
        '&auml;': 'ä', '&Auml;': 'Ä',
        '&eacute;': 'é', '&Eacute;': 'É',
        '&egrave;': 'è', '&Egrave;': 'È',
        '&ecirc;': 'ê', '&Ecirc;': 'Ê',
        '&iacute;': 'í', '&Iacute;': 'Í',
        '&igrave;': 'ì', '&Igrave;': 'Ì',
        '&icirc;': 'î', '&Icirc;': 'Î',
        '&oacute;': 'ó', '&Oacute;': 'Ó',
        '&ograve;': 'ò', '&Ograve;': 'Ò',
        '&ocirc;': 'ô', '&Ocirc;': 'Ô',
        '&otilde;': 'õ', '&Otilde;': 'Õ',
        '&uacute;': 'ú', '&Uacute;': 'Ú',
        '&ugrave;': 'ù', '&Ugrave;': 'Ù',
        '&ucirc;': 'û', '&Ucirc;': 'Û',
        '&ccedil;': 'ç', '&Ccedil;': 'Ç'
      };
      
      return text.replace(/&[a-zA-Z]+;/g, (entity) => {
        return entities[entity] || entity;
      });
    }

    // Função para retornar CSS com fontes embutidas (já carregadas na inicialização)
    function getEmbeddedFontsCss() {
      return EMBEDDED_FONTS_CSS;
    }

    // Definir cores por editoria EXATAS do sistema principal
    const editorialColors = {
      'polícia': '#dc2626',          // 🔴 POLÍCIA: Vermelho
      'política': '#2563eb',         // 🔵 POLÍTICA: Azul
      'esporte': '#16a34a',          // 🟢 ESPORTE: Verde
      'entretenimento': '#9333ea',   // 💜 ENTRETENIMENTO: Roxo
      'geral': '#ea580c',            // 🟠 GERAL: Laranja
      'default': '#ea580c'           // laranja padrão (geral)
    };

    // Usar cor baseada na categoria fornecida com fallback seguro
    const categoriaParaCor = categoria || 'geral';
    const barColor = editorialColors[categoriaParaCor] || editorialColors['default'];
    
    // Definir dimensões baseadas no tipo
    const dimensions = type === 'story' ? { width: 1080, height: 1920 } : { width: 1080, height: 1350 };
    
    // 1. Redimensionar imagem para as dimensões corretas
    const resizedImage = await sharp(imagePath)
      .resize(dimensions.width, dimensions.height, { fit: 'cover' })
      .toBuffer();

    // 2. Ler o template overlay correto
    const overlayFile = type === 'story' ? 'overlaystory.png' : 'overlay.png';
    const overlayPath = path.join(__dirname, 'templates', overlayFile);
    console.log(`🖼️ Carregando template: ${overlayPath}`);
    
    // Verificar se o arquivo existe
    try {
      await fs.access(overlayPath);
      console.log(`✅ Arquivo overlay encontrado`);
    } catch (err) {
      console.error(`❌ Arquivo overlay não encontrado: ${overlayPath}`);
      throw new Error(`Template overlay não encontrado: ${overlayFile}`);
    }
    
    const overlayBuffer = await fs.readFile(overlayPath);

    // 3. Função inteligente para destacar palavras importantes EXATAMENTE IGUAL
    const findKeywords = (text) => {
      console.log(`🔍 Analisando título: "${text}"`);
      const words = text.split(' ');
      const stopWords = ['de', 'da', 'do', 'em', 'na', 'no', 'com', 'para', 'por', 'a', 'o', 'e', 'que', 'um', 'uma', 'se', 'foi', 'ser'];
      
      // Critérios para identificar palavras importantes (com suporte a acentos)
      const isProperNoun = (word) => /^[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ]/.test(word) && word.length > 2;
      const isLocation = (word) => {
        const locations = ['Teresina', 'Piauí', 'Brasil', 'Brasília', 'Pedro II', 'Parnaíba', 'Picos', 'Regional', 'Nacional', 'Estadual', 'Municipal'];
        return locations.some(loc => word.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(loc.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')));
      };
      const isNumber = (word) => /\d+/.test(word) || /milhão|milhões|mil|bilhão|bilhões/.test(word.toLowerCase()) || /^[IVX]+$/.test(word);
      const isActionVerb = (word) => {
        const verbs = ['vence', 'ganha', 'perde', 'conquista', 'anuncia', 'revela', 'inicia', 'termina', 'aprova', 'rejeita', 'inaugura', 'investe', 'cria'];
        return verbs.some(verb => word.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(verb));
      };
      const isImportantNoun = (word) => {
        const nouns = ['campeonato', 'governo', 'prefeitura', 'empresa', 'projeto', 'investimento', 'hospital', 'escola', 'universidade', 'festival', 'feira', 'educação', 'saúde', 'estação'];
        return nouns.some(noun => word.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(noun.normalize('NFD').replace(/[\u0300-\u036f]/g, '')));
      };
      
      const isRomanNumeral = (word) => /^[IVX]+$/.test(word);
      
      const isCompositeEntity = (words, startIndex) => {
        if (startIndex < words.length - 1 && 
            words[startIndex].toLowerCase() === 'pedro' && 
            words[startIndex + 1].toLowerCase() === 'ii') {
          return 2;
        }
        return 0;
      };
      
      const maxHighlightWords = Math.max(2, Math.floor(words.length * 0.3));
      console.log(`📏 Título tem ${words.length} palavras. Máximo destaque: ${maxHighlightWords} palavras (30%)`);
      
      let bestStart = -1;
      let bestLength = 0;
      let bestScore = 0;
      
      // Procurar sequências contínuas respeitando o limite de proporção
      for (let start = 0; start < words.length; start++) {
        for (let length = 2; length <= Math.min(maxHighlightWords, words.length - start); length++) {
          const sequence = words.slice(start, start + length);
          let score = 0;
          let validSequence = true;
          
          let entityBonus = 0;
          for (let i = 0; i < sequence.length; i++) {
            const entitySize = isCompositeEntity(sequence, i);
            if (entitySize > 0) {
              entityBonus += 5;
              console.log(`🏛️ Entidade composta detectada: "${sequence.slice(i, i + entitySize).join(' ')}"`);
            }
          }
          
          for (let i = 0; i < sequence.length; i++) {
            const word = sequence[i];
            
            if (stopWords.includes(word.toLowerCase())) {
              if (i === 0 || i === sequence.length - 1) {
                console.log(`⚠️ Sequência "${sequence.join(' ')}" invalidada por stop word "${word}" na posição ${i === 0 ? 'início' : 'fim'}`);
                validSequence = false;
                break;
              }
              console.log(`✅ Stop word "${word}" aceita no meio da sequência "${sequence.join(' ')}"`);
              continue;
            }
            
            let wordScore = 0;
            if (isProperNoun(word)) wordScore += 4;
            if (isLocation(word)) wordScore += 3;
            if (isNumber(word)) wordScore += 3;
            if (isActionVerb(word)) wordScore += 2;
            if (isImportantNoun(word)) wordScore += 3;
            if (isRomanNumeral(word)) wordScore += 4;
            
            if (wordScore === 0 && word.length < 4 && !isRomanNumeral(word)) {
              console.log(`⚠️ Sequência "${sequence.join(' ')}" invalidada por palavra irrelevante "${word}" (score: ${wordScore}, length: ${word.length})`);
              validSequence = false;
              break;
            }
            
            score += wordScore;
          }
          
          score += entityBonus;
          
          const sequenceText = sequence.join(' ').toLowerCase();
          if (sequenceText.includes('pedro ii')) {
            score += 8;
            console.log(`🎯 Bonus "Pedro II" aplicado para: "${sequence.join(' ')}"`);
          }
          
          if (start === 0 && sequenceText.includes('pedro ii') && length <= 4) {
            score += 5;
            console.log(`👑 Bonus protagonista inicial aplicado para: "${sequence.join(' ')}"`);
          }
          
          if (validSequence && length >= 2) {
            const hasProperNoun = sequence.some(isProperNoun);
            const hasAction = sequence.some(word => isActionVerb(word) || isImportantNoun(word));
            if (hasProperNoun && hasAction) score += 3;
          }
          
          if (validSequence && start <= 1) score += 1;
          
          if (validSequence) {
            console.log(`📊 Sequência "${sequence.join(' ')}" (pos ${start}, len ${length}): score ${score} ${entityBonus > 0 ? `(+${entityBonus} entidade)` : ''}`);
          }
          
          if (validSequence && score > bestScore) {
            bestStart = start;
            bestLength = length;
            bestScore = score;
          }
        }
      }
      
      // Fallback
      if (bestStart === -1) {
        for (let i = 0; i < words.length - 1; i++) {
          if (!stopWords.includes(words[i].toLowerCase()) && 
              !stopWords.includes(words[i + 1].toLowerCase()) &&
              words[i].length > 2 && words[i + 1].length > 2) {
            bestStart = i;
            bestLength = 2;
            console.log(`🔄 Fallback: destacando "${words[i]} ${words[i + 1]}"`);
            break;
          }
        }
      }
      
      if (bestStart >= 0) {
        const selectedSequence = words.slice(bestStart, bestStart + bestLength).join(' ');
        console.log(`✅ DESTAQUE FINAL: "${selectedSequence}" (posição ${bestStart}, ${bestLength} palavras)`);
      }
      
      return { boldStart: bestStart, boldLength: bestLength };
    };

  // Não truncar o título antes; deixar o algoritmo de quebra distribuir em até 3 linhas
  const adaptedTitle = title;
  const titleWords = adaptedTitle.split(' ');
  // Determinar destaque: usar personalizado ou automático
  let boldStart, boldLength;
  
  if (destaquePersonalizado) {
    // Verificar se é o novo formato com índices ou o antigo formato de texto
    if (typeof destaquePersonalizado === 'object' && 'inicio' in destaquePersonalizado && 'fim' in destaquePersonalizado) {
      // Novo formato: usar índices diretos
      console.log(`🎯 Usando destaque personalizado por índices: ${destaquePersonalizado.inicio} a ${destaquePersonalizado.fim}`);
      boldStart = Math.max(0, destaquePersonalizado.inicio);
      boldLength = Math.max(1, destaquePersonalizado.fim - destaquePersonalizado.inicio + 1);
      console.log(`✅ Destaque por índice: posição ${boldStart}, ${boldLength} palavra(s)`);
    } else {
      // Formato antigo: buscar texto no título
      console.log(`🎯 Usando destaque personalizado por texto: "${destaquePersonalizado}"`);
      const titleLower = adaptedTitle.toLowerCase();
      const destaqueLower = destaquePersonalizado.toLowerCase();
      const index = titleLower.indexOf(destaqueLower);
      
      if (index !== -1) {
        // Calcular posição em palavras
        const wordsBeforeDestaque = adaptedTitle.substring(0, index).trim().split(' ').filter(w => w.length > 0);
        const palavrasDestaque = destaquePersonalizado.split(' ').filter(w => w.length > 0);
        boldStart = wordsBeforeDestaque.length;
        boldLength = palavrasDestaque.length;
        console.log(`✅ Destaque encontrado: posição ${boldStart}, ${boldLength} palavra(s)`);
      } else {
        console.log(`⚠️ Destaque "${destaquePersonalizado}" não encontrado no título, usando automático`);
        const result = findKeywords(adaptedTitle);
        boldStart = result.boldStart;
        boldLength = result.boldLength;
      }
    }
  } else {
    // Usar destaque automático
    const result = findKeywords(adaptedTitle);
    boldStart = result.boldStart;
    boldLength = result.boldLength;
  }
    
    // Usar quebra por largura calculada (respeitando margens e evitando linhas com 1 palavra)
    const maxLines = 3;
    const FONT_SIZE = 76;
    const CHAR_WIDTH_NORMAL = 0.58; // heurística
    const CHAR_WIDTH_BOLD = 0.62;   // heurística
    const SPACE_WIDTH = 0.32 * FONT_SIZE;
    const titleMarginLeft = 60;
    const marginRight = 60;
    const titleMaxWidth = dimensions.width - (titleMarginLeft + marginRight);

    function estimateWordWidth(word, isBold) {
      const factor = isBold ? CHAR_WIDTH_BOLD : CHAR_WIDTH_NORMAL;
      return word.length * FONT_SIZE * factor;
    }

  function wrapWordsToWidth(wordsArr, boldStart, boldLength, maxWidth, maxLines) {
      const built = [];
      let line = [];
      let width = 0;
      for (let i = 0; i < wordsArr.length; i++) {
        const w = wordsArr[i];
        const isBold = i >= boldStart && i < boldStart + boldLength;
        const wWidth = estimateWordWidth(w, isBold);
        const extraSpace = line.length > 0 ? SPACE_WIDTH : 0;
        if (width + extraSpace + wWidth <= maxWidth || line.length === 0) {
          line.push({ text: w, isBold });
          width += extraSpace + wWidth;
        } else {
          built.push(line);
          if (built.length >= maxLines) break;
          line = [{ text: w, isBold }];
          width = wWidth;
        }
      }
      if (line.length && built.length < maxLines) built.push(line);

      function lineWidth(arr) {
        let total = 0;
        for (let i = 0; i < arr.length; i++) {
          const ww = estimateWordWidth(arr[i].text, arr[i].isBold);
          total += ww + (i > 0 ? SPACE_WIDTH : 0);
        }
        return total;
      }

      // evitar linhas com 1 palavra (viúvas) sempre que possível
      for (let i = 0; i < built.length; i++) {
        if (built[i].length === 1) {
          // tenta puxar do anterior
          const prev = i > 0 ? built[i - 1] : null;
          if (prev && prev.length > 2) {
            const moved = prev.pop();
            if (lineWidth(built[i]) + SPACE_WIDTH + estimateWordWidth(moved.text, moved.isBold) <= maxWidth) {
              built[i].unshift(moved);
            } else {
              prev.push(moved);
            }
          } else if (i + 1 < built.length && built[i + 1].length > 1) {
            // ou puxa da próxima
            const next = built[i + 1];
            const movedN = next.shift();
            if (movedN) {
              if (lineWidth(built[i]) + (built[i].length ? SPACE_WIDTH : 0) + estimateWordWidth(movedN.text, movedN.isBold) <= maxWidth) {
                built[i].push(movedN);
              } else {
                next.unshift(movedN);
              }
            }
          }
        }
      }

      // clamp por largura
      for (let i = 0; i < built.length; i++) {
        while (lineWidth(built[i]) > maxWidth && built[i].length > 1) {
          const spill = built[i].pop();
          if (i + 1 < built.length) {
            const target = built[i + 1];
            if (lineWidth(target) + (target.length ? SPACE_WIDTH : 0) + estimateWordWidth(spill.text, spill.isBold) <= maxWidth) {
              target.unshift(spill);
            }
          }
        }
      }

      if (built.length > maxLines) built.length = maxLines;
      return built;
    }

    const lines = wrapWordsToWidth(titleWords, boldStart, boldLength, titleMaxWidth, maxLines);

  // Calcular dimensões da barra baseado no texto do chapéu (proporcional)
  const HAT_FONT_SIZE = 33;
  const CHAR_WIDTH_HAT = 0.58; // heurística média para Poppins 600
  const hatText = chapeuUpper;
  const hatTextWidth = hatText ? Math.round(hatText.length * HAT_FONT_SIZE * CHAR_WIDTH_HAT) : 0;
  const barWidth = Math.max(hatTextWidth + 40, 200); // padding horizontal ~20px por lado
  const barHeight = 44;
  const barX = 60;
    const barY = type === 'story' ? 950 : 878;
    
    const textX = barX + (barWidth / 2);
    
  const titleStartY = type === 'story' ? 1120 : 1030; // manter baseline do template
  // titleMarginLeft=60 e titleMaxWidth=largura-120 já definidos acima

    // 4. Criar SVG com o texto (título e categoria) - FONTE POPPINS EXATA
    const textSvg = `
      <svg width="${dimensions.width}" height="${dimensions.height}" xmlns="http://www.w3.org/2000/svg">
        ${getEmbeddedFontsCss()}
        
        ${chapeuUpper ? `
          <!-- Chapéu com barra colorida por editoria -->
          <rect x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}" fill="${barColor}" rx="8"/>
          <text x="${textX}" y="${barY + 29}" fill="white" font-family="Poppins, Arial" font-size="33" font-weight="600" text-anchor="middle">${escapeXmlText(chapeuUpper)}</text>
        ` : ''}
        
        <!-- Título com múltiplas linhas -->
        ${lines.map((line, lineIndex) => {
          const y = titleStartY + (lineIndex * 85);
          
          const lineText = line.map((word, index) => {
            const weight = word.isBold ? '800' : '400';
            const spacing = index > 0 ? ' ' : '';
            return `${spacing}<tspan font-weight="${weight}">${escapeXmlText(word.text)}</tspan>`;
          }).join('');
          
          return `<text x="${titleMarginLeft}" y="${y}" fill="white" font-family="Poppins, Arial" font-size="76">${lineText}</text>`;
        }).join('')}
      </svg>
    `;

    // 5. Compor as camadas: imagem -> overlay -> texto
    const finalImage = await sharp(resizedImage)
      .composite([
        {
          input: overlayBuffer,
          top: 0,
          left: 0
        },
        {
          input: Buffer.from(textSvg),
          top: 0,
          left: 0
        }
      ])
      .png({ quality: 90 })
      .toBuffer();

    console.log('✅ Card gerado com sucesso');
    return finalImage;
    
  } catch (error) {
    console.error('❌ Erro ao gerar card:', error);
    throw error;
  }
}

// Função para publicar no Instagram
async function publishToInstagram(imageBuffer, caption) {
  console.log('📤 Publicando no Instagram...');
  
  try {
    // Validar URL pública
    if (!INSTAGRAM_CONFIG.PUBLIC_BASE_URL) {
      throw new Error('PUBLIC_BASE_URL não configurada. Defina uma URL pública acessível (ex.: https://seu-dominio.com) para a Meta baixar as imagens.');
    }

    // 1. Salvar imagem em pasta pública
    const filename = `post_${Date.now()}.png`;
    const publicDir = path.join(__dirname, 'public', 'uploads');
    await fs.ensureDir(publicDir);
    const filepath = path.join(publicDir, filename);
    await fs.writeFile(filepath, imageBuffer);

    // 2. Montar URL pública (acessível pela Meta)
    const imageUrl = `${INSTAGRAM_CONFIG.PUBLIC_BASE_URL.replace(/\/$/, '')}/uploads/${filename}`;
    console.log('🖼️ URL pública da imagem:', imageUrl);

    // 3. Criar container de mídia
    const createMediaUrl = `${INSTAGRAM_CONFIG.GRAPH_API_URL}/${INSTAGRAM_CONFIG.BUSINESS_ID}/media`;
    
    const mediaResponse = await makeHttpsRequest(createMediaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_url: imageUrl,
        caption: caption,
        access_token: INSTAGRAM_CONFIG.ACCESS_TOKEN
      })
    });

    const mediaResult = await mediaResponse.json();
    console.log('📱 Resposta do container:', mediaResult);

    if (!mediaResponse.ok || mediaResult.error) {
      throw new Error(mediaResult.error?.message || 'Erro ao criar container');
    }

    const creationId = mediaResult.id;
    console.log('✅ Container criado:', creationId);

  // 4. Aguardar processamento
    await new Promise(resolve => setTimeout(resolve, 3000));

  // 5. Publicar mídia
    const publishUrl = `${INSTAGRAM_CONFIG.GRAPH_API_URL}/${INSTAGRAM_CONFIG.BUSINESS_ID}/media_publish`;
    
    const publishResponse = await makeHttpsRequest(publishUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creation_id: creationId,
        access_token: INSTAGRAM_CONFIG.ACCESS_TOKEN
      })
    });

    const publishResult = await publishResponse.json();
    console.log('📱 Resposta da publicação:', publishResult);

    if (!publishResponse.ok || publishResult.error) {
      throw new Error(publishResult.error?.message || 'Erro ao publicar');
    }

  // 6. Limpar arquivo temporário (opcional)
    setTimeout(async () => {
      try {
    await fs.unlink(filepath).catch(() => {});
        console.log('🗑️ Arquivo temporário removido');
      } catch (err) {
        console.log('⚠️ Erro ao remover arquivo temporário:', err.message);
      }
    }, 5 * 60 * 1000);

    return {
      success: true,
      postId: publishResult.id,
      mediaId: creationId
    };

  } catch (error) {
    console.error('❌ Erro na publicação:', error);
    throw error;
  }
}

// ROTAS DA API

// Página inicial (interface web)
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>R10 Instagram Publisher</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f5f5f5;
        }
        .container {
            background: white;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .header {
            text-align: center;
            margin-bottom: 30px;
        }
        .logo {
            color: #e74c3c;
            font-size: 2.5em;
            font-weight: bold;
            margin-bottom: 10px;
        }
        .form-group {
            margin-bottom: 20px;
        }
        label {
            display: block;
            margin-bottom: 5px;
            font-weight: bold;
            color: #333;
        }
        input, textarea, select {
            width: 100%;
            padding: 12px;
            border: 2px solid #ddd;
            border-radius: 5px;
            font-size: 16px;
            box-sizing: border-box;
        }
        input[type="file"] {
            padding: 8px;
        }
        textarea {
            height: 100px;
            resize: vertical;
        }
        .btn {
            background: #e74c3c;
            color: white;
            padding: 15px 30px;
            border: none;
            border-radius: 5px;
            font-size: 16px;
            cursor: pointer;
            width: 100%;
            margin-top: 10px;
        }
        .btn:hover {
            background: #c0392b;
        }
        .preview {
            margin-top: 20px;
            text-align: center;
            display: none;
        }
        .preview img {
            max-width: 100%;
            max-height: 400px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);
        }
        .result {
            margin-top: 20px;
            padding: 15px;
            border-radius: 5px;
            display: none;
        }
        .success {
            background: #d4edda;
            border: 1px solid #c3e6cb;
            color: #155724;
        }
        .error {
            background: #f8d7da;
            border: 1px solid #f5c6cb;
            color: #721c24;
        }
        .loading {
            text-align: center;
            display: none;
        }
        .spinner {
            border: 4px solid #f3f3f3;
            border-top: 4px solid #e74c3c;
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
            margin: 0 auto;
        }
  .logo img { height: 80px; }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo"><img src="${R10_LOGO_DATAURL || '/r10post.png'}" alt="R10 POST"></div>
            <h2>Instagram Publisher</h2>
            <p>Geração e Publicação Automática de Cards</p>
        </div>

        <form id="publishForm" enctype="multipart/form-data">
            <div class="form-group">
                <label for="newsUrl">Link da Matéria (Extração Automática)</label>
                <div style="display: flex; gap: 10px;">
                    <input type="url" id="newsUrl" name="newsUrl" placeholder="https://r10piaui.com/noticias/..." style="flex: 1;">
                    <button type="button" class="btn" onclick="extractFromUrl()" style="width: auto; padding: 12px 20px; background: #3498db;">🔗 Extrair</button>
                </div>
                <small style="color: #666; margin-top: 5px; display: block;">Cole o link da matéria para preencher automaticamente título, categoria e imagem</small>
            </div>

            <div style="border-top: 1px solid #ddd; margin: 20px 0; padding-top: 20px;">
                <h3 style="color: #666; margin-bottom: 15px;">OU preencha manualmente:</h3>
            </div>

            <div class="form-group">
                <label for="title">Título da Matéria *</label>
                <textarea id="title" name="title" placeholder="Digite o título da matéria..." required></textarea>
            </div>
      <div class="form-group" style="margin-top: -10px;">
        <label style="display:flex; align-items:center; gap:8px; font-weight: normal; color:#333;">
          <input type="checkbox" id="useManualTitle" name="useManualTitle" value="1">
          Usar exatamente este título no card (sem IA)
        </label>
        <small style="color:#666;">A legenda sempre usa o título completo acima.</small>
      </div>

            <div class="form-group">
                <label for="customChapeu">Chapéu Personalizado (Opcional)</label>
                <input type="text" id="customChapeu" name="customChapeu" placeholder="Ex: DESTAQUE, URGENTE, EXCLUSIVO..." maxlength="15">
                <small style="color: #666; margin-top: 5px; display: block;">Se não preenchido, será gerado automaticamente pela IA</small>
            </div>

            <div class="form-group">
                <label for="highlightText">Texto em Destaque (Opcional)</label>
                <input type="text" id="highlightText" name="highlightText" placeholder="Palavras específicas para destacar em negrito...">
                <small style="color: #666; margin-top: 5px; display: block;">Se não preenchido, a IA escolherá automaticamente as palavras-chave</small>
            </div>

            <div class="form-group">
                <label for="image">Imagem do Card *</label>
                <input type="file" id="image" name="image" accept="image/*" required>
            </div>

            <div class="form-group">
                <label for="url">Link da Matéria</label>
                <input type="url" id="url" name="url" placeholder="https://www.r10piaui.com/materia/...">
            </div>

            <button type="button" class="btn" onclick="generatePreview()">🎨 Gerar Preview</button>
            <button type="button" class="btn" onclick="publishPost()" style="background: #27ae60;">📤 Publicar no Instagram</button>
        </form>

        <div class="loading" id="loading">
            <div class="spinner"></div>
            <p>Processando...</p>
        </div>

        <div class="preview" id="preview">
            <h3>Preview do Card</h3>
            <img id="previewImage" src="" alt="Preview">
            <div id="previewCaption" style="margin-top: 15px; text-align: left; background: #f8f9fa; padding: 15px; border-radius: 5px;"></div>
        </div>

        <div class="result" id="result"></div>
    </div>

    <script>
        let currentCardData = null;
        let extractedImageUrl = null;

        function showLoading() {
            document.getElementById('loading').style.display = 'block';
            document.getElementById('result').style.display = 'none';
        }

        function hideLoading() {
            document.getElementById('loading').style.display = 'none';
        }

        function showResult(message, isError = false) {
            const result = document.getElementById('result');
            result.className = 'result ' + (isError ? 'error' : 'success');
            result.innerHTML = message;
            result.style.display = 'block';
        }

        async function extractFromUrl() {
            const urlInput = document.getElementById('newsUrl');
            const url = urlInput.value.trim();
            
            if (!url) {
                showResult('❌ Digite uma URL para extrair os dados', true);
                return;
            }

            showLoading();

            try {
                const response = await fetch('/api/extract-url', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ url })
                });

                const result = await response.json();
                
                if (result.success) {
                    const data = result.data;
                    
                    // Preencher campos automaticamente
                    document.getElementById('title').value = data.title;
                    document.getElementById('category').value = data.category || '';
                    document.getElementById('url').value = data.originalUrl;
                    
                    // Armazenar URL da imagem extraída
                    extractedImageUrl = data.imageUrl;
                    
                    // Mostrar resultado
                    let message = '✅ Dados extraídos com sucesso!<br>';
                    message += '<strong>Título:</strong> ' + data.title.substring(0, 100);
                    if (data.title.length > 100) message += '...';
                    message += '<br>';
                    if (data.imageUrl) {
                        message += '<strong>Imagem:</strong> Encontrada automaticamente<br>';
                        // Ocultar campo de upload manual já que temos imagem
                        document.querySelector('label[for="image"]').innerHTML = 'Imagem do Card (Opcional - já extraída automaticamente)';
                        document.getElementById('image').required = false;
                    } else {
                        message += '<strong>Imagem:</strong> Não encontrada - você precisa fazer upload manual<br>';
                    }
                    message += '<br>Agora clique em "🎨 Gerar Preview" para ver o resultado!';
                    
                    showResult(message);
                } else {
                    showResult('❌ Erro ao extrair dados: ' + result.error, true);
                }
            } catch (error) {
                showResult('❌ Erro de conexão: ' + error.message, true);
            }

            hideLoading();
        }

        async function generatePreview() {
            const formData = new FormData(document.getElementById('publishForm'));
            
            // Se temos uma imagem extraída da URL, usar ela
            if (extractedImageUrl && !formData.get('image').size) {
                formData.append('extractedImageUrl', extractedImageUrl);
            }
      // Garantir inclusão explícita da flag de título manual
      const useManual = document.getElementById('useManualTitle').checked;
      if (useManual && !formData.get('useManualTitle')) {
        formData.append('useManualTitle', '1');
      }
            
            if (!formData.get('title')) {
                showResult('❌ Preencha o título da matéria', true);
                return;
            }

            if (!formData.get('image').size && !extractedImageUrl) {
                showResult('❌ Selecione uma imagem ou extraia de uma URL', true);
                return;
            }

            showLoading();

            try {
                const response = await fetch('/api/generate-card', {
                    method: 'POST',
                    body: formData
                });

                const result = await response.json();
                
        if (result.success) {
                    currentCardData = result;
                    document.getElementById('previewImage').src = 'data:image/png;base64,' + result.cardImage;
                    document.getElementById('previewCaption').innerHTML = '<strong>Legenda:</strong><br><br>' + result.caption.replace(/\\n/g, '<br>');
                    document.getElementById('preview').style.display = 'block';
          showResult('✅ Card gerado com sucesso! Confira o preview acima.<br>ℹ️ Ao publicar, incluiremos automaticamente a imagem 2 (publicidade fixa).');
                } else {
                    showResult('❌ Erro ao gerar card: ' + result.error, true);
                }
            } catch (error) {
                showResult('❌ Erro de conexão: ' + error.message, true);
            }

            hideLoading();
        }

        async function publishPost() {
            if (!currentCardData) {
                showResult('❌ Gere o preview primeiro antes de publicar', true);
                return;
            }

            if (!confirm('Tem certeza que deseja publicar este post no Instagram?')) {
                return;
            }

            showLoading();

            try {
                const response = await fetch('/api/publish-instagram', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(currentCardData)
                });

                const result = await response.json();
                
                if (result.success) {
                    showResult('🎉 Post publicado com sucesso no Instagram!<br>ID do Post: ' + result.postId);
                    currentCardData = null;
                    document.getElementById('preview').style.display = 'none';
                    document.getElementById('publishForm').reset();
                } else {
                    showResult('❌ Erro ao publicar: ' + result.error, true);
                }
            } catch (error) {
                showResult('❌ Erro de conexão: ' + error.message, true);
            }

            hideLoading();
        }

        // UX: se o usuário editar o título manualmente, marcar a flag "usar título manual"
        (function() {
          const titleEl = document.getElementById('title');
          const manualChk = document.getElementById('useManualTitle');
          if (titleEl && manualChk) {
            titleEl.addEventListener('input', () => {
              if (!manualChk.checked) manualChk.checked = true;
            });
          }
        })();

        // UX: chapéu sempre em caixa alta na edição manual
        (function() {
          const chEl = document.getElementById('customChapeu');
          if (chEl) {
            chEl.addEventListener('input', () => {
              const start = chEl.selectionStart; const end = chEl.selectionEnd;
              chEl.value = (chEl.value || '').toUpperCase();
              // restaurar caret
              try { chEl.setSelectionRange(start, end); } catch(e) {}
            });
            chEl.addEventListener('blur', () => { chEl.value = (chEl.value || '').toUpperCase(); });
          }
        })();
    </script>
</body>
</html>
  `);
});

// API para extrair dados de uma URL
app.post('/api/extract-url', async (req, res) => {
  console.log('🔗 Requisição para extrair dados de URL');
  
  try {
    const { url } = req.body;

    if (!url) {
      return res.json({ 
        success: false, 
        error: 'URL é obrigatória' 
      });
    }

    // Validar se é uma URL válida
    try {
      new URL(url);
    } catch {
      return res.json({ 
        success: false, 
        error: 'URL inválida' 
      });
    }

    console.log(`🔍 Extraindo dados de: ${url}`);
    const extractedData = await extractDataFromUrl(url);

    res.json({
      success: true,
      data: extractedData
    });

  } catch (error) {
    console.error('❌ Erro ao extrair dados:', error);
    res.json({ 
      success: false, 
      error: error.message 
    });
  }
});

// API para processar URL (extrai dados, gera título/chapéu/legenda e o card)
app.post('/api/process-url', async (req, res) => {
  console.log('🧠 Requisição para processar URL (end-to-end)');
  console.log('📥 Body recebido:', req.body);

  try {
  const { url, categoria, destaquePersonalizado } = req.body;
  const chapeuPersonalizado = req.body.chapeuPersonalizado || req.body.customChapeu;
    const newsUrl = url || req.body.newsUrl; // Suporte para ambos os formatos

    if (!newsUrl) {
      console.error('❌ URL não fornecida');
      return res.json({
        success: false,
        error: 'URL é obrigatória'
      });
    }

    if (!categoria) {
      console.error('❌ Categoria não fornecida');
      return res.json({
        success: false,
        error: 'Categoria é obrigatória'
      });
    }

    // Validar URL
    try {
      new URL(newsUrl);
    } catch (urlError) {
      console.error('❌ URL inválida:', newsUrl);
      return res.json({ success: false, error: 'URL inválida' });
    }

    console.log(`🔍 Extraindo dados iniciais de: ${newsUrl}`);
    const extracted = await extractDataFromUrl(newsUrl);

    console.log('📋 Resultado da extração:', {
      hasTitle: !!extracted?.title,
      hasImage: !!extracted?.imageUrl,
      extracted: extracted
    });

    if (!extracted || !extracted.title) {
      console.error('❌ Título não extraído');
      return res.json({ success: false, error: 'Não foi possível extrair o título da página' });
    }

    if (!extracted.imageUrl) {
      console.error('❌ Imagem não encontrada');
      return res.json({ success: false, error: 'Não foi possível localizar a imagem principal da notícia' });
    }

    const originalTitle = extracted.title;

    // Decodificar entidades HTML no título para uso na legenda
    function decodeHtmlEntitiesGlobal(text) {
      const entities = {
        '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': '\'', '&nbsp;': ' ',
        '&aacute;': 'á', '&Aacute;': 'Á', '&agrave;': 'à', '&Agrave;': 'À',
        '&acirc;': 'â', '&Acirc;': 'Â', '&atilde;': 'ã', '&Atilde;': 'Ã',
        '&auml;': 'ä', '&Auml;': 'Ä', '&eacute;': 'é', '&Eacute;': 'É',
        '&egrave;': 'è', '&Egrave;': 'È', '&ecirc;': 'ê', '&Ecirc;': 'Ê',
        '&iacute;': 'í', '&Iacute;': 'Í', '&igrave;': 'ì', '&Igrave;': 'Ì',
        '&icirc;': 'î', '&Icirc;': 'Î', '&oacute;': 'ó', '&Oacute;': 'Ó',
        '&ograve;': 'ò', '&Ograve;': 'Ò', '&ocirc;': 'ô', '&Ocirc;': 'Ô',
        '&otilde;': 'õ', '&Otilde;': 'Õ', '&uacute;': 'ú', '&Uacute;': 'Ú',
        '&ugrave;': 'ù', '&Ugrave;': 'Ù', '&ucirc;': 'û', '&Ucirc;': 'Û',
        '&ccedil;': 'ç', '&Ccedil;': 'Ç'
      };
      return text.replace(/&[a-zA-Z]+;/g, (entity) => entities[entity] || entity);
    }

  const decodedTitle = decodeHtmlEntitiesGlobal(originalTitle);

  // Otimizar título e gerar chapéu/legenda
  const optimizedTitle = await optimizeTitle(originalTitle, extracted.description);
  // Usar chapéu personalizado ou gerar automaticamente SEMPRE EM CAIXA ALTA
  const chapeu = (chapeuPersonalizado ? String(chapeuPersonalizado) : await generateChapeu(optimizedTitle)).toUpperCase();
  console.log(`🏷️ Chapéu definido: "${chapeu}" ${chapeuPersonalizado ? '(personalizado)' : '(automático)'}`);
  // Legenda deve usar o TÍTULO COMPLETO DECODIFICADO (sem entidades HTML)
  const caption = await generateCaption(decodedTitle, chapeu.toUpperCase());

    // Baixar a imagem para arquivo temporário
    let tempImagePath;
    try {
      console.log('📥 Baixando imagem para gerar o card:', extracted.imageUrl);
      const imageResponse = await makeHttpsRequest(extracted.imageUrl);
      if (!imageResponse.ok) {
        throw new Error(`Falha ao baixar a imagem (status ${imageResponse.status})`);
      }
      const imageBuffer = await imageResponse.buffer();
      const filename = `extracted_${Date.now()}.jpg`;
      tempImagePath = path.join(__dirname, 'uploads', filename);
      await fs.ensureDir(path.dirname(tempImagePath));
      await fs.writeFile(tempImagePath, imageBuffer);
      console.log('✅ Imagem baixada com sucesso');
    } catch (downloadErr) {
      console.error('❌ Erro ao baixar imagem:', downloadErr);
      return res.json({ success: false, error: 'Erro ao baixar a imagem da notícia' });
    }

    try {
      // Gerar o card usando o overlay físico
      const cardBuffer = await generateInstagramCard({
        title: optimizedTitle,
        categoria,
        imagePath: tempImagePath,
        chapeu,
        destaquePersonalizado,
        type: 'card'
      });

      // Limpar arquivo temporário
      try { await fs.unlink(tempImagePath); } catch {}

      return res.json({
        success: true,
        cardImage: cardBuffer.toString('base64'),
        caption,
        title: optimizedTitle,
        categoria,
        url,
        extractedImageUrl: extracted.imageUrl
      });
    } catch (genErr) {
      console.error('❌ Erro ao gerar card a partir da URL:', genErr);
      try { if (tempImagePath) await fs.unlink(tempImagePath); } catch {}
      return res.json({ success: false, error: genErr.message });
    }

  } catch (error) {
    console.error('❌ Erro no processamento da URL:', error);
    res.json({ success: false, error: error.message });
  }
});

// API para gerar card (preview)
app.post('/api/generate-card', upload.single('image'), async (req, res) => {
  console.log('📨 Requisição para gerar card recebida');
  
  try {
  const { title, category, url, extractedImageUrl } = req.body;
  const chapeuPersonalizado = req.body.chapeuPersonalizado || req.body.customChapeu;
    let { destaquePersonalizado } = req.body;
    
    // Processar destaquePersonalizado se for string JSON
    if (typeof destaquePersonalizado === 'string' && destaquePersonalizado !== '') {
      try {
        destaquePersonalizado = JSON.parse(destaquePersonalizado);
      } catch (e) {
        console.log('⚠️ destaquePersonalizado não é JSON válido, usando como texto');
      }
    }
    
    const useManualTitle = req.body.useManualTitle === '1' || req.body.useManualTitle === 'true';
    let imagePath = req.file?.path;

    if (!title) {
      return res.json({ 
        success: false, 
        error: 'Título é obrigatório' 
      });
    }

    // Se não temos arquivo de upload mas temos URL extraída, baixar a imagem
    if (!imagePath && extractedImageUrl) {
      console.log('📥 Baixando imagem da URL extraída:', extractedImageUrl);
      try {
        const imageResponse = await makeHttpsRequest(extractedImageUrl);
        if (imageResponse.ok) {
          const imageBuffer = await imageResponse.buffer();
          const filename = `extracted_${Date.now()}.jpg`;
          imagePath = path.join(__dirname, 'uploads', filename);
          await fs.ensureDir(path.dirname(imagePath));
          await fs.writeFile(imagePath, imageBuffer);
          console.log('✅ Imagem baixada com sucesso');
        }
      } catch (downloadError) {
        console.error('❌ Erro ao baixar imagem:', downloadError);
        return res.json({ 
          success: false, 
          error: 'Erro ao baixar imagem da URL: ' + downloadError.message 
        });
      }
    }

    if (!imagePath) {
      return res.json({ 
        success: false, 
        error: 'Imagem é obrigatória (upload ou URL)' 
      });
    }

    console.log(`📝 Processando: "${title}" (useManualTitle=${useManualTitle})`);

  // Definir título do card: manual (sem IA) ou otimizado via IA
    let optimizedTitle;
    if (useManualTitle) {
      // Usar exatamente o que o usuário digitou (apenas trim), sem IA e sem ajustes locais
      optimizedTitle = (title || '').toString().trim();
    } else {
      optimizedTitle = await optimizeTitle(title, undefined);
    }
    
    // Gerar chapéu complementar - usar personalizado se fornecido
  const chapeu = (chapeuPersonalizado ? String(chapeuPersonalizado) : await generateChapeu(optimizedTitle)).toUpperCase();
    console.log(`🏷️ Chapéu definido: "${chapeu}" ${chapeuPersonalizado ? '(personalizado)' : '(automático)'}`);
    
  // Decodificar entidades HTML no título para legenda
  function decodeHtmlEntitiesUpload(text) {
    const entities = {
      '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': '\'', '&nbsp;': ' ',
      '&aacute;': 'á', '&Aacute;': 'Á', '&agrave;': 'à', '&Agrave;': 'À',
      '&acirc;': 'â', '&Acirc;': 'Â', '&atilde;': 'ã', '&Atilde;': 'Ã',
      '&auml;': 'ä', '&Auml;': 'Ä', '&eacute;': 'é', '&Eacute;': 'É',
      '&egrave;': 'è', '&Egrave;': 'È', '&ecirc;': 'ê', '&Ecirc;': 'Ê',
      '&iacute;': 'í', '&Iacute;': 'Í', '&igrave;': 'ì', '&Igrave;': 'Ì',
      '&icirc;': 'î', '&Icirc;': 'Î', '&oacute;': 'ó', '&Oacute;': 'Ó',
      '&ograve;': 'ò', '&Ograve;': 'Ò', '&ocirc;': 'ô', '&Ocirc;': 'Ô',
      '&otilde;': 'õ', '&Otilde;': 'Õ', '&uacute;': 'ú', '&Uacute;': 'Ú',
      '&ugrave;': 'ù', '&Ugrave;': 'Ù', '&ucirc;': 'û', '&Ucirc;': 'Û',
      '&ccedil;': 'ç', '&Ccedil;': 'Ç'
    };
    return text.replace(/&[a-zA-Z]+;/g, (entity) => entities[entity] || entity);
  }
  
  const titleDecodificado = decodeHtmlEntitiesUpload(title);
  // Legenda deve usar o TÍTULO COMPLETO DECODIFICADO informado (não o otimizado)
  const caption = await generateCaption(titleDecodificado, chapeu.toUpperCase());
    
    // Gerar card
    const cardBuffer = await generateInstagramCard({
      title: optimizedTitle,
      categoria: category,
      imagePath,
      chapeu,
      destaquePersonalizado,
      type: 'card'
    });

    // Remover arquivo de upload/download temporário
    try {
      await fs.unlink(imagePath);
    } catch (err) {
      console.log('⚠️ Arquivo temporário já foi removido ou não existe');
    }

    res.json({
      success: true,
      cardImage: cardBuffer.toString('base64'),
      caption,
      title: optimizedTitle,
      categoria: category,
      url
    });

  } catch (error) {
    console.error('❌ Erro ao gerar card:', error);
    res.json({ 
      success: false, 
      error: error.message 
    });
  }
});

// API para upload da imagem publicitária
app.post('/api/upload-publicity', upload.single('publicity'), async (req, res) => {
  console.log('📤 Requisição para salvar card publicitário');
  
  try {
    if (!req.file) {
      return res.json({ 
        success: false, 
        error: 'Imagem publicitária é obrigatória' 
      });
    }

    // Redimensionar para 1080x1350 e salvar
  await fs.ensureDir(PERSIST_DIR);
  const publicityPath = path.join(PERSIST_DIR, 'publicity-card.jpg');
    const processed = await sharp(req.file.path)
      .resize(1080, 1350, { fit: 'cover', position: 'center' })
      .jpeg({ quality: 92 })
      .toBuffer();
    await fs.writeFile(publicityPath, processed);

    // Converter para base64 (preview)
    const base64Image = processed.toString('base64');

    // Limpar arquivo temporário
    await fs.unlink(req.file.path);

    console.log('✅ Card publicitário salvo com sucesso');

    res.json({
      success: true,
      publicityImage: base64Image
    });

  } catch (error) {
    console.error('❌ Erro ao salvar card publicitário:', error);
    res.json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Helper para obter e verificar caminho persistente da publi
function getPersistedPublicityPath() {
  return path.join(PERSIST_DIR, 'publicity-card.jpg');
}

// API para buscar a imagem publicitária salva (persistente)
app.get('/api/get-publicity', async (req, res) => {
  try {
    const publicityPath = getPersistedPublicityPath();
    const persisted = fs.existsSync(publicityPath);
    // Garante que exista uma publi persistida; se não existir, cria e salva a padrão
    const buffer = await getOrCreatePublicityBuffer();
    const base64Image = buffer.toString('base64');
    res.json({ success: true, publicityImage: base64Image, persisted });
  } catch (error) {
    res.json({ 
      success: false, 
      error: error.message 
    });
  }
});

// API para remover a imagem publicitária salva (persistente)
app.delete('/api/delete-publicity', async (req, res) => {
  try {
    const publicityPath = getPersistedPublicityPath();
    if (fs.existsSync(publicityPath)) {
      await fs.unlink(publicityPath);
      return res.json({ success: true, message: 'Publiciade removida' });
    }
    return res.json({ success: false, error: 'Nenhuma publi persistida' });
  } catch (error) {
    return res.json({ success: false, error: error.message });
  }
});

// Função para publicar carrossel no Instagram
async function publishCarouselToInstagram(images, caption) {
  console.log('📤 Publicando carrossel no Instagram...');
  
  try {
    if (!INSTAGRAM_CONFIG.PUBLIC_BASE_URL) {
      throw new Error('PUBLIC_BASE_URL não configurada. Defina uma URL pública acessível (ex.: https://seu-dominio.com) para a Meta baixar as imagens.');
    }

    // Passo 1: Criar containers para cada imagem
    const mediaIds = [];
    const publicDir = path.join(__dirname, 'public', 'uploads');
    await fs.ensureDir(publicDir);
  const tempFiles = [];

    for (let i = 0; i < images.length; i++) {
      const imageBuffer = images[i];
      console.log(`📸 Criando container para imagem ${i + 1}/${images.length}...`);

      // Salvar arquivo público
      const filename = `carousel_${Date.now()}_${i + 1}.png`;
  const filepath = path.join(publicDir, filename);
  await fs.writeFile(filepath, imageBuffer);
  tempFiles.push(filepath);

      const imageUrl = `${INSTAGRAM_CONFIG.PUBLIC_BASE_URL.replace(/\/$/, '')}/uploads/${filename}`;

      // Criar container com image_url
      const createUrl = `${INSTAGRAM_CONFIG.GRAPH_API_URL}/${INSTAGRAM_CONFIG.BUSINESS_ID}/media`;
      const containerResponse = await makeHttpsRequest(createUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_url: imageUrl,
          is_carousel_item: true,
          access_token: INSTAGRAM_CONFIG.ACCESS_TOKEN
        })
      });

      const containerData = await containerResponse.json();
      console.log(`📋 Container ${i + 1} response:`, containerData);

      if (!containerResponse.ok || containerData.error) {
        // Limpeza imediata dos arquivos criados até aqui
        for (const f of tempFiles) { try { await fs.unlink(f); } catch {} }
        throw new Error(`Erro no container ${i + 1}: ${containerData.error?.message || 'Falha ao criar container'}`);
      }

      mediaIds.push(containerData.id);
    }
    
    console.log(`📋 Containers criados:`, mediaIds);
    
    // Passo 2: Criar container do carrossel
    const carouselCreateUrl = `${INSTAGRAM_CONFIG.GRAPH_API_URL}/${INSTAGRAM_CONFIG.BUSINESS_ID}/media`;
    const carouselResponse = await makeHttpsRequest(carouselCreateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        media_type: 'CAROUSEL',
        children: mediaIds.join(','),
        caption,
        access_token: INSTAGRAM_CONFIG.ACCESS_TOKEN
      })
    });
    const carouselData = await carouselResponse.json();
    console.log('📋 Carousel container response:', carouselData);
    
    if (!carouselResponse.ok || carouselData.error) {
      for (const f of tempFiles) { try { await fs.unlink(f); } catch {} }
      throw new Error(`Erro no carrossel: ${carouselData.error?.message || 'Falha ao criar carrossel'}`);
    }
    
    // Passo 3: Publicar o carrossel
    const publishUrl = `${INSTAGRAM_CONFIG.GRAPH_API_URL}/${INSTAGRAM_CONFIG.BUSINESS_ID}/media_publish`;
    const publishResponse = await makeHttpsRequest(publishUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creation_id: carouselData.id,
        access_token: INSTAGRAM_CONFIG.ACCESS_TOKEN
      })
    });
    const publishData = await publishResponse.json();
    console.log('📋 Publish response:', publishData);
    
    if (!publishResponse.ok || publishData.error) {
      for (const f of tempFiles) { try { await fs.unlink(f); } catch {} }
      throw new Error(`Erro na publicação: ${publishData.error?.message || 'Falha ao publicar'}`);
    }

    // Limpeza agendada dos arquivos do carrossel (não persistir cards, apenas publi fixa permanece)
    setTimeout(async () => {
      for (const f of tempFiles) {
        try { await fs.unlink(f); } catch {}
      }
      console.log('🗑️ Arquivos do carrossel removidos');
    }, 10 * 60 * 1000);
    
    return {
      postId: publishData.id,
      carouselId: carouselData.id,
      mediaIds: mediaIds
    };
    
  } catch (error) {
    console.error('❌ Erro ao publicar carrossel:', error);
    throw error;
  }
}

// API para publicar carrossel no Instagram
app.post('/api/publish-carousel', async (req, res) => {
  console.log('📤 Requisição para publicar carrossel no Instagram');
  
  try {
    const { newsCard, caption } = req.body;

    if (!newsCard || !caption) {
      return res.json({ 
        success: false, 
        error: 'Card da notícia e legenda são obrigatórios' 
      });
    }

    // Converter base64 para buffer da notícia e usar SEMPRE a publi persistida/padrão
    const newsBuffer = Buffer.from(newsCard, 'base64');
    const publicityBuffer = await getOrCreatePublicityBuffer();
    
    // Publicar carrossel no Instagram
    const result = await publishCarouselToInstagram([newsBuffer, publicityBuffer], caption);

    res.json({
      success: true,
      postId: result.postId,
      carouselId: result.carouselId,
      mediaIds: result.mediaIds
    });

  } catch (error) {
    console.error('❌ Erro ao publicar carrossel:', error);
    res.json({ 
      success: false, 
      error: error.message 
    });
  }
});

// API para publicar no Instagram (mantida para compatibilidade)
app.post('/api/publish-instagram', async (req, res) => {
  console.log('📤 Requisição para publicar no Instagram');
  
  try {
    const { cardImage, caption } = req.body;

    if (!cardImage || !caption) {
      return res.json({ 
        success: false, 
        error: 'Dados do card são obrigatórios' 
      });
    }

    // Converter base64 para buffer
    const imageBuffer = Buffer.from(cardImage, 'base64');

    // Sempre publicar como carrossel: notícia + PUBLI fixa (persistida ou gerada e gravada)
    const publicityBuffer = await getOrCreatePublicityBuffer();
    const carResult = await publishCarouselToInstagram([imageBuffer, publicityBuffer], caption);
    return res.json({ success: true, postId: carResult.postId, carouselId: carResult.carouselId, mediaIds: carResult.mediaIds, usedCarousel: true });

  } catch (error) {
    console.error('❌ Erro ao publicar:', error);
    res.json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Servir fontes como arquivos estáticos (backup para Render)
app.use('/fonts', express.static(path.join(__dirname, 'fonts')));

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 R10 Instagram Publisher iniciado na porta ${PORT}`);
  console.log(`🌐 Acesse: http://localhost:${PORT}`);
  console.log(`📱 Instagram Business ID: ${INSTAGRAM_CONFIG.BUSINESS_ID || 'NÃO DEFINIDO'}`);
  console.log(`🔑 IG Token configurado? ${INSTAGRAM_CONFIG.ACCESS_TOKEN ? 'Sim' : 'Não'}`);
  console.log(`🤖 Groq AI configurado? ${GROQ_CONFIG.API_KEY ? 'Sim' : 'Não'}`);
  console.log(`💾 Diretório persistente da PUBLI: ${PERSIST_DIR}`);
  if (!GROQ_CONFIG.API_KEY) console.log('⚠️ Defina a variável de ambiente GROQ_API_KEY para habilitar IA.');
  if (!INSTAGRAM_CONFIG.ACCESS_TOKEN) console.log('⚠️ Defina IG_ACCESS_TOKEN para publicar no Instagram.');
  if (!INSTAGRAM_CONFIG.PUBLIC_BASE_URL) console.log('⚠️ Defina PUBLIC_BASE_URL (ex.: https://seu-dominio.com) para permitir a publicação (image_url exigido pela Meta).');
});

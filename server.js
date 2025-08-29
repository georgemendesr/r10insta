const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const https = require('https');
const http = require('http');
const { createCanvas, loadImage, registerFont } = require('canvas');

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
} catch (e) {
  console.log('⚠️ dotenv não carregado (opcional)');
}

// Registrar fontes Poppins para Canvas
try {
  const fontsDir = path.join(__dirname, 'fonts');
  console.log(`🔍 Procurando fontes em: ${fontsDir}`);
  
  const regularPath = path.join(fontsDir, 'Poppins-Regular.ttf');
  const semiboldPath = path.join(fontsDir, 'Poppins-SemiBold.ttf');
  const extraboldPath = path.join(fontsDir, 'Poppins-ExtraBold.ttf');
  
  if (fs.existsSync(regularPath) && fs.existsSync(semiboldPath) && fs.existsSync(extraboldPath)) {
    registerFont(regularPath, { family: 'Poppins', weight: '400' });
    registerFont(semiboldPath, { family: 'Poppins', weight: '600' });
    registerFont(extraboldPath, { family: 'Poppins', weight: '800' });
    console.log('✅ Fontes Poppins registradas no Canvas com sucesso!');
  } else {
    throw new Error('Arquivos de fonte Poppins não encontrados');
  }
} catch (error) {
  console.error('❌ ERRO ao registrar fontes Poppins:', error.message);
  console.log('🔄 Canvas vai usar fontes padrão como fallback');
}

const app = express();
const PORT = parseInt(process.env.PORT || '9000', 10);

// Middlewares essenciais
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static para servir a pasta public e, em especial, /uploads (necessário para image_url)
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

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
  const resp = await makeHttpsRequest(pageUrl, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 R10Publisher' } });
  if (!resp.ok) throw new Error(`Falha ao carregar URL (status ${resp.status})`);
  const html = await resp.text();

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

  return {
    title: (title || '').replace(/\s+/g, ' ').trim(),
    description: (description || '').trim(),
    imageUrl: imageUrl || '',
    originalUrl: pageUrl
  };
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

// Utilitário global simples para decodificar entidades HTML comuns
function decodeHtmlEntitiesAll(text = '') {
  if (!text || typeof text !== 'string') return text || '';
  const entities = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ',
    '&aacute;': 'á', '&Aacute;': 'Á', '&agrave;': 'à', '&Agrave;': 'À',
    '&acirc;': 'â', '&Acirc;': 'Â', '&atilde;': 'ã', '&Atilde;': 'Ã',
    '&auml;': 'ä', '&Aumel;': 'Ä', '&eacute;': 'é', '&Eacute;': 'É',
    '&egrave;': 'è', '&Egrave;': 'È', '&ecirc;': 'ê', '&Ecirc;': 'Ê',
    '&iacute;': 'í', '&Iacute;': 'Í', '&igrave;': 'ì', '&Igrave;': 'Ì',
    '&icirc;': 'î', '&Icirc;': 'Î', '&oacute;': 'ó', '&Oacute;': 'Ó',
    '&ograve;': 'ò', '&Ograve;': 'Ò', '&ocirc;': 'ô', '&Ocirc;': 'Ô',
    '&otilde;': 'õ', '&Otilde;': 'Õ', '&uacute;': 'ú', '&Uacute;': 'Ú',
    '&ugrave;': 'ù', '&Ugrave;': 'Ù', '&ucirc;': 'û', '&Ucirc;': 'Û',
    '&ccedil;': 'ç', '&Ccedil;': 'Ç',
    // Entidades numéricas e especiais
    '&ordm;': 'º', '&ordf;': 'ª', '&deg;': '°', '&plusmn;': '±',
    '&sup1;': '¹', '&sup2;': '²', '&sup3;': '³', '&frac14;': '¼',
    '&frac12;': '½', '&frac34;': '¾', '&iquest;': '¿', '&iexcl;': '¡',
    '&laquo;': '«', '&raquo;': '»', '&ldquo;': '"', '&rdquo;': '"',
    '&lsquo;': "'", '&rsquo;': "'", '&ndash;': '–', '&mdash;': '—'
  };
  return text.replace(/&[a-zA-Z0-9]+;/g, (entity) => entities[entity] || entity).normalize('NFC');
}

// Otimizar título com Groq (ajustes mínimos, até 60 chars) com fallback conservador
async function optimizeTitle(title) {
  const MAX = 60;
  const conservative = () => {
    const cleaned = (decodeHtmlEntitiesAll(title || ''))
      .replace(/[\u2026]|\.{3,}/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .normalize('NFC');
    // clamp suave por palavra
    if (cleaned.length > MAX) {
      const slice = cleaned.slice(0, MAX + 1);
      const cut = slice.lastIndexOf(' ');
      return (cut > 40 ? slice.slice(0, cut) : cleaned.slice(0, MAX)).trim();
    }
    return cleaned;
  };

  try {
    if (!GROQ_CONFIG.API_KEY) {
      console.log('🟡 GROQ_API_KEY não configurada — usando fallback conservador');
      return conservative();
    }

  const prompt = `Você é editor de manchetes jornalísticas (pt-BR). Reescreva o título abaixo com AJUSTES MÍNIMOS, mantendo sentido, clareza e correção gramatical.

Regras:
- Até ${MAX} caracteres (contando espaços)
- Sem reticências, aspas, hashtags, emojis ou ponto final
- Tom direto, neutro e jornalístico (pt-BR)
- Preserve nomes próprios e o núcleo semântivo

Título: "${(title || '').replace(/\s+/g,' ').trim()}"

Responda SOMENTE com a manchete final.`;

    const response = await makeHttpsRequest(GROQ_CONFIG.API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_CONFIG.API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: GROQ_CONFIG.MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 120,
        temperature: 0.2
      })
    });

    if (!response.ok) {
      console.log('⚠️ Groq indisponível para título, usando fallback');
      return conservative();
    }
    const data = await response.json();
    let out = (data.choices?.[0]?.message?.content || '').trim();
    out = decodeHtmlEntitiesAll(out)
      .replace(/[\u2026]|\.{3,}/g, '')
      .replace(/["“”'’]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .normalize('NFC');
    if (!out) return conservative();
    if (out.length > MAX) {
      const slice = out.slice(0, MAX + 1);
      const cut = slice.lastIndexOf(' ');
      out = (cut > 40 ? slice.slice(0, cut) : out.slice(0, MAX)).trim();
    }
    console.log(`📰 Título otimizado (Groq): "${out}"`);
    return out;
  } catch (e) {
    console.log('⚠️ Erro na otimização Groq, usando fallback:', e.message);
    return conservative();
  }
}

function finalizeHeadline(text) {
  if (!text) return text;
  return decodeHtmlEntitiesAll(text || '')
    .replace(/[\u2026]|\.{3,}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFC');
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

// Função para gerar chapéu com Groq AI (até 2 palavras, não repetir palavras do título)
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
          content: `Crie um CHAPÉU (rótulo curto) de NO MÁXIMO 2 PALAVRAS em MAIÚSCULAS que complemente a manchete abaixo.

TÍTULO: "${(title || '').replace(/\s+/g,' ').trim()}"

REGRAS:
- OBRIGATÓRIO: Responder APENAS em PORTUGUÊS BRASILEIRO
- PROIBIDO: inglês (HEALTH, NEWS, etc.), espanhol (SALUD, NOTICIAS, etc.) ou outros idiomas
- Não repita nenhuma palavra do título (ignore acentos e caixa)
- Sem pontuação, aspas, emojis ou hashtags
- Tom jornalístico e objetivo
 - Até 18 caracteres no total
 - Deve ser diretamente relacionado ao tema/assunto/entidade do título (ex.: editoria, órgão, local, tema)
 - PROIBIDO usar termos genéricos: NOTÍCIA, DESTAQUE, URGENTE, IMPORTANTE, AGORA, OFICIAL, CONFIRMADO, NOVIDADE, ÚLTIMA HORA, ALERTA, ATUALIZAÇÃO, VEJA, ENTENDA, AO VIVO, EXCLUSIVO
 - Português do Brasil. Evite variantes pt-PT (ex.: ATIVO, não ACTIVO)
 - Evite siglas soltas; se usar sigla, ela deve existir no título e ter 3+ letras
 - EXEMPLOS VÁLIDOS: SAÚDE, POLÍTICA, ECONOMIA, EDUCAÇÃO, SEGURANÇA

Responda APENAS com o chapéu final em PORTUGUÊS.`
        }],
        max_tokens: 8,
        temperature: 0.2
      })
    });

    console.log(`📡 Status da resposta Groq (chapéu): ${response.status}`);
    
    if (response.ok) {
      const data = await response.json();
      console.log(`📝 Resposta Groq chapéu:`, JSON.stringify(data, null, 2));
      
      let ch = (data.choices[0]?.message?.content || '')
        .replace(/["“”'’]/g, '')
        .toUpperCase()
        .trim();

      // Sanitizar: até 2 palavras e sem repetir palavras do título
      const normalize = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const titleWords = new Set((title || '')
        .split(/\s+/)
        .map(w => normalize(w))
        .filter(Boolean));

      let parts = ch.split(/\s+/).filter(Boolean).slice(0, 2);
      parts = parts.filter(p => !titleWords.has(normalize(p)));
      let cleanChapeu = parts.join(' ').trim();
      if (cleanChapeu.length > 18) cleanChapeu = cleanChapeu.slice(0, 18).trim();

      // Bloquear termos genéricos, palavras em inglês e espanhol
      const bannedRaw = [
        'NOTÍCIA','NOTICIA','DESTAQUE','URGENTE','IMPORTANTE','AGORA','OFICIAL','CONFIRMADO','NOVIDADE','ÚLTIMA HORA','ULTIMA HORA','ALERTA','ATUALIZAÇÃO','ATUALIZACAO','VEJA','ENTENDA','AO VIVO','EXCLUSIVO',
        // Palavras em inglês que devem ser rejeitadas
        'HEALTH','NEWS','BREAKING','UPDATE','POLITICS','ECONOMY','EDUCATION','SECURITY','GOVERNMENT','PUBLIC','PRIVATE','FEDERAL','STATE','LOCAL','BUSINESS','FINANCE','TECHNOLOGY','SCIENCE','SPORTS','CULTURE','SOCIETY','ENVIRONMENT','CLIMATE','COVID','PANDEMIC','VACCINE','HOSPITAL','MEDICAL','DOCTOR','PATIENT','TREATMENT','EMERGENCY','URGENT','IMPORTANT','OFFICIAL','CONFIRMED','LATEST','EXCLUSIVE','LIVE',
        // Palavras em espanhol que devem ser rejeitadas
        'SALUD','NOTICIAS','ACTUALIZACIÓN','ACTUALIZACIÓN','POLÍTICA','POLÍTICAS','ECONOMÍA','ECONOMIA','EDUCACIÓN','EDUCACION','SEGURIDAD','GOBIERNO','PÚBLICO','PÚBLICO','PRIVADO','FEDERAL','ESTATAL','LOCAL','NEGOCIO','FINANZAS','TECNOLOGÍA','TECNOLOGIA','CIENCIA','DEPORTES','CULTURA','SOCIEDAD','AMBIENTE','CLIMA','VACUNA','HOSPITAL','MÉDICO','MEDICO','PACIENTE','TRATAMIENTO','EMERGENCIA','URGENTE','IMPORTANTE','OFICIAL','CONFIRMADO','ÚLTIMO','ULTIMO','EXCLUSIVO','VIVO','EN VIVO',
        // Palavras PT-PT que devem ser rejeitadas (usar PT-BR)
        'CAFETARIA','ACTIVO','ACTIVA','INFORMÁTICA','POLÍCIA'
      ];
      const banned = new Set(bannedRaw.map(normalize));
      // Mapear pt-PT -> pt-BR e evitar siglas curtas
      const mapPtPtToPtBr = (s) => s
        .replace(/\bACTIVO\b/g, 'ATIVO')
        .replace(/\bACTIVA\b/g, 'ATIVA')
        .replace(/\bCAFETARIA\b/g, 'CAFETERIA');
      cleanChapeu = mapPtPtToPtBr(cleanChapeu).toUpperCase();
      const titleTokens = new Set((title || '').split(/\s+/).map(w => w.toUpperCase()));
      const tokens = cleanChapeu.split(/\s+/).filter(Boolean);
      const hasShortAcronym = tokens.some(t => t.length < 3 && !titleTokens.has(t));
      const deriveChapeuFromTitle = (t) => {
        const nt = normalize(t || '');
        const has = (re) => re.test(nt);
        if (has(/pol[ií]cia|homic[ií]dio|assalto|roubo|furto|delegacia|pris[aã]o|flagrante/)) return 'SEGURANÇA';
        if (has(/just[ií]ça|\bstf\b|\bstj\b|tribunal|ju[ií]z|promotor|\bmpf\b|\bmp\b|defensoria/)) return 'JUDICIÁRIO';
        if (has(/elei[cç][aã]o|prefeit|vereador|c[aâ]mara|assembleia|governo|congresso|senado|ministro|pol[ií]tica/)) return 'GESTÃO';
        if (has(/economia|infla[cç][aã]o|imposto|sal[aá]rio|com[eé]rcio|ind[uú]stria|pre[cç]o|d[oó]lar|\bpib\b/)) return 'ECONOMIA';
        if (has(/sa[uú]de|\bsus\b|hospital|m[eé]dic|vacina|covid|dengue|zika|hepatite|\bupa\b/)) return 'SAÚDE';
        if (has(/educa[cç][aã]o|escola|professor|aluno|enem|universidade|\bifpi\b|\bufpi\b/)) return 'EDUCAÇÃO';
        if (has(/esporte|jogo|campeonato|copa|atleta|futebol|placar|partida/)) return 'ESPORTES';
        if (has(/tr[aâ]nsito|acidente|rodovia|br-?\d+|detran|engarrafamento/)) return 'MOBILIDADE';
        if (has(/clima|chuva|seca|tempo|calor|frente fria|inmet/)) return 'CLIMA';
        if (has(/cultura|festival|show|teatro|cinema|museu|exposi[cç][aã]o|livro/)) return 'CULTURA';
        if (has(/tecnologia|aplicativo|celular|internet|startup|intelig[eê]ncia artificial|\bia\b/)) return 'TECNOLOGIA';
        if (has(/transporte|[ôo]nibus|metr[ôo]|aeroporto|v[oô]o|ferrovia/)) return 'TRANSPORTE';
        if (has(/infraestrutura|obra|ponte|asfalto|saneamento/)) return 'INFRAESTRUTURA';
        if (has(/energia|apag[aã]o|eletricidade|combust[ií]vel|gasolina|diesel/)) return 'ENERGIA';
        if (has(/turismo|turista|hotel|resort|ponto tur[ií]stico/)) return 'TURISMO';
        if (!titleWords.has(normalize('Piauí'))) return 'PIAUÍ';
        if (!titleWords.has(normalize('Teresina'))) return 'CAPITAL';
        if (!titleWords.has(normalize('Brasil'))) return 'NACIONAL';
        if (!titleWords.has(normalize('interior'))) return 'INTERIOR';
        return '';
      };
  const isBanned = banned.has(normalize(cleanChapeu));
  if (!cleanChapeu || isBanned || hasShortAcronym) {
        const derived = deriveChapeuFromTitle(title);
        if (derived) cleanChapeu = derived;
      }

      if (cleanChapeu) {
        console.log(`✅ Chapéu gerado: "${cleanChapeu}"`);
        return cleanChapeu;
      }
      console.log('⚠️ Chapéu vazio ou repetindo título, aplicando fallback');
    } else {
      const errorData = await response.json();
      console.error('❌ Erro na API Groq (chapéu):', errorData);
    }
  } catch (error) {
    console.error('❌ Erro ao gerar chapéu:', error.message);
    console.error('❌ Stack:', error.stack);
  }
  
  // Fallback orientado pelo título (evitar genéricos)
  const normalize = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const titleWords = new Set((title || '').split(/\s+/).map(w => normalize(w)).filter(Boolean));
  const regionCandidates = ['PIAUÍ','CAPITAL','NACIONAL','INTERIOR'];
  const region = regionCandidates.find(c => !titleWords.has(normalize(c)));
  const derived = region || 'ESPECIAL';
  console.log(`🔄 Fallback chapéu: "${derived}"`);
  return derived;
}

// Função para gerar legenda com Groq (sem categoria)
async function generateCaption(title, chapeu, description) {
  try {
    // Decodificar entidades HTML antes de enviar para o Groq
    const cleanTitle = decodeHtmlEntitiesAll(title || '');
    const cleanDescription = decodeHtmlEntitiesAll(description || '');
    
    console.log(`🤖 Gerando legenda para: "${cleanTitle}" (chapéu: ${chapeu})`);
    
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
      content: `Você é social media jornalístico. Escreva uma legenda clara, enxuta e com ótima leitura no Instagram.

TÍTULO (use na 1ª linha, sem alterar): ${cleanTitle}
${cleanDescription ? `\nDESCRIÇÃO/CONTEXTO: ${cleanDescription}` : ''}

REGRAS OBRIGATÓRIAS:
- Não repita o título nem ideias já ditas; nada de redundância
- 1 linha curta explicando o essencial (baseie-se no contexto se houver)
- Respeite EXATAMENTE as quebras de linha do modelo abaixo
- Não inclua categoria/editoria; linguagem profissional e direta
- Sem aspas nem rótulos como "TÍTULO:" ou "LEGENDA:"
- JAMAIS use placeholders como [idade], [local], [nome] ou similares
- Use APENAS informações concretas do título/contexto fornecido
- Se não souber uma informação específica, não mencione ela

MODELO EXATO (mantenha linhas em branco exatamente assim):
${cleanTitle}

[uma linha curta, objetiva e humana que contextualiza]

📍 Leia a matéria completa em www.r10piaui.com

🔴 R10 Piauí – Dá gosto de ver!

#R10Piauí #Notícias #Piauí

Responda SOMENTE com o texto final, sem comentários.`
        }],
        max_tokens: 200,
    temperature: 0.15
      })
    });

    console.log(`📡 Status da resposta Groq (legenda): ${response.status}`);
    
    if (response.ok) {
      const data = await response.json();
      console.log(`📝 Resposta Groq legenda:`, JSON.stringify(data, null, 2));
      
      let caption = data.choices[0]?.message?.content?.trim();
      if (caption && caption.length > 0) {
        // VALIDAÇÃO CRÍTICA: Detectar placeholders proibidos
        const placeholders = /\[[\w\sáàâäãéèêëíìîïóòôöõúùûüç]+\]/gi;
        if (placeholders.test(caption)) {
          console.log('🚨 ERRO CRÍTICO: Legenda contém placeholders proibidos');
          console.log('📝 Legenda rejeitada:', caption);
          // Usar fallback em vez da legenda com placeholders
          caption = null;
        } else {
          // Normalizar: remover reticências, linhas extras, e assegurar 1ª linha = título
          caption = caption.replace(/[\u2026]|\.\.\./g, '').replace(/\r/g, '');
          const parts = caption.split('\n').map(s => s.trim()).filter(Boolean);
          if (parts.length > 0) parts[0] = cleanTitle; // Usar título decodificado
          // Reconstituir com linhas em branco entre blocos
          caption = parts.join('\n\n');
          console.log('✅ Legenda gerada com sucesso (normalizada)');
          return caption;
        }
      }
      
      if (!caption) {
        console.log('❌ Legenda vazia, inválida ou com placeholders');
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
      '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ',
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
  
  const titleDecodificado = decodeHtmlEntitiesAll(title);
  const fallbackCaption = `${titleDecodificado}

Resumo curto e direto do que aconteceu.

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
  console.log(`🏷️ Usando chapéu: "${chapeuFinal}"`);
  
  try {
    // Função auxiliar para escapar XML
    function escapeXml(unsafe) {
      return unsafe.replace(/[<>&'"]/g, function (c) {
        switch (c) {
          case '<': return '&lt;';
          case '>': return '&gt;';
          case '&': return '&amp;';
          case '\'': return '&apos;';
          case '"': return '&quot;';
        }
      });
    }

    // Função para decodificar entidades HTML
    function decodeHtmlEntities(text) {
      const entities = {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&apos;': "'",
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
      'entretenimento': '#9333ea',   // � ENTRETENIMENTO: Roxo
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

    // 3.b Destaque via Groq: escolher 2 palavras contíguas do título (ou 1 se não houver par bom)
    async function generateGroqHighlight(text) {
      try {
        if (!GROQ_CONFIG.API_KEY) return null;
        const prompt = `Escolha EXATAMENTE 2 PALAVRAS CONTÍGUAS do TÍTULO abaixo para destacar no card (se não houver par bom, retorne 1 palavra forte).\n\nTÍTULO: "${(text || '').replace(/\s+/g, ' ').trim()}"\n\nCRITÉRIOS (em ordem):\n- Aumentar impacto informativo (pode estar no meio do título)\n- Preferir nomes próprios/entidades, número + substantivo, local + evento, verbo + substantivo\n- Evitar iniciar/terminar com stopwords (de, da, do, em, na, no, com, para, por, a, o, e, que)\n- As palavras devem ser cópia EXATA e CONTÍGUAS no título\n\nFORMATO DE RESPOSTA (JSON válido):\n{ "highlight": "DUAS PALAVRAS CONTÍGUAS DO TÍTULO" }`;

        const response = await makeHttpsRequest(GROQ_CONFIG.API_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${GROQ_CONFIG.API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: GROQ_CONFIG.MODEL,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 30,
            temperature: 0.1
          })
        });
        if (!response.ok) return null;
        const data = await response.json();
        let raw = (data.choices?.[0]?.message?.content || '').trim();
        // Tentar parsear JSON
        let hl = '';
        try {
          const m = raw.match(/\{[\s\S]*\}/);
          if (m) {
            const obj = JSON.parse(m[0]);
            hl = (obj.highlight || '').toString();
          }
        } catch {}
        if (!hl) {
          // fallback: usar primeira linha/sem aspas
          hl = raw.replace(/^"|"$/g, '');
        }
        hl = decodeHtmlEntitiesAll(hl).replace(/\s+/g, ' ').trim();
        if (!hl) return null;

        // Validar presença contígua no título e derivar índices
        const normalize = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const titleWords = (text || '').split(' ').filter(Boolean);
        const normTitle = titleWords.map(w => normalize(w));
        const hlWords = hl.split(' ').filter(Boolean);
        const normHl = hlWords.map(w => normalize(w));

        let startIdx = -1;
        for (let i = 0; i <= normTitle.length - normHl.length; i++) {
          let ok = true;
          for (let j = 0; j < normHl.length; j++) {
            if (normTitle[i + j] !== normHl[j]) { ok = false; break; }
          }
          if (ok) { startIdx = i; break; }
        }
        if (startIdx >= 0) {
          const len = Math.min(2, Math.max(1, normHl.length));
          console.log(`🤖 Groq destacou: "${hl}" (start ${startIdx}, len ${len})`);
          return { boldStart: startIdx, boldLength: len };
        }
        return null;
      } catch (e) {
        console.log('⚠️ Groq highlight indisponível:', e.message);
        return null;
      }
    }

  // Não truncar o título antes; deixar o algoritmo de quebra distribuir em até 3 linhas
  const adaptedTitle = title;
  const titleWords = adaptedTitle.split(' ');
  // Determinar destaque: usar personalizado, depois Groq, depois automático local
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
    // Tentar Groq primeiro
    const groqHL = await generateGroqHighlight(adaptedTitle);
    if (groqHL && groqHL.boldStart >= 0) {
      boldStart = groqHL.boldStart;
      boldLength = groqHL.boldLength;
      console.log('✅ Destaque via Groq aplicado');
    } else {
      // Fallback: heurística local
      const result = findKeywords(adaptedTitle);
      boldStart = result.boldStart;
      boldLength = result.boldLength;
      console.log('🔄 Destaque heurístico local aplicado');
    }
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

  // Parâmetros da barra do chapéu (largura proporcional ao texto)
  const barHeight = 44;
  const barX = 60;
  const barY = type === 'story' ? 950 : 878;
    
  // Subir o título mais 20px (total +40px desde o original)
  const titleStartY = type === 'story' ? 1040 : 940; // antes: 1060/960
  // titleMarginLeft=60 e titleMaxWidth=largura-120 já definidos acima

    // 4. 🎯 SISTEMA HÍBRIDO: Sharp + Overlay PNG + Canvas Poppins para texto
    console.log('🎨 Usando Sharp + Overlay PNG + Canvas para texto Poppins...');
    
    // Primeiro: Compor imagem base + overlay PNG usando Sharp
    const baseComposite = await sharp(resizedImage)
      .composite([{
        input: overlayBuffer,
        top: 0,
        left: 0
      }])
      .png()
      .toBuffer();

    // Segundo: Criar Canvas para renderizar APENAS os textos com Poppins
    const canvas = createCanvas(dimensions.width, dimensions.height);
    const ctx = canvas.getContext('2d');

    // Carregar imagem base+overlay no Canvas
    const baseImage = await loadImage(baseComposite);
    ctx.drawImage(baseImage, 0, 0, dimensions.width, dimensions.height);

    // Chapéu (se existir) - renderizar SOBRE o overlay
    if (chapeuFinal) {
      // Barra colorizada (já está no overlay, mas vamos sobrepor com cor correta)
      ctx.fillStyle = barColor;
      // Definir fonte antes de medir
      ctx.font = 'bold 30px "Poppins", Arial, sans-serif';
      const chapeuTexto = decodeHtmlEntitiesAll(chapeuFinal);
      const metrics = ctx.measureText(chapeuTexto);
      const barWidth = Math.max(Math.ceil(metrics.width + 32), 160); // padding 16px de cada lado
      ctx.fillRect(barX, barY, barWidth, barHeight);

      // Texto do chapéu com POPPINS
      ctx.fillStyle = 'white';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const textX = barX + (barWidth / 2);
      ctx.fillText(chapeuTexto, textX, barY + (barHeight / 2));
      
      console.log(`✅ Chapéu "${chapeuTexto}" renderizado com Poppins sobre overlay`);
    }

    // Título com destaque e POPPINS - renderizar SOBRE o overlay
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    
    lines.forEach((line, lineIndex) => {
      const y = titleStartY + (lineIndex * 85);
      let currentX = titleMarginLeft;
      
      line.forEach((wordObj, wordIndex) => {
        // Configurar fonte POPPINS baseada no peso
        const fontWeight = wordObj.isBold ? '800' : '400';
        ctx.font = `${fontWeight} 76px "Poppins", Arial, sans-serif`;
        ctx.fillStyle = 'white';
        
        // Medir palavra para espaçamento
        const metrics = ctx.measureText(wordObj.text);
        
        // Desenhar palavra
  ctx.fillText((wordObj.text || '').normalize('NFC'), currentX, y);
        
        // Atualizar posição X para próxima palavra
        currentX += metrics.width;
        
        // Adicionar espaço se não for última palavra
        if (wordIndex < line.length - 1) {
          const spaceMetrics = ctx.measureText(' ');
          currentX += spaceMetrics.width;
        }
        
        console.log(`✅ Palavra "${wordObj.text}" renderizada com Poppins ${fontWeight} sobre overlay`);
      });
    });

    console.log('🎯 Canvas finalizado: Overlay PNG + Poppins! Convertendo para buffer...');
    
    // Converter Canvas final para buffer PNG
    const finalImage = canvas.toBuffer('image/png');

    console.log('✅ Card gerado com sucesso');
    return finalImage;
    
  } catch (error) {
    console.error('❌ Erro ao gerar card:', error);
    throw error;
  }
}

// 🆕 LAYOUT 2 - CHAPÉU COM BARRAS DINÂMICAS (baseado no mockup oficial)
async function generateInstagramCardLayout2(data) {
  const { title, imagePath, categoria, chapeu, destaquePersonalizado, type = 'card' } = data;
  
  console.log('🎨 Gerando card Layout 2 - Barras dinâmicas...');
  
  // Usar chapéu fornecido como parâmetro ou gerar automaticamente se não fornecido
  const chapeuFinal = chapeu || await generateChapeu(title);
  console.log(`🏷️ Layout 2 - Usando chapéu: "${chapeuFinal}"`);
  
  try {
    // Dimensões do card Instagram
    const dimensions = { width: 1080, height: 1350 };
    
    // Cores por editoria
    const editorialColors = {
      'polícia': '#dc2626',          // 🔴 POLÍCIA: Vermelho
      'política': '#2563eb',         // 🔵 POLÍTICA: Azul
      'esporte': '#16a34a',          // 🟢 ESPORTE: Verde
      'entretenimento': '#9333ea',   // 🟣 ENTRETENIMENTO: Roxo
      'geral': '#ea580c',            // 🟠 GERAL: Laranja
    };
    const barColor = editorialColors[categoria?.toLowerCase()] || editorialColors['geral'];
    
    // Processar imagem de fundo
    const imageBuffer = await fs.readFile(imagePath);
    
    // Criar base com gradiente similar ao mockup (mais sutil)
    const baseWithGradient = await sharp(imageBuffer)
      .resize(dimensions.width, dimensions.height, { fit: 'cover', position: 'center' })
      .composite([{
        input: Buffer.from(`
          <svg width="${dimensions.width}" height="${dimensions.height}">
            <defs>
              <linearGradient id="grad" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" style="stop-color:rgba(0,0,0,0.1);stop-opacity:1" />
                <stop offset="100%" style="stop-color:rgba(0,0,0,0.6);stop-opacity:1" />
              </linearGradient>
            </defs>
            <rect width="100%" height="100%" fill="url(#grad)"/>
          </svg>
        `),
        blend: 'multiply'
      }])
      .png()
      .toBuffer();
    
    // Criar Canvas para renderizar textos
    const canvas = createCanvas(dimensions.width, dimensions.height);
    const ctx = canvas.getContext('2d');
    
    // Carregar imagem base no Canvas
    const baseImage = await loadImage(baseWithGradient);
    ctx.drawImage(baseImage, 0, 0, dimensions.width, dimensions.height);
    
    // Configurações de posicionamento
    const margin = 60;
    const chapeuStartY = 80;
    const lineHeight = 85;
    
    // Processar chapéu - quebrar em linhas se necessário
    if (chapeuFinal) {
      const chapeuTexto = decodeHtmlEntitiesAll(chapeuFinal);
      const chapeuWords = chapeuTexto.split(' ');
      const chapeuLines = [];
      
      // Configurar fonte para medir
      ctx.font = 'bold 70px "Poppins", Arial, sans-serif';
      const maxWidth = dimensions.width - (margin * 2) - 40; // margem + padding da barra
      
      let currentLine = '';
      for (const word of chapeuWords) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        const metrics = ctx.measureText(testLine);
        
        if (metrics.width <= maxWidth) {
          currentLine = testLine;
        } else {
          if (currentLine) chapeuLines.push(currentLine);
          currentLine = word;
        }
      }
      if (currentLine) chapeuLines.push(currentLine);
      
      // Renderizar cada linha do chapéu com barra dinâmica
      chapeuLines.forEach((line, index) => {
        const y = chapeuStartY + (index * lineHeight);
        
        // Medir largura da linha
        const metrics = ctx.measureText(line);
        const barWidth = Math.ceil(metrics.width + 40); // 20px padding cada lado
        const barHeight = 75;
        
        // Desenhar barra vermelha dinâmica
        ctx.fillStyle = barColor;
        ctx.fillRect(margin, y - 10, barWidth, barHeight);
        
        // Desenhar texto do chapéu (Poppins Bold 70px)
        ctx.fillStyle = 'white';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(line, margin + 20, y + 5);
        
        console.log(`✅ Layout 2 - Chapéu "${line}" com barra ${barWidth}px`);
      });
      
      // Calcular posição do título
      const tituloStartY = chapeuStartY + (chapeuLines.length * lineHeight) + 40;
      
      // Processar título (Poppins Regular 70px)
      const tituloTexto = decodeHtmlEntitiesAll(title);
      const tituloWords = tituloTexto.split(' ');
      const tituloLines = [];
      
      // Configurar fonte do título
      ctx.font = '400 70px "Poppins", Arial, sans-serif';
      const maxTituloWidth = dimensions.width - (margin * 2);
      
      let currentTituloLine = '';
      for (const word of tituloWords) {
        const testLine = currentTituloLine ? `${currentTituloLine} ${word}` : word;
        const metrics = ctx.measureText(testLine);
        
        if (metrics.width <= maxTituloWidth) {
          currentTituloLine = testLine;
        } else {
          if (currentTituloLine) tituloLines.push(currentTituloLine);
          currentTituloLine = word;
        }
      }
      if (currentTituloLine) tituloLines.push(currentTituloLine);
      
      // Renderizar linhas do título
      ctx.fillStyle = 'white';
      tituloLines.forEach((line, index) => {
        const y = tituloStartY + (index * 85);
        ctx.fillText(line, margin, y);
        console.log(`✅ Layout 2 - Título "${line}"`);
      });
    }
    
    console.log('🎯 Layout 2 finalizado com barras dinâmicas!');
    
    // Converter Canvas final para buffer PNG
    const finalImage = canvas.toBuffer('image/png');
    
    console.log('✅ Card Layout 2 gerado com sucesso');
    return finalImage;
    
  } catch (error) {
    console.error('❌ Erro ao gerar card Layout 2:', error);
    throw error;
  }
}

// Helper: carrega a publi padrão do repositório (fixa) e garante PNG 1080x1350
async function getDefaultPublicityPngBuffer() {
  try {
    // Ordem de fallback: public/publicity-default.jpg -> public/logo-r10-piaui.png
    let defaultPath = path.join(__dirname, 'public', 'publicity-default.jpg');
    if (!await fs.pathExists(defaultPath)) {
      defaultPath = path.join(__dirname, 'public', 'logo-r10-piaui.png');
      if (!await fs.pathExists(defaultPath)) return null;
    }
    const buf = await fs.readFile(defaultPath);
    const png = await sharp(buf)
      .resize(1080, 1350, { fit: 'cover', position: 'center' })
      .png()
      .toBuffer();
    return png;
  } catch (e) {
    console.log('⚠️ Falha ao carregar/normalizar publi padrão:', e.message);
    return null;
  }
}

// Helper: carrega a publi persistida (uploads/publicity-card.jpg) e garante PNG 1080x1350; senão, usa a padrão
async function getPersistentPublicityPngBuffer() {
  try {
  const persistDir = process.env.PERSIST_DIR || path.join(__dirname, 'uploads');
  const publicityJpgPath = path.join(persistDir, 'publicity-card.jpg');
    if (await fs.pathExists(publicityJpgPath)) {
      const buf = await fs.readFile(publicityJpgPath);
      const png = await sharp(buf)
        .resize(1080, 1350, { fit: 'cover', position: 'center' })
        .png()
        .toBuffer();
      return png;
    }
    // Sem persistida: usar a padrão fixa do repositório
    return await getDefaultPublicityPngBuffer();
  } catch (e) {
    console.log('⚠️ Falha ao carregar/normalizar publi persistida/padrão:', e.message);
    return null;
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
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
  <div class="container">
            <div class="header">
                <div class="logo">🔴 R10 PIAUÍ</div>
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
        <small style="color:#666; display:block;">A legenda sempre usa o título completo acima.</small>
        <small style="color:#666; display:block;">Se você editar o título manualmente, será usado "sem IA" no card.</small>
      </div>

            <div class="form-group">
                <label for="customChapeu">Chapéu Personalizado (Opcional)</label>
                <input type="text" id="customChapeu" name="customChapeu" placeholder="Ex: DESTAQUE, URGENTE, EXCLUSIVO..." maxlength="15">
                <small style="color: #666; margin-top: 5px; display: block;">Se não preenchido, será gerado automaticamente pela IA</small>
            </div>

            <div class="form-group">
                <label for="layoutType">Tipo de Layout</label>
                <select id="layoutType" name="layoutType">
                    <option value="1">Layout 1 - Destaques em Negrito (Original)</option>
                    <option value="2">Layout 2 - Chapéu com Barras Dinâmicas</option>
                </select>
                <small style="color: #666; margin-top: 5px; display: block;">Layout 1: palavras em negrito | Layout 2: barras que acompanham cada linha do chapéu</small>
            </div>

            <div class="form-group">
                <label for="highlightText">Texto em Destaque (Opcional)</label>
                <input type="text" id="highlightText" name="highlightText" placeholder="Palavras específicas para destacar em negrito...">
                <small style="color: #666; margin-top: 5px; display: block;">Se não preenchido, a IA escolherá automaticamente as palavras-chave</small>
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

        <div class="result" id="result"></div>
  </div>
    </div>

    <div class="preview" id="preview" style="max-width: 800px; margin: 20px auto;">
        <h3>Preview do Card Final</h3>
  <img id="previewImage" src="" alt="Preview">
  <pre id="previewCaption" style="margin-top: 15px; text-align: left; background: #f8f9fa; padding: 15px; border-radius: 5px; white-space: pre-wrap; word-wrap: break-word;"></pre>
    </div>

    <script>
  let currentCardData = null;
  let extractedImageUrl = null;
  let lastExtractedTitle = '';

        // 🎯 CONTADOR DINÂMICO DE PALAVRAS PARA DESTAQUE PERSONALIZADO
        function atualizarContadorPalavras() {
            const titleField = document.getElementById('title');
            const highlightField = document.getElementById('highlightText');
            if (!titleField || !highlightField) return;
            
            const title = titleField.value.trim();
            const words = title.split(/\s+/).filter(w => w.length > 0);
            const totalWords = words.length;
            
      // Atualizar contador de caracteres no próprio label abaixo do field
      const counterId = 'titleCounterInfo';
      let counterEl = document.getElementById(counterId);
      if (!counterEl) {
        counterEl = document.createElement('small');
        counterEl.id = counterId;
        counterEl.style.display = 'block';
        counterEl.style.marginTop = '6px';
        counterEl.style.fontWeight = 'bold';
        titleField.parentElement.appendChild(counterEl);
      }
  const charCount = title.length;
  const maxChars = 70;
  const colorClass = charCount > maxChars ? '#dc3545' : charCount > 60 ? '#f39c12' : '#28a745';
  counterEl.style.color = colorClass;
  counterEl.textContent = charCount + '/' + maxChars + ' caracteres';
            
            // Atualizar placeholder com contador dinâmico
            if (totalWords > 0) {
                highlightField.placeholder = "Ex: palavras específicas (título tem " + totalWords + " palavra" + (totalWords !== 1 ? "s" : "") + ")";
                
                // Preview das palavras numeradas
                const wordsPreview = words.map((word, index) => (index + 1) + ":" + word).join(" | ");
                
                // Atualizar small text com preview
                let smallElement = highlightField.nextElementSibling;
                if (smallElement && smallElement.tagName === 'SMALL') {
                    smallElement.innerHTML = "<strong>Palavras disponíveis:</strong> " + (wordsPreview.length > 100 ? wordsPreview.substring(0, 100) + "..." : wordsPreview);
                    smallElement.style.color = '#2c3e50';
                    smallElement.style.fontSize = '12px';
                    smallElement.style.background = '#ecf0f1';
                    smallElement.style.padding = '8px';
                    smallElement.style.borderRadius = '4px';
                    smallElement.style.marginTop = '8px';
                }
            } else {
                highlightField.placeholder = 'Primeiro digite o título acima para ver as palavras disponíveis';
                let smallElement = highlightField.nextElementSibling;
                if (smallElement && smallElement.tagName === 'SMALL') {
                    smallElement.innerHTML = 'Se não preenchido, a IA escolherá automaticamente as palavras-chave';
                    smallElement.style.color = '#666';
                    smallElement.style.background = 'transparent';
                    smallElement.style.padding = '0';
                }
            }
        }

        // Adicionar listeners quando a página carregar
        document.addEventListener('DOMContentLoaded', function() {
            const titleField = document.getElementById('title');
            if (titleField) {
                titleField.addEventListener('input', atualizarContadorPalavras);
                titleField.addEventListener('paste', () => setTimeout(atualizarContadorPalavras, 100));
                atualizarContadorPalavras(); // Atualizar no carregamento
            }
        });

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
                    document.getElementById('url').value = data.originalUrl;
                    atualizarContadorPalavras(); // Atualizar preview do título
                    
                    // Armazenar URL da imagem extraída
                    extractedImageUrl = data.imageUrl;
                    lastExtractedTitle = (data.title || '').trim();
                    
                    // Mostrar resultado
                    let message = '✅ Dados extraídos com sucesso!<br>';
                    message += '<strong>Título:</strong> ' + data.title.substring(0, 100);
                    if (data.title.length > 100) message += '...';
                    message += '<br>';
                    if (data.imageUrl) {
                        message += '<strong>Imagem:</strong> Encontrada e armazenada automaticamente<br>';
                    } else {
                        message += '<strong>Imagem:</strong> ⚠️ Não encontrada - será necessário subir manualmente<br>';
                    }
                    message += '<br>Agora confira o contador abaixo do título e clique em "🎨 Gerar Preview"!';
                    
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
            if (extractedImageUrl) {
                formData.append('extractedImageUrl', extractedImageUrl);
            }
            
      // Inferir "sem IA": se o título foi alterado manualmente após a extração, usamos o título como está no card
      const currentTitle = (document.getElementById('title').value || '').trim();
      // Inferência: só ativa manual se houver título extraído previamente e ele for diferente do atual (ignorando espaços duplicados)
      const norm = (s) => s.replace(/\s+/g, ' ').trim();
      if (lastExtractedTitle && norm(lastExtractedTitle) !== norm(currentTitle) && !formData.get('useManualTitle')) {
        formData.append('useManualTitle', '1');
      }
            
            if (!formData.get('title')) {
                showResult('❌ Preencha o título da matéria', true);
                return;
            }

            if (!extractedImageUrl) {
                showResult('❌ Extraia dados de uma URL primeiro para obter a imagem', true);
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
                    const captionEl = document.getElementById('previewCaption');
                    captionEl.textContent = 'Legenda:\n\n' + result.caption;
                    document.getElementById('preview').style.display = 'block';
                    showResult('✅ Card gerado com sucesso! Confira o preview acima.');
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

  try {
    const { url, categoria, chapeuPersonalizado, destaquePersonalizado, layoutType } = req.body;

    if (!url) {
      return res.json({
        success: false,
        error: 'URL é obrigatória'
      });
    }

    if (!categoria) {
      return res.json({
        success: false,
        error: 'Categoria é obrigatória'
      });
    }

    // Validar URL
    try {
      new URL(url);
    } catch {
      return res.json({ success: false, error: 'URL inválida' });
    }

    console.log(`🔍 Extraindo dados iniciais de: ${url}`);
    const extracted = await extractDataFromUrl(url);

    if (!extracted || !extracted.title) {
      return res.json({ success: false, error: 'Não foi possível extrair o título da página' });
    }

    if (!extracted.imageUrl) {
      return res.json({ success: false, error: 'Não foi possível localizar a imagem principal da notícia' });
    }

    const originalTitle = extracted.title;

    // Decodificar entidades HTML no título para uso na legenda
    function decodeHtmlEntitiesGlobal(text) {
      const entities = {
        '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ',
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
  const optimizedTitle = await optimizeTitle(originalTitle);
    // Usar chapéu personalizado ou gerar automaticamente (sempre em CAIXA ALTA)
    const chapeu = (chapeuPersonalizado ? chapeuPersonalizado.toUpperCase() : null) || await generateChapeu(optimizedTitle);
    console.log(`🏷️ Chapéu definido: "${chapeu}" ${chapeuPersonalizado ? '(personalizado)' : '(automático)'}`);
  // Legenda deve usar o TÍTULO COMPLETO DECODIFICADO (sem entidades HTML)
  const caption = await generateCaption(decodedTitle, chapeu, extracted.description || '');

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
      // Gerar o card baseado no layout selecionado
      let cardBuffer;
      console.log('🎨 Verificando layout (process-url):', layoutType, '- Tipo:', typeof layoutType);
      if (layoutType === 'layout2') {
        console.log('✅ Usando LAYOUT 2 (Barras Dinâmicas) - process-url');
        cardBuffer = await generateInstagramCardLayout2({
          title: optimizedTitle,
          categoria,
          imagePath: tempImagePath,
          chapeu,
          destaquePersonalizado,
          type: 'card'
        });
      } else {
        console.log('📄 Usando LAYOUT 1 (Padrão) - process-url');
        // Gerar o card usando o layout original
        cardBuffer = await generateInstagramCard({
          title: optimizedTitle,
          categoria,
          imagePath: tempImagePath,
          chapeu,
          destaquePersonalizado,
          type: 'card'
        });
      }

      // Limpar arquivo temporário
      try { await fs.unlink(tempImagePath); } catch {}

      return res.json({
        success: true,
        cardImage: cardBuffer.toString('base64'),
        caption,
        title: optimizedTitle,
        originalTitle: decodedTitle, // CORREÇÃO: Enviar título original para edição manual
        categoria,
        url,
        extractedImageUrl: extracted.imageUrl,
        chapeu,
        publicityAvailable: await fs.pathExists(path.join(__dirname, 'uploads', 'publicity-card.jpg'))
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
    const { title, category, url, extractedImageUrl, chapeuPersonalizado, layoutType } = req.body;
    let { destaquePersonalizado } = req.body;
    
    console.log('🎨 Layout selecionado:', layoutType);
    
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
      optimizedTitle = finalizeHeadline(title, 65);
    } else {
      optimizedTitle = await optimizeTitle(title, undefined);
    }
    
    // Gerar chapéu complementar - usar personalizado se fornecido (sempre em CAIXA ALTA)
    // CORREÇÃO: Quando título é manual, usar título manual para gerar chapéu também
    const tituloParaChapeu = useManualTitle ? title : optimizedTitle;
    const chapeu = (chapeuPersonalizado ? chapeuPersonalizado.toUpperCase() : null) || await generateChapeu(tituloParaChapeu);
    console.log(`🏷️ Chapéu definido: "${chapeu}" ${chapeuPersonalizado ? '(personalizado)' : '(automático)'}`);
    
  // Decodificar entidades HTML no título para legenda
  function decodeHtmlEntitiesUpload(text) {
    const entities = {
      '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ',
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
  const caption = await generateCaption(titleDecodificado, chapeu);
    
    // Gerar card baseado no layout selecionado
    let cardBuffer;
    console.log('🎨 Verificando layout:', layoutType, '- Tipo:', typeof layoutType);
    if (layoutType === 'layout2') {
      console.log('✅ Usando LAYOUT 2 (Barras Dinâmicas)');
      cardBuffer = await generateInstagramCardLayout2({
        title: optimizedTitle,
        categoria: category,
        imagePath,
        chapeu,
        destaquePersonalizado,
        type: 'card'
      });
    } else {
      console.log('📄 Usando LAYOUT 1 (Padrão)');
      // Layout padrão (Layout 1)
      cardBuffer = await generateInstagramCard({
        title: optimizedTitle,
        categoria: category,
        imagePath,
        chapeu,
        destaquePersonalizado,
        type: 'card'
      });
    }

    // Remover arquivo de upload/download temporário
    try {
      await fs.unlink(imagePath);
    } catch (err) {
      console.log('⚠️ Arquivo temporário já foi removido ou não existe');
    }

    const hasPersisted = await fs.pathExists(path.join(__dirname, 'uploads', 'publicity-card.jpg'));
    res.json({
      success: true,
      cardImage: cardBuffer.toString('base64'),
      caption,
      title: optimizedTitle,
      categoria: category,
      url,
      // Disponibilidade considerada apenas quando houver publi SALVA (persistida)
      publicityAvailable: hasPersisted
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

  // Redimensionar para 1080x1350 e salvar (usar diretório persistente se configurado)
  const persistDir = process.env.PERSIST_DIR || path.join(__dirname, 'uploads');
  const publicityPath = path.join(persistDir, 'publicity-card.jpg');
    const processed = await sharp(req.file.path)
      .resize(1080, 1350, { fit: 'cover', position: 'center' })
      .jpeg({ quality: 92 })
      .toBuffer();
    await fs.ensureDir(path.dirname(publicityPath));
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

// API para buscar a imagem publicitária salva
app.get('/api/get-publicity', async (req, res) => {
  try {
    const persistDir = process.env.PERSIST_DIR || path.join(__dirname, 'uploads');
    const publicityPath = path.join(persistDir, 'publicity-card.jpg');
    const hasPersisted = await fs.pathExists(path.join(persistDir, 'publicity-card.jpg'));
    if (await fs.pathExists(publicityPath)) {
      const imageBuffer = await fs.readFile(publicityPath);
  return res.json({ success: true, publicityImage: imageBuffer.toString('base64'), source: 'persisted' });
    }
    // Sem persistida: tentar padrão fixa
    const defaultPng = await getDefaultPublicityPngBuffer();
    if (defaultPng) {
  return res.json({ success: true, publicityImage: defaultPng.toString('base64'), source: 'default' });
    }
    return res.json({ success: false, error: 'Nenhum card publicitário encontrado' });
  } catch (error) {
    res.json({ success: false, error: error.message });
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
    const { newsCard, publicityCard, caption } = req.body;

    if (!newsCard || !caption) {
      return res.json({ 
        success: false, 
        error: 'Card da notícia e legenda são obrigatórios' 
      });
    }

    // Converter base64 do card da notícia
    const newsBuffer = Buffer.from(newsCard, 'base64');

    // Definir publi: aceitar somente quando FORNECIDA no payload ou quando HOUVER PUBLI SALVA (persistida).
    // Não usaremos a imagem padrão para publicar carrossel; se não houver salva, publica SINGLE.
    let publicityBuffer = null;
    if (publicityCard) {
      publicityBuffer = Buffer.from(publicityCard, 'base64');
    } else {
      const persistedPath = path.join(__dirname, 'uploads', 'publicity-card.jpg');
      if (await fs.pathExists(persistedPath)) {
        const buf = await fs.readFile(persistedPath);
        publicityBuffer = await sharp(buf).resize(1080, 1350, { fit: 'cover', position: 'center' }).png().toBuffer();
      }
    }

    if (!publicityBuffer) {
      // Sem publi salva: publicar SINGLE com o card da notícia
      const single = await publishToInstagram(newsBuffer, caption);
      return res.json({ success: true, postId: single.postId, mediaId: single.mediaId, mode: 'single' });
    }

    // Com publi salva: publicar carrossel
    const result = await publishCarouselToInstagram([newsBuffer, publicityBuffer], caption);

    res.json({
      success: true,
      postId: result.postId,
      carouselId: result.carouselId,
      mediaIds: result.mediaIds,
      mode: 'carousel'
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
    
    // Publicar no Instagram
    const result = await publishToInstagram(imageBuffer, caption);

    res.json({
      success: true,
      postId: result.postId,
      mediaId: result.mediaId
    });

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
  if (!GROQ_CONFIG.API_KEY) console.log('⚠️ Defina a variável de ambiente GROQ_API_KEY para habilitar IA.');
  if (!INSTAGRAM_CONFIG.ACCESS_TOKEN) console.log('⚠️ Defina IG_ACCESS_TOKEN para publicar no Instagram.');
  if (!INSTAGRAM_CONFIG.PUBLIC_BASE_URL) console.log('⚠️ Defina PUBLIC_BASE_URL (ex.: https://seu-dominio.com) para permitir a publicação (image_url exigido pela Meta).');
});

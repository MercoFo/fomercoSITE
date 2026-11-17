// Conexão com o banco de dados.
// Localmente usa um arquivo SQLite (data/fomerco.db).
// Em produção, defina DATABASE_URL (libsql://...) e DATABASE_AUTH_TOKEN para usar o Turso.
import { createClient } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';

const url = process.env.DATABASE_URL || 'file:data/fomerco.db';
if (url.startsWith('file:')) {
  const dir = path.dirname(url.slice('file:'.length));
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
}

export const db = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN || undefined });

export async function all(sql, args = []) {
  const r = await db.execute({ sql, args });
  return r.rows.map((row) => ({ ...row }));
}
export async function one(sql, args = []) {
  const rows = await all(sql, args);
  return rows[0] || null;
}
export async function run(sql, args = []) {
  return db.execute({ sql, args });
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario TEXT NOT NULL UNIQUE COLLATE NOCASE,
    senha_hash TEXT NOT NULL,
    papel TEXT NOT NULL DEFAULT 'editor' CHECK (papel IN ('admin','editor')),
    trocar_senha INTEGER NOT NULL DEFAULT 1,
    criado_em TEXT NOT NULL DEFAULT (datetime('now')),
    ultimo_acesso TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sessoes (
    token_hash TEXT PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    expira_em INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tentativas_login (
    chave TEXT PRIMARY KEY,
    falhas INTEGER NOT NULL DEFAULT 0,
    inicio INTEGER NOT NULL,
    bloqueado_ate INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS configuracoes (
    chave TEXT PRIMARY KEY,
    valor TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS paginas (
    chave TEXT PRIMARY KEY,
    titulo TEXT NOT NULL,
    corpo TEXT NOT NULL DEFAULT '',
    atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS publicacoes (
    slug TEXT PRIMARY KEY,
    titulo TEXT NOT NULL,
    descricao TEXT NOT NULL DEFAULT '',
    tipo TEXT NOT NULL DEFAULT 'tecnico-cientifica',
    periodicidade TEXT NOT NULL DEFAULT '',
    instituicao TEXT NOT NULL DEFAULT '',
    endereco TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    issn TEXT NOT NULL DEFAULT '',
    licenca TEXT NOT NULL DEFAULT 'CC BY 4.0',
    tem_trabalhos INTEGER NOT NULL DEFAULT 1,
    ordem INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS arquivos (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    tipo TEXT NOT NULL,
    tamanho INTEGER NOT NULL,
    completo INTEGER NOT NULL DEFAULT 0,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS arquivo_partes (
    arquivo_id TEXT NOT NULL REFERENCES arquivos(id) ON DELETE CASCADE,
    indice INTEGER NOT NULL,
    dados BLOB NOT NULL,
    PRIMARY KEY (arquivo_id, indice)
  )`,
  `CREATE TABLE IF NOT EXISTS numeros (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    publicacao TEXT NOT NULL REFERENCES publicacoes(slug),
    slug TEXT NOT NULL,
    volume INTEGER NOT NULL,
    numero INTEGER,
    ano INTEGER NOT NULL,
    titulo TEXT NOT NULL DEFAULT '',
    descricao TEXT NOT NULL DEFAULT '',
    data_publicacao TEXT NOT NULL DEFAULT '',
    pdf_id TEXT REFERENCES arquivos(id),
    capa_id TEXT REFERENCES arquivos(id),
    publicado INTEGER NOT NULL DEFAULT 0,
    criado_em TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (publicacao, slug)
  )`,
  `CREATE TABLE IF NOT EXISTS trabalhos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero_id INTEGER NOT NULL REFERENCES numeros(id) ON DELETE CASCADE,
    titulo TEXT NOT NULL,
    autores TEXT NOT NULL DEFAULT '',
    resumo TEXT NOT NULL DEFAULT '',
    palavras_chave TEXT NOT NULL DEFAULT '',
    secao TEXT NOT NULL DEFAULT '',
    paginas TEXT NOT NULL DEFAULT '',
    pdf_id TEXT REFERENCES arquivos(id),
    ordem INTEGER NOT NULL DEFAULT 0,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS anexos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero_id INTEGER NOT NULL REFERENCES numeros(id) ON DELETE CASCADE,
    rotulo TEXT NOT NULL,
    arquivo_id TEXT NOT NULL REFERENCES arquivos(id),
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
];

const PUBLICACOES = [
  {
    slug: 'anais', titulo: 'Anais do FoMerco', tipo: 'tecnico-cientifica', tem_trabalhos: 1, ordem: 1,
    descricao: 'Trabalhos apresentados nos encontros bienais do FoMerco.',
    periodicidade: 'Bienal',
  },
  {
    slug: 'carta', titulo: 'Carta FoMerco', tipo: 'divulgacao', tem_trabalhos: 0, ordem: 2,
    descricao: 'Publicação mensal de análise e divulgação sobre integração regional.',
    periodicidade: 'Mensal',
  },
];

const PAGINAS = [
  ['sobre', 'Sobre o FoMerco', 'Escreva aqui a apresentação do FoMerco: a história da rede, seus objetivos e quem participa.\n\n## Contato\n\nInforme e-mail e endereço para contato.'],
  ['anais-apresentacao', 'Apresentação', 'Os **Anais do FoMerco** reúnem os trabalhos apresentados nos encontros bienais do FoMerco, dedicados à integração regional com foco no Mercosul.\n\nDescreva aqui o escopo da publicação, as áreas temáticas e o público.'],
  ['anais-expediente', 'Expediente', '## Corpo editorial\n\n- Nome completo (instituição) — função\n- Nome completo (instituição) — função'],
  ['anais-normas', 'Normas para publicação', 'Descreva aqui as diretrizes para os autores: formato dos trabalhos, extensão, normas de citação, idiomas aceitos e como submeter.'],
  ['carta-apresentacao', 'Apresentação', 'A **Carta FoMerco** é uma publicação mensal de divulgação sobre integração regional e Mercosul.\n\nDescreva aqui a proposta da Carta e o público.'],
  ['carta-expediente', 'Expediente', '## Corpo editorial\n\n- Nome completo (instituição) — função\n- Nome completo (instituição) — função'],
  ['carta-normas', 'Normas para publicação', ''],
];

const CONFIG = {
  hero_titulo: 'Pesquisa e debate sobre integração regional',
  hero_texto: 'O FoMerco é uma rede de pesquisadoras e pesquisadores dedicada à integração regional, com foco no Mercosul. A cada dois anos, a rede organiza um encontro acadêmico e mantém duas publicações de acesso aberto.',
  contato_email: '',
  contato_endereco: '',
  evento_ativo: '1',
  evento_nome: 'XXI FoMerco',
  evento_tema: 'Tema do encontro',
  evento_datas: 'Datas a definir',
  evento_local: 'Local a definir',
  evento_texto: 'Inscrições, submissão de trabalhos e programação completa estão no site do evento.',
  evento_link: 'https://www.even3.com.br/',
  evento_botao: 'Ir para o site do evento',
  evento_imagem_id: '',
};

export async function migrar() {
  try { await db.execute('PRAGMA foreign_keys = ON'); } catch { /* alguns provedores não aceitam PRAGMA */ }
  for (const sql of SCHEMA) await db.execute(sql);
  await db.execute('CREATE INDEX IF NOT EXISTS idx_numeros_pub ON numeros(publicacao, publicado)');
  await db.execute('CREATE INDEX IF NOT EXISTS idx_trabalhos_num ON trabalhos(numero_id, ordem)');
  for (const p of PUBLICACOES) {
    await run(
      `INSERT OR IGNORE INTO publicacoes (slug, titulo, descricao, tipo, periodicidade, tem_trabalhos, ordem)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [p.slug, p.titulo, p.descricao, p.tipo, p.periodicidade, p.tem_trabalhos, p.ordem],
    );
  }
  for (const [chave, titulo, corpo] of PAGINAS) {
    await run('INSERT OR IGNORE INTO paginas (chave, titulo, corpo) VALUES (?, ?, ?)', [chave, titulo, corpo]);
  }
  for (const [chave, valor] of Object.entries(CONFIG)) {
    await run('INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES (?, ?)', [chave, valor]);
  }
}

export async function config() {
  const rows = await all('SELECT chave, valor FROM configuracoes');
  return Object.fromEntries(rows.map((r) => [r.chave, r.valor]));
}

export async function salvarConfig(pares) {
  for (const [chave, valor] of Object.entries(pares)) {
    await run(
      'INSERT INTO configuracoes (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor',
      [chave, valor ?? ''],
    );
  }
}

// Funções de apoio: texto formatado, numeração Vol./No. e consultas das publicações.
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { all, one } from './db.js';
import { urlArquivo } from './arquivos.js';

marked.setOptions({ gfm: true, breaks: true });

export function md(texto) {
  const html = marked.parse(String(texto || ''));
  return sanitizeHtml(html, {
    allowedTags: ['h2', 'h3', 'h4', 'p', 'br', 'strong', 'em', 'a', 'ul', 'ol', 'li', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'code'],
    allowedAttributes: { a: ['href', 'title', 'rel', 'target'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      h1: 'h2',
      a: (tag, attribs) => {
        const limpo = { href: attribs.href, ...(attribs.title ? { title: attribs.title } : {}) };
        const externo = /^https?:/i.test(attribs.href || '');
        return { tagName: 'a', attribs: externo ? { ...limpo, rel: 'noopener', target: '_blank' } : limpo };
      },
    },
  });
}

// "Vol. 3, No. 1 (2026)" ou "Vol. 3 (2026)" — nunca "edição"
export function designacao(n) {
  if (!n) return '';
  return `Vol. ${n.volume}${n.numero != null && n.numero !== '' ? `, No. ${n.numero}` : ''} (${n.ano})`;
}

export function slugNumero(volume, numero, ano) {
  return `vol-${volume}${numero != null && numero !== '' ? `-no-${numero}` : ''}-${ano}`;
}

export function listaAutores(texto) {
  return String(texto || '').split(/\n|;/).map((s) => s.trim()).filter(Boolean);
}

export function formatarData(iso) {
  if (!iso) return '';
  const [a, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!a || !m) return '';
  const meses = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  return d ? `${d} de ${meses[m - 1]} de ${a}` : `${meses[m - 1]} de ${a}`;
}

export function tamanhoLegivel(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

const ORDEM = 'ORDER BY n.ano DESC, n.volume DESC, COALESCE(n.numero, 0) DESC, n.id DESC';

export async function publicacoes() {
  return all('SELECT * FROM publicacoes ORDER BY ordem');
}

export async function publicacao(slug) {
  return one('SELECT * FROM publicacoes WHERE slug = ?', [slug]);
}

async function enriquecer(numeros) {
  for (const n of numeros) {
    n.designacao = designacao(n);
    n.pdf_url = urlArquivo(n.pdf_id, n.pdf_nome);
    n.capa_url = urlArquivo(n.capa_id, n.capa_nome);
  }
  return numeros;
}

const SELECT_NUMERO = `SELECT n.*, a.nome AS pdf_nome, a.tamanho AS pdf_tamanho, c.nome AS capa_nome,
  (SELECT COUNT(*) FROM trabalhos t WHERE t.numero_id = n.id) AS total_trabalhos
  FROM numeros n LEFT JOIN arquivos a ON a.id = n.pdf_id LEFT JOIN arquivos c ON c.id = n.capa_id`;

export async function numerosPublicados(pub, limite = 500) {
  return enriquecer(await all(`${SELECT_NUMERO} WHERE n.publicacao = ? AND n.publicado = 1 ${ORDEM} LIMIT ?`, [pub, limite]));
}

export async function todosNumeros(pub) {
  return enriquecer(await all(`${SELECT_NUMERO} WHERE n.publicacao = ? ${ORDEM}`, [pub]));
}

export async function numeroPorSlug(pub, slug, incluirRascunho = false) {
  const n = await one(`${SELECT_NUMERO} WHERE n.publicacao = ? AND n.slug = ? ${incluirRascunho ? '' : 'AND n.publicado = 1'}`, [pub, slug]);
  return n ? (await enriquecer([n]))[0] : null;
}

export async function numeroPorId(id) {
  const n = await one(`${SELECT_NUMERO} WHERE n.id = ?`, [id]);
  return n ? (await enriquecer([n]))[0] : null;
}

export async function trabalhosDoNumero(numeroId) {
  const ts = await all(
    `SELECT t.*, a.nome AS pdf_nome, a.tamanho AS pdf_tamanho FROM trabalhos t
     LEFT JOIN arquivos a ON a.id = t.pdf_id WHERE t.numero_id = ? ORDER BY t.secao, t.ordem, t.id`,
    [numeroId],
  );
  for (const t of ts) { t.pdf_url = urlArquivo(t.pdf_id, t.pdf_nome); t.autores_lista = listaAutores(t.autores); }
  return ts;
}

export async function anexosDoNumero(numeroId) {
  const xs = await all(
    `SELECT x.*, a.nome, a.tamanho FROM anexos x JOIN arquivos a ON a.id = x.arquivo_id WHERE x.numero_id = ? ORDER BY x.id`,
    [numeroId],
  );
  for (const x of xs) x.url = urlArquivo(x.arquivo_id, x.nome);
  return xs;
}

export async function pagina(chave) {
  return one('SELECT * FROM paginas WHERE chave = ?', [chave]);
}

import { Router } from 'express';
import { one } from '../db.js';
import { urlArquivo } from '../arquivos.js';
import {
  publicacoes, publicacao, numerosPublicados, numeroPorSlug, trabalhosDoNumero, anexosDoNumero, pagina,
} from '../conteudo.js';

const r = Router();

async function imagemEvento(cfg) {
  if (cfg.evento_imagem_id) {
    const a = await one('SELECT id, nome FROM arquivos WHERE id = ? AND completo = 1', [cfg.evento_imagem_id]);
    if (a) return urlArquivo(a.id, a.nome);
  }
  return '/static/img/evento-xxi.jpg';
}

r.get('/', async (req, res) => {
  const cfg = res.locals.cfg;
  const pubs = await publicacoes();
  for (const p of pubs) {
    const ns = await numerosPublicados(p.slug, 4);
    p.atual = ns[0] || null;
    p.recentes = ns.slice(1);
  }
  res.render('inicio', { titulo: null, pubs, eventoImagem: await imagemEvento(cfg) });
});

r.get('/sobre', async (req, res) => {
  res.render('pagina', { titulo: 'Sobre o FoMerco', pag: await pagina('sobre'), secao: 'sobre' });
});

// ---------- publicações ----------
async function carregarPub(req, res, next) {
  const pub = await publicacao(req.params.pub);
  if (!pub) return next('route');
  const normas = await pagina(`${pub.slug}-normas`);
  pub.temNormas = pub.tipo === 'tecnico-cientifica' || !!normas?.corpo?.trim();
  const ns = await numerosPublicados(pub.slug, 1);
  pub.atual = ns[0] || null;
  res.locals.pub = pub;
  next();
}

r.get('/:pub', carregarPub, async (req, res) => {
  const { pub } = res.locals;
  const numeros = await numerosPublicados(pub.slug, 6);
  res.render('pub-inicio', {
    titulo: pub.titulo, secao: pub.slug, aba: 'inicio',
    apresentacao: await pagina(`${pub.slug}-apresentacao`), anteriores: numeros.slice(1),
  });
});

for (const [rota, aba] of [['apresentacao', 'apresentacao'], ['expediente', 'expediente'], ['normas', 'normas']]) {
  r.get(`/:pub/${rota}`, carregarPub, async (req, res, next) => {
    const { pub } = res.locals;
    if (aba === 'normas' && !pub.temNormas) return next('route');
    const pag = await pagina(`${pub.slug}-${aba}`);
    res.render('pub-pagina', { titulo: `${pag.titulo} · ${pub.titulo}`, secao: pub.slug, aba, pag });
  });
}

r.get('/:pub/atual', carregarPub, (req, res) => {
  const { pub } = res.locals;
  if (!pub.atual) return res.redirect(`/${pub.slug}/numeros`);
  res.redirect(`/${pub.slug}/${pub.atual.slug}`);
});

r.get('/:pub/numeros', carregarPub, async (req, res) => {
  const { pub } = res.locals;
  const numeros = await numerosPublicados(pub.slug);
  res.render('pub-numeros', { titulo: `Números · ${pub.titulo}`, secao: pub.slug, aba: 'numeros', atual: numeros[0], anteriores: numeros.slice(1) });
});

r.get('/:pub/trabalho/:id', carregarPub, async (req, res, next) => {
  const { pub } = res.locals;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return next('route');
  const t = await one('SELECT t.*, a.nome AS pdf_nome, a.tamanho AS pdf_tamanho FROM trabalhos t LEFT JOIN arquivos a ON a.id = t.pdf_id WHERE t.id = ?', [id]);
  if (!t) return next('route');
  const numero = await one('SELECT slug FROM numeros WHERE id = ? AND publicacao = ? AND publicado = 1', [t.numero_id, pub.slug]);
  if (!numero) return next('route');
  const n = await numeroPorSlug(pub.slug, numero.slug);
  t.pdf_url = t.pdf_id ? urlArquivo(t.pdf_id, t.pdf_nome) : null;
  t.autores_lista = String(t.autores || '').split(/\n|;/).map((s) => s.trim()).filter(Boolean);
  res.render('trabalho', { titulo: t.titulo, secao: pub.slug, aba: n.id === pub.atual?.id ? 'atual' : 'numeros', t, n });
});

r.get('/:pub/:slug', carregarPub, async (req, res, next) => {
  const { pub } = res.locals;
  const n = await numeroPorSlug(pub.slug, req.params.slug);
  if (!n) return next('route');
  const trabalhos = await trabalhosDoNumero(n.id);
  const secoes = [];
  for (const t of trabalhos) {
    const ultima = secoes[secoes.length - 1];
    if (!ultima || ultima.nome !== t.secao) secoes.push({ nome: t.secao, itens: [t] });
    else ultima.itens.push(t);
  }
  res.render('numero', {
    titulo: `${n.designacao} · ${pub.titulo}`, secao: pub.slug, aba: n.id === pub.atual?.id ? 'atual' : 'numeros',
    n, secoes, anexos: await anexosDoNumero(n.id), ehAtual: n.id === pub.atual?.id,
  });
});

export default r;

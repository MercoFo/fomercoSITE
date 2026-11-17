import { Router } from 'express';
import multer from 'multer';
import { all, one, run, salvarConfig } from '../db.js';
import {
  tentarLogin, criarSessao, encerrarSessao, encerrarOutrasSessoes, exigirLogin, exigirAdmin,
  verificarOrigem, verificarCsrf, gerarHash, validarSenha, validarUsuario, senhaTemporaria,
} from '../auth.js';
import { salvarArquivo, apagarArquivo, ErroArquivo, urlArquivo } from '../arquivos.js';
import {
  publicacoes, publicacao, todosNumeros, numeroPorId, trabalhosDoNumero, anexosDoNumero, slugNumero,
} from '../conteudo.js';

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024, files: 4, fields: 60 } });

const s = (v, max = 20000) => String(v ?? '').trim().slice(0, max);
const inteiro = (v) => (/^\d{1,4}$/.test(String(v ?? '').trim()) ? Number(v) : null);

r.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.locals.msg = req.query.msg ? String(req.query.msg) : '';
  res.locals.caminho = req.baseUrl + req.path;
  next();
});
r.use(verificarOrigem);

// Recebe arquivos (se houver) e só depois confere o token do formulário.
const comArquivos = (campos) => [
  (req, res, next) => upload.fields(campos)(req, res, (err) => {
    if (err) {
      const mensagem = err.code === 'LIMIT_FILE_SIZE' ? 'Arquivo grande demais. O limite é 40 MB para PDFs e 5 MB para imagens.' : 'Não foi possível receber o arquivo.';
      return res.status(400).render('admin/erro', { titulo: 'Envio não concluído', mensagem });
    }
    next();
  }),
  verificarCsrf,
];
const arq = (req, campo) => req.files?.[campo]?.[0] || null;

// ---------- entrar / sair ----------
r.get('/entrar', (req, res) => {
  if (req.usuario) return res.redirect('/admin');
  res.render('admin/entrar', { erro: null, usuarioDigitado: '' });
});

r.post('/entrar', upload.none(), async (req, res) => {
  const { erro, usuario } = await tentarLogin(req.body.usuario, req.body.senha, req.ip);
  if (erro) return res.status(401).render('admin/entrar', { erro, usuarioDigitado: s(req.body.usuario, 60) });
  if (req.usuario) await encerrarSessao(req, res);
  await criarSessao(res, usuario.id);
  res.redirect(usuario.trocar_senha ? '/admin/conta?msg=trocar' : '/admin');
});

r.post('/sair', upload.none(), verificarCsrf, async (req, res) => {
  await encerrarSessao(req, res);
  res.redirect('/admin/entrar');
});

r.use(exigirLogin);

// ---------- painel ----------
r.get('/', async (req, res) => {
  const pubs = await publicacoes();
  for (const p of pubs) {
    p.numeros = await todosNumeros(p.slug);
    p.publicados = p.numeros.filter((n) => n.publicado).length;
  }
  res.render('admin/painel', { pubs, cfg: res.locals.cfg });
});

// ---------- páginas de texto ----------
r.get('/paginas', async (req, res) => {
  res.render('admin/paginas', { paginas: await all('SELECT chave, titulo, atualizado_em FROM paginas ORDER BY chave') });
});

r.get('/paginas/:chave', async (req, res, next) => {
  const pag = await one('SELECT * FROM paginas WHERE chave = ?', [req.params.chave]);
  if (!pag) return next();
  res.render('admin/pagina', { pag });
});

r.post('/paginas/:chave', upload.none(), verificarCsrf, async (req, res, next) => {
  const pag = await one('SELECT chave FROM paginas WHERE chave = ?', [req.params.chave]);
  if (!pag) return next();
  await run("UPDATE paginas SET corpo = ?, atualizado_em = datetime('now') WHERE chave = ?", [s(req.body.corpo, 100000), pag.chave]);
  res.redirect(`/admin/paginas/${pag.chave}?msg=salvo`);
});

// ---------- evento atual ----------
r.get('/evento', async (req, res) => {
  const cfg = res.locals.cfg;
  let imagem = '/static/img/evento-xxi.jpg';
  if (cfg.evento_imagem_id) {
    const a = await one('SELECT id, nome FROM arquivos WHERE id = ?', [cfg.evento_imagem_id]);
    if (a) imagem = urlArquivo(a.id, a.nome);
  }
  res.render('admin/evento', { cfg, imagem, erro: null });
});

r.post('/evento', comArquivos([{ name: 'imagem', maxCount: 1 }]), async (req, res) => {
  const cfg = res.locals.cfg;
  const link = s(req.body.evento_link, 500);
  if (link && !/^https:\/\//i.test(link)) {
    return res.status(400).render('admin/evento', { cfg: { ...cfg, ...req.body }, imagem: '/static/img/evento-xxi.jpg', erro: 'O link do evento precisa começar com https://' });
  }
  const pares = {
    evento_ativo: req.body.evento_ativo ? '1' : '0',
    evento_nome: s(req.body.evento_nome, 120), evento_tema: s(req.body.evento_tema, 300),
    evento_datas: s(req.body.evento_datas, 120), evento_local: s(req.body.evento_local, 200),
    evento_texto: s(req.body.evento_texto, 1200), evento_link: link, evento_botao: s(req.body.evento_botao, 60) || 'Ir para o site do evento',
  };
  try {
    const nova = await salvarArquivo(arq(req, 'imagem'), 'imagem');
    if (nova || req.body.remover_imagem) {
      await apagarArquivo(cfg.evento_imagem_id);
      pares.evento_imagem_id = nova || '';
    }
  } catch (e) {
    if (e instanceof ErroArquivo) return res.status(400).render('admin/evento', { cfg: { ...cfg, ...pares }, imagem: '/static/img/evento-xxi.jpg', erro: e.message });
    throw e;
  }
  await salvarConfig(pares);
  res.redirect('/admin/evento?msg=salvo');
});

// ---------- configurações gerais ----------
r.get('/configuracoes', (req, res) => res.render('admin/configuracoes', { cfg: res.locals.cfg }));

r.post('/configuracoes', upload.none(), verificarCsrf, async (req, res) => {
  await salvarConfig({
    hero_titulo: s(req.body.hero_titulo, 160), hero_texto: s(req.body.hero_texto, 1200),
    contato_email: s(req.body.contato_email, 200), contato_endereco: s(req.body.contato_endereco, 500),
  });
  res.redirect('/admin/configuracoes?msg=salvo');
});

// ---------- publicações ----------
async function carregarPub(req, res, next) {
  const pub = await publicacao(req.params.slug);
  if (!pub) return next('route');
  res.locals.pub = pub;
  next();
}

r.get('/pub/:slug', carregarPub, async (req, res) => {
  const { pub } = res.locals;
  const numeros = await todosNumeros(pub.slug);
  const publicados = numeros.filter((n) => n.publicado);
  const maxTrabalhos = Math.max(0, ...publicados.map((n) => n.total_trabalhos));
  const normas = await one('SELECT corpo FROM paginas WHERE chave = ?', [`${pub.slug}-normas`]);
  const checklist = [
    { ok: publicados.length >= 2, texto: `Pelo menos 2 números publicados com o mesmo título (agora: ${publicados.length})` },
    { ok: !!pub.instituicao && !!pub.endereco, texto: 'Instituição responsável e endereço completo preenchidos (aparecem no Expediente)' },
    { ok: !!pub.periodicidade, texto: 'Periodicidade informada' },
    { ok: !!pub.licenca, texto: 'Licença de acesso aberto informada' },
  ];
  if (pub.tipo === 'tecnico-cientifica') {
    checklist.push({ ok: maxTrabalhos >= 5, texto: `Um número completo com pelo menos 5 trabalhos (maior até agora: ${maxTrabalhos})` });
    checklist.push({ ok: !!normas?.corpo?.trim(), texto: 'Normas para publicação preenchidas' });
  }
  res.render('admin/publicacao', { numeros, checklist, erro: null });
});

r.post('/pub/:slug', carregarPub, upload.none(), verificarCsrf, async (req, res) => {
  const { pub } = res.locals;
  await run(
    `UPDATE publicacoes SET titulo = ?, descricao = ?, periodicidade = ?, instituicao = ?, endereco = ?, email = ?, issn = ?, licenca = ? WHERE slug = ?`,
    [s(req.body.titulo, 160) || pub.titulo, s(req.body.descricao, 500), s(req.body.periodicidade, 60), s(req.body.instituicao, 300),
      s(req.body.endereco, 500), s(req.body.email, 200), s(req.body.issn, 20), s(req.body.licenca, 120), pub.slug],
  );
  res.redirect(`/admin/pub/${pub.slug}?msg=salvo`);
});

// ---------- números ----------
function lerNumero(body) {
  const volume = inteiro(body.volume);
  const numero = s(body.numero) === '' ? null : inteiro(body.numero);
  const ano = inteiro(body.ano);
  const data = s(body.data_publicacao, 10);
  const erros = [];
  if (!volume || volume < 1) erros.push('Informe o volume (número inteiro, a partir de 1).');
  if (s(body.numero) !== '' && (numero == null || numero < 1)) erros.push('O número deve ser um inteiro a partir de 1, ou ficar em branco.');
  if (!ano || ano < 1990 || ano > 2100) erros.push('Informe o ano civil com 4 dígitos.');
  if (data && !/^\d{4}-\d{2}-\d{2}$/.test(data)) erros.push('A data de publicação está em formato inválido.');
  return {
    erros,
    dados: { volume, numero, ano, titulo: s(body.titulo, 300), descricao: s(body.descricao, 20000), data_publicacao: data, publicado: body.publicado ? 1 : 0 },
  };
}

r.get('/pub/:slug/novo', carregarPub, (req, res) => {
  res.render('admin/numero', { n: { volume: '', numero: '', ano: new Date().getFullYear(), publicado: 0 }, trabalhos: [], anexos: [], erros: [] });
});

r.post('/pub/:slug/novo', carregarPub, comArquivos([{ name: 'pdf', maxCount: 1 }, { name: 'capa', maxCount: 1 }]), async (req, res) => {
  const { pub } = res.locals;
  const { erros, dados } = lerNumero(req.body);
  const slug = erros.length ? '' : slugNumero(dados.volume, dados.numero, dados.ano);
  if (!erros.length && await one('SELECT id FROM numeros WHERE publicacao = ? AND slug = ?', [pub.slug, slug])) {
    erros.push('Já existe um número com esse volume, número e ano.');
  }
  let pdfId = null; let capaId = null;
  if (!erros.length) {
    try {
      pdfId = await salvarArquivo(arq(req, 'pdf'), 'pdf');
      capaId = await salvarArquivo(arq(req, 'capa'), 'imagem');
    } catch (e) {
      if (!(e instanceof ErroArquivo)) throw e;
      await apagarArquivo(pdfId);
      erros.push(e.message);
    }
  }
  if (erros.length) return res.status(400).render('admin/numero', { n: { ...dados, numero: dados.numero ?? '' }, trabalhos: [], anexos: [], erros });
  const r2 = await run(
    `INSERT INTO numeros (publicacao, slug, volume, numero, ano, titulo, descricao, data_publicacao, pdf_id, capa_id, publicado)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [pub.slug, slug, dados.volume, dados.numero, dados.ano, dados.titulo, dados.descricao, dados.data_publicacao, pdfId, capaId, dados.publicado],
  );
  res.redirect(`/admin/numero/${Number(r2.lastInsertRowid)}?msg=criado`);
});

async function carregarNumero(req, res, next) {
  const id = Number(req.params.id);
  const n = Number.isInteger(id) ? await numeroPorId(id) : null;
  if (!n) return next('route');
  res.locals.n = n;
  res.locals.pub = await publicacao(n.publicacao);
  next();
}

r.get('/numero/:id', carregarNumero, async (req, res) => {
  const { n } = res.locals;
  res.render('admin/numero', { trabalhos: await trabalhosDoNumero(n.id), anexos: await anexosDoNumero(n.id), erros: [] });
});

r.post('/numero/:id', carregarNumero, comArquivos([{ name: 'pdf', maxCount: 1 }, { name: 'capa', maxCount: 1 }]), async (req, res) => {
  const { n, pub } = res.locals;
  const { erros, dados } = lerNumero(req.body);
  const slug = erros.length ? n.slug : slugNumero(dados.volume, dados.numero, dados.ano);
  if (!erros.length && await one('SELECT id FROM numeros WHERE publicacao = ? AND slug = ? AND id != ?', [pub.slug, slug, n.id])) {
    erros.push('Já existe outro número com esse volume, número e ano.');
  }
  let pdfId = n.pdf_id; let capaId = n.capa_id;
  const velhos = [];
  if (!erros.length) {
    try {
      const novoPdf = await salvarArquivo(arq(req, 'pdf'), 'pdf');
      const novaCapa = await salvarArquivo(arq(req, 'capa'), 'imagem');
      if (novoPdf || req.body.remover_pdf) { velhos.push(n.pdf_id); pdfId = novoPdf; }
      if (novaCapa || req.body.remover_capa) { velhos.push(n.capa_id); capaId = novaCapa; }
    } catch (e) {
      if (!(e instanceof ErroArquivo)) throw e;
      erros.push(e.message);
    }
  }
  if (erros.length) {
    return res.status(400).render('admin/numero', { n: { ...n, ...dados, numero: dados.numero ?? '' }, trabalhos: await trabalhosDoNumero(n.id), anexos: await anexosDoNumero(n.id), erros });
  }
  await run(
    `UPDATE numeros SET slug = ?, volume = ?, numero = ?, ano = ?, titulo = ?, descricao = ?, data_publicacao = ?, pdf_id = ?, capa_id = ?, publicado = ? WHERE id = ?`,
    [slug, dados.volume, dados.numero, dados.ano, dados.titulo, dados.descricao, dados.data_publicacao, pdfId, capaId, dados.publicado, n.id],
  );
  for (const id of velhos) await apagarArquivo(id);
  res.redirect(`/admin/numero/${n.id}?msg=salvo`);
});

r.post('/numero/:id/excluir', carregarNumero, upload.none(), verificarCsrf, async (req, res) => {
  const { n } = res.locals;
  const ts = await all('SELECT pdf_id FROM trabalhos WHERE numero_id = ?', [n.id]);
  const xs = await all('SELECT arquivo_id FROM anexos WHERE numero_id = ?', [n.id]);
  await run('DELETE FROM trabalhos WHERE numero_id = ?', [n.id]);
  await run('DELETE FROM anexos WHERE numero_id = ?', [n.id]);
  await run('DELETE FROM numeros WHERE id = ?', [n.id]);
  for (const id of [n.pdf_id, n.capa_id, ...ts.map((t) => t.pdf_id), ...xs.map((x) => x.arquivo_id)]) await apagarArquivo(id);
  res.redirect(`/admin/pub/${n.publicacao}?msg=excluido`);
});

// ---------- anexos (arquivos extras de um número) ----------
r.post('/numero/:id/anexos', carregarNumero, comArquivos([{ name: 'arquivo', maxCount: 1 }]), async (req, res) => {
  const { n } = res.locals;
  const rotulo = s(req.body.rotulo, 200);
  const f = arq(req, 'arquivo');
  const erros = [];
  if (!rotulo) erros.push('Dê um nome ao arquivo extra (por exemplo, "Caderno de resumos").');
  if (!f) erros.push('Escolha um arquivo PDF para enviar.');
  let id = null;
  if (!erros.length) {
    try { id = await salvarArquivo(f, 'pdf'); } catch (e) { if (!(e instanceof ErroArquivo)) throw e; erros.push(e.message); }
  }
  if (erros.length) return res.status(400).render('admin/numero', { trabalhos: await trabalhosDoNumero(n.id), anexos: await anexosDoNumero(n.id), erros });
  await run('INSERT INTO anexos (numero_id, rotulo, arquivo_id) VALUES (?, ?, ?)', [n.id, rotulo, id]);
  res.redirect(`/admin/numero/${n.id}?msg=anexo#anexos`);
});

r.post('/anexo/:id/excluir', upload.none(), verificarCsrf, async (req, res, next) => {
  const x = await one('SELECT * FROM anexos WHERE id = ?', [Number(req.params.id) || 0]);
  if (!x) return next();
  await run('DELETE FROM anexos WHERE id = ?', [x.id]);
  await apagarArquivo(x.arquivo_id);
  res.redirect(`/admin/numero/${x.numero_id}?msg=excluido#anexos`);
});

// ---------- trabalhos ----------
function lerTrabalho(body) {
  const erros = [];
  const dados = {
    titulo: s(body.titulo, 500), autores: s(body.autores, 3000), resumo: s(body.resumo, 10000),
    palavras_chave: s(body.palavras_chave, 500), secao: s(body.secao, 200), paginas: s(body.paginas, 20), ordem: inteiro(body.ordem) ?? 0,
  };
  if (!dados.titulo) erros.push('Informe o título do trabalho.');
  if (!dados.autores) erros.push('Informe os autores (um por linha).');
  return { erros, dados };
}

r.get('/numero/:id/trabalho/novo', carregarNumero, async (req, res) => {
  const ultimo = await one('SELECT secao FROM trabalhos WHERE numero_id = ? ORDER BY id DESC LIMIT 1', [res.locals.n.id]);
  res.render('admin/trabalho', { t: { secao: ultimo?.secao || '' }, erros: [] });
});

r.post('/numero/:id/trabalho/novo', carregarNumero, comArquivos([{ name: 'pdf', maxCount: 1 }]), async (req, res) => {
  const { n } = res.locals;
  const { erros, dados } = lerTrabalho(req.body);
  let pdfId = null;
  if (!erros.length) {
    try { pdfId = await salvarArquivo(arq(req, 'pdf'), 'pdf'); } catch (e) { if (!(e instanceof ErroArquivo)) throw e; erros.push(e.message); }
  }
  if (erros.length) return res.status(400).render('admin/trabalho', { t: dados, erros });
  await run(
    'INSERT INTO trabalhos (numero_id, titulo, autores, resumo, palavras_chave, secao, paginas, ordem, pdf_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [n.id, dados.titulo, dados.autores, dados.resumo, dados.palavras_chave, dados.secao, dados.paginas, dados.ordem, pdfId],
  );
  const destino = req.body.continuar ? `/admin/numero/${n.id}/trabalho/novo?msg=trabalho` : `/admin/numero/${n.id}?msg=trabalho#trabalhos`;
  res.redirect(destino);
});

async function carregarTrabalho(req, res, next) {
  const t = await one('SELECT t.*, a.nome AS pdf_nome FROM trabalhos t LEFT JOIN arquivos a ON a.id = t.pdf_id WHERE t.id = ?', [Number(req.params.id) || 0]);
  if (!t) return next('route');
  t.pdf_url = urlArquivo(t.pdf_id, t.pdf_nome);
  res.locals.t = t;
  res.locals.n = await numeroPorId(t.numero_id);
  res.locals.pub = await publicacao(res.locals.n.publicacao);
  next();
}

r.get('/trabalho/:id', carregarTrabalho, (req, res) => res.render('admin/trabalho', { erros: [] }));

r.post('/trabalho/:id', carregarTrabalho, comArquivos([{ name: 'pdf', maxCount: 1 }]), async (req, res) => {
  const { t } = res.locals;
  const { erros, dados } = lerTrabalho(req.body);
  let pdfId = t.pdf_id;
  let velho = null;
  if (!erros.length) {
    try {
      const novo = await salvarArquivo(arq(req, 'pdf'), 'pdf');
      if (novo || req.body.remover_pdf) { velho = t.pdf_id; pdfId = novo; }
    } catch (e) { if (!(e instanceof ErroArquivo)) throw e; erros.push(e.message); }
  }
  if (erros.length) return res.status(400).render('admin/trabalho', { t: { ...t, ...dados }, erros });
  await run(
    'UPDATE trabalhos SET titulo = ?, autores = ?, resumo = ?, palavras_chave = ?, secao = ?, paginas = ?, ordem = ?, pdf_id = ? WHERE id = ?',
    [dados.titulo, dados.autores, dados.resumo, dados.palavras_chave, dados.secao, dados.paginas, dados.ordem, pdfId, t.id],
  );
  await apagarArquivo(velho);
  res.redirect(`/admin/trabalho/${t.id}?msg=salvo`);
});

r.post('/trabalho/:id/excluir', carregarTrabalho, upload.none(), verificarCsrf, async (req, res) => {
  const { t } = res.locals;
  await run('DELETE FROM trabalhos WHERE id = ?', [t.id]);
  await apagarArquivo(t.pdf_id);
  res.redirect(`/admin/numero/${t.numero_id}?msg=excluido#trabalhos`);
});

// ---------- minha conta ----------
r.get('/conta', (req, res) => res.render('admin/conta', { erro: null }));

r.post('/conta', upload.none(), verificarCsrf, async (req, res) => {
  const u = await one('SELECT * FROM usuarios WHERE id = ?', [req.usuario.id]);
  const { verify } = await import('@node-rs/argon2');
  let ok = false;
  try { ok = await verify(u.senha_hash, String(req.body.atual || '').slice(0, 200)); } catch { ok = false; }
  const nova = String(req.body.nova || '');
  let erro = !ok ? 'A senha atual está incorreta.' : validarSenha(nova, u.usuario);
  if (!erro && nova !== req.body.confirmar) erro = 'A confirmação não é igual à nova senha.';
  if (!erro && nova === req.body.atual) erro = 'A nova senha precisa ser diferente da atual.';
  if (erro) return res.status(400).render('admin/conta', { erro });
  await run('UPDATE usuarios SET senha_hash = ?, trocar_senha = 0 WHERE id = ?', [await gerarHash(nova), u.id]);
  await encerrarOutrasSessoes(u.id, req);
  res.redirect('/admin?msg=senha');
});

// ---------- usuários (só administradores) ----------
r.get('/usuarios', exigirAdmin, async (req, res) => {
  const usuarios = await all('SELECT id, usuario, papel, trocar_senha, criado_em, ultimo_acesso FROM usuarios ORDER BY usuario');
  res.render('admin/usuarios', { usuarios, erro: null, senhaGerada: null });
});

async function renderUsuarios(res, extra) {
  const usuarios = await all('SELECT id, usuario, papel, trocar_senha, criado_em, ultimo_acesso FROM usuarios ORDER BY usuario');
  res.render('admin/usuarios', { usuarios, erro: null, senhaGerada: null, ...extra });
}

r.post('/usuarios', exigirAdmin, upload.none(), verificarCsrf, async (req, res) => {
  const nome = s(req.body.usuario, 60).toLowerCase();
  const papel = req.body.papel === 'admin' ? 'admin' : 'editor';
  let erro = validarUsuario(nome);
  if (!erro && await one('SELECT id FROM usuarios WHERE usuario = ?', [nome])) erro = 'Esse nome de usuário já existe.';
  if (erro) return renderUsuarios(res.status(400), { erro });
  const senha = senhaTemporaria();
  await run('INSERT INTO usuarios (usuario, senha_hash, papel, trocar_senha) VALUES (?, ?, ?, 1)', [nome, await gerarHash(senha), papel]);
  renderUsuarios(res, { senhaGerada: { usuario: nome, senha, nova: true } });
});

r.post('/usuarios/:id/redefinir', exigirAdmin, upload.none(), verificarCsrf, async (req, res, next) => {
  const u = await one('SELECT id, usuario FROM usuarios WHERE id = ?', [Number(req.params.id) || 0]);
  if (!u) return next();
  const senha = senhaTemporaria();
  await run('UPDATE usuarios SET senha_hash = ?, trocar_senha = 1 WHERE id = ?', [await gerarHash(senha), u.id]);
  await run('DELETE FROM sessoes WHERE usuario_id = ?', [u.id]);
  if (u.id === req.usuario.id) return res.redirect('/admin/entrar');
  renderUsuarios(res, { senhaGerada: { usuario: u.usuario, senha, nova: false } });
});

r.post('/usuarios/:id/papel', exigirAdmin, upload.none(), verificarCsrf, async (req, res, next) => {
  const u = await one('SELECT id FROM usuarios WHERE id = ?', [Number(req.params.id) || 0]);
  if (!u) return next();
  if (u.id === req.usuario.id) return renderUsuarios(res.status(400), { erro: 'Você não pode mudar o seu próprio papel.' });
  await run('UPDATE usuarios SET papel = ? WHERE id = ?', [req.body.papel === 'admin' ? 'admin' : 'editor', u.id]);
  res.redirect('/admin/usuarios?msg=salvo');
});

r.post('/usuarios/:id/excluir', exigirAdmin, upload.none(), verificarCsrf, async (req, res, next) => {
  const u = await one('SELECT id FROM usuarios WHERE id = ?', [Number(req.params.id) || 0]);
  if (!u) return next();
  if (u.id === req.usuario.id) return renderUsuarios(res.status(400), { erro: 'Você não pode excluir a sua própria conta.' });
  await run('DELETE FROM sessoes WHERE usuario_id = ?', [u.id]);
  await run('DELETE FROM usuarios WHERE id = ?', [u.id]);
  res.redirect('/admin/usuarios?msg=excluido');
});

r.use((req, res) => res.status(404).render('admin/erro', { titulo: 'Página não encontrada', mensagem: 'Esse endereço não existe no painel.' }));

export default r;

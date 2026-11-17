// Testes automáticos: rode com  npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fomerco-teste-'));
process.env.DATABASE_URL = `file:${path.join(dir, 'teste.db')}`;
process.env.ADMIN_USUARIO = 'chefe';
process.env.ADMIN_SENHA = 'senha-inicial-forte';

const { criarApp } = await import('../src/server.js');
const { one, run } = await import('../src/db.js');
const { gerarHash } = await import('../src/auth.js');

let servidor; let base;
before(async () => {
  const app = await criarApp();
  await new Promise((ok) => { servidor = app.listen(0, ok); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});
after(() => { servidor.close(); fs.rmSync(dir, { recursive: true, force: true }); });

class Cliente {
  cookie = '';
  async ir(caminho, opcoes = {}) {
    const r = await fetch(base + caminho, { redirect: 'manual', ...opcoes, headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...(opcoes.headers || {}) } });
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    return r;
  }
  post(caminho, dados, headers = {}) {
    const corpo = dados instanceof FormData ? dados : new URLSearchParams(dados);
    return this.ir(caminho, { method: 'POST', body: corpo, headers });
  }
  async csrf(caminho = '/admin') {
    const html = await (await this.ir(caminho)).text();
    return html.match(/name="_csrf" value="([^"]+)"/)[1];
  }
}

async function entrar(usuario, senha) {
  const c = new Cliente();
  const r = await c.post('/admin/entrar', { usuario, senha });
  return { c, r };
}

test('administrador inicial é criado com senha em hash Argon2 e precisa trocá-la', async () => {
  const u = await one('SELECT * FROM usuarios WHERE usuario = ?', ['chefe']);
  assert.ok(u.senha_hash.startsWith('$argon2id$'));
  assert.ok(!u.senha_hash.includes('senha-inicial-forte'));
  const { c, r } = await entrar('chefe', 'senha-inicial-forte');
  assert.equal(r.headers.get('location'), '/admin/conta?msg=trocar');
  const r2 = await c.ir('/admin/pub/anais');
  assert.equal(r2.headers.get('location'), '/admin/conta?msg=trocar');
  const csrf = await c.csrf('/admin/conta');
  const r3 = await c.post('/admin/conta', { _csrf: csrf, atual: 'senha-inicial-forte', nova: 'uma frase longa e nova', confirmar: 'uma frase longa e nova' });
  assert.equal(r3.status, 302);
  assert.equal((await c.ir('/admin/pub/anais')).status, 200);
});

test('cookie de sessão é HttpOnly e SameSite', async () => {
  const r = await fetch(`${base}/admin/entrar`, { method: 'POST', body: new URLSearchParams({ usuario: 'chefe', senha: 'uma frase longa e nova' }), redirect: 'manual' });
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/i);
  assert.match(sc, /SameSite=Lax/i);
});

test('senha errada dá mensagem genérica e bloqueia após 5 tentativas', async () => {
  await run("INSERT INTO usuarios (usuario, senha_hash, papel, trocar_senha) VALUES ('alvo', ?, 'editor', 0)", [await gerarHash('senha-correta-123')]);
  const inexistente = await entrar('ninguem', 'qualquer-coisa');
  const errada = await entrar('alvo', 'errada');
  assert.equal(inexistente.r.status, 401);
  assert.equal(errada.r.status, 401);
  assert.match(await errada.r.text(), /Usuário ou senha incorretos/);
  for (let i = 0; i < 4; i++) await entrar('alvo', `errada-${i}`);
  const certa = await entrar('alvo', 'senha-correta-123');
  assert.equal(certa.r.status, 401);
  assert.match(await certa.r.text(), /Muitas tentativas/);
});

test('painel exige login', async () => {
  for (const p of ['/admin', '/admin/usuarios', '/admin/pub/anais', '/admin/evento']) {
    const r = await new Cliente().ir(p);
    assert.equal(r.headers.get('location'), '/admin/entrar', p);
  }
});

test('formulários sem token CSRF ou de outro site são recusados', async () => {
  const { c } = await entrar('chefe', 'uma frase longa e nova');
  const semToken = await c.post('/admin/configuracoes', { hero_titulo: 'invadido' });
  assert.equal(semToken.status, 403);
  const csrf = await c.csrf();
  const outraOrigem = await c.post('/admin/configuracoes', { _csrf: csrf, hero_titulo: 'invadido' }, { origin: 'https://site-malicioso.com' });
  assert.equal(outraOrigem.status, 403);
  const cfg = await one("SELECT valor FROM configuracoes WHERE chave = 'hero_titulo'");
  assert.notEqual(cfg.valor, 'invadido');
});

test('editor não gerencia usuários; admin cria conta com senha temporária', async () => {
  const { c } = await entrar('chefe', 'uma frase longa e nova');
  const csrf = await c.csrf('/admin/usuarios');
  const r = await c.post('/admin/usuarios', { _csrf: csrf, usuario: 'editor1', papel: 'editor' });
  const html = await r.text();
  const senha = html.match(/Senha temporária: <code>([^<]+)<\/code>/)[1];
  assert.equal(senha.length, 16);
  const e = await entrar('editor1', senha);
  const csrfE = await e.c.csrf('/admin/conta');
  await e.c.post('/admin/conta', { _csrf: csrfE, atual: senha, nova: 'frase do editor 2026', confirmar: 'frase do editor 2026' });
  assert.equal((await e.c.ir('/admin/usuarios')).status, 403);
  const csrf2 = await e.c.csrf();
  const tentativa = await e.c.post('/admin/usuarios', { _csrf: csrf2, usuario: 'intruso', papel: 'admin' });
  assert.equal(tentativa.status, 403);
  assert.equal(await one("SELECT id FROM usuarios WHERE usuario = 'intruso'"), null);
});

test('nenhuma página pública expõe usuários ou senhas', async () => {
  for (const p of ['/', '/sobre', '/anais', '/anais/expediente', '/carta/numeros']) {
    const html = await (await fetch(base + p)).text();
    assert.ok(!html.includes('argon2'), p);
    assert.ok(!html.includes('editor1'), p);
  }
});

test('upload recusa arquivo que não é PDF e aceita PDF real; rascunho não aparece no site', async () => {
  const { c } = await entrar('chefe', 'uma frase longa e nova');
  const csrf = await c.csrf('/admin/pub/carta/novo');
  const falso = new FormData();
  Object.entries({ _csrf: csrf, volume: '1', numero: '1', ano: '2026' }).forEach(([k, v]) => falso.append(k, v));
  falso.append('pdf', new Blob(['<script>alert(1)</script>'], { type: 'application/pdf' }), 'falso.pdf');
  const r1 = await c.post('/admin/pub/carta/novo', falso);
  assert.equal(r1.status, 400);
  assert.match(await r1.text(), /não é um PDF válido/);

  const bom = new FormData();
  Object.entries({ _csrf: csrf, volume: '1', numero: '1', ano: '2026' }).forEach(([k, v]) => bom.append(k, v));
  bom.append('pdf', new Blob(['%PDF-1.4\n%%EOF'], { type: 'application/pdf' }), 'carta.pdf');
  const r2 = await c.post('/admin/pub/carta/novo', bom);
  assert.equal(r2.status, 302);
  const n = await one("SELECT * FROM numeros WHERE publicacao = 'carta' AND slug = 'vol-1-no-1-2026'");
  assert.equal(n.publicado, 0);
  assert.equal((await fetch(`${base}/carta/vol-1-no-1-2026`)).status, 404);

  const arq = await fetch(`${base}/arquivos/${n.pdf_id}/carta.pdf`);
  assert.equal(arq.headers.get('content-type'), 'application/pdf');
  assert.equal(arq.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(`${base}/arquivos/../../etc/passwd/x`)).status, 404);
});

test('texto editável não executa scripts', async () => {
  const { md } = await import('../src/conteudo.js');
  const html = md('Olá <script>alert(1)</script> [x](javascript:alert(1)) <img src=x onerror=alert(1)>');
  assert.ok(!/script|onerror|javascript:/i.test(html), html);
});

test('cabeçalhos de segurança estão presentes', async () => {
  const r = await fetch(`${base}/`);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-powered-by'), null);
});

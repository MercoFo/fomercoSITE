// Login, sessões, proteção CSRF e limite de tentativas.
import crypto from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { one, run } from './db.js';

const COOKIE = 'fm_sessao';
const DURACAO_SESSAO = 8 * 60 * 60 * 1000; // 8 horas
const JANELA = 15 * 60 * 1000;
const MAX_FALHAS_USUARIO = 5;
const MAX_FALHAS_IP = 20;
export const SENHA_MINIMA = 10;

const producao = process.env.NODE_ENV === 'production';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Hash usado quando o usuário não existe, para o tempo de resposta não revelar quem existe.
let hashFalso;
async function obterHashFalso() {
  if (!hashFalso) hashFalso = await hash(crypto.randomBytes(16).toString('hex'));
  return hashFalso;
}

export const gerarHash = (senha) => hash(senha);

export function validarSenha(senha, usuario = '') {
  if (typeof senha !== 'string' || senha.length < SENHA_MINIMA) return `A senha precisa ter pelo menos ${SENHA_MINIMA} caracteres.`;
  if (senha.length > 200) return 'A senha pode ter no máximo 200 caracteres.';
  if (usuario && senha.toLowerCase().includes(usuario.toLowerCase())) return 'A senha não pode conter o nome de usuário.';
  return null;
}

export function validarUsuario(nome) {
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(nome || '')) return 'O usuário deve ter de 3 a 40 caracteres: letras sem acento, números, ponto, hífen ou sublinhado.';
  return null;
}

export function senhaTemporaria() {
  // 16 caracteres sem letras ambíguas
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(16);
  return Array.from(bytes, (b) => abc[b % abc.length]).join('');
}

// ---------- limite de tentativas ----------
async function estadoTentativa(chave) {
  return one('SELECT falhas, inicio, bloqueado_ate FROM tentativas_login WHERE chave = ?', [chave]);
}
async function bloqueado(chave) {
  const t = await estadoTentativa(chave);
  return t && t.bloqueado_ate > Date.now();
}
async function registrarFalha(chave, max) {
  const agora = Date.now();
  const t = await estadoTentativa(chave);
  if (!t || agora - t.inicio > JANELA) {
    await run('INSERT INTO tentativas_login (chave, falhas, inicio, bloqueado_ate) VALUES (?, 1, ?, 0) ON CONFLICT(chave) DO UPDATE SET falhas = 1, inicio = excluded.inicio, bloqueado_ate = 0', [chave, agora]);
    return;
  }
  const falhas = t.falhas + 1;
  const bloq = falhas >= max ? agora + JANELA : 0;
  await run('UPDATE tentativas_login SET falhas = ?, bloqueado_ate = ? WHERE chave = ?', [falhas, bloq, chave]);
}

// ---------- login ----------
export async function tentarLogin(usuario, senha, ip) {
  const nome = String(usuario || '').trim().toLowerCase().slice(0, 60);
  const chaveU = `u:${nome}`;
  const chaveIp = `ip:${ip}`;
  if ((await bloqueado(chaveU)) || (await bloqueado(chaveIp))) {
    return { erro: 'Muitas tentativas seguidas. Aguarde 15 minutos e tente de novo.' };
  }
  const u = nome ? await one('SELECT * FROM usuarios WHERE usuario = ?', [nome]) : null;
  let ok = false;
  try {
    ok = await verify(u ? u.senha_hash : await obterHashFalso(), String(senha || '').slice(0, 200));
  } catch { ok = false; }
  if (!u || !ok) {
    await registrarFalha(chaveU, MAX_FALHAS_USUARIO);
    await registrarFalha(chaveIp, MAX_FALHAS_IP);
    return { erro: 'Usuário ou senha incorretos.' };
  }
  await run('DELETE FROM tentativas_login WHERE chave = ?', [chaveU]);
  await run("UPDATE usuarios SET ultimo_acesso = datetime('now') WHERE id = ?", [u.id]);
  return { usuario: u };
}

export async function criarSessao(res, usuarioId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  await run('INSERT INTO sessoes (token_hash, usuario_id, csrf, expira_em) VALUES (?, ?, ?, ?)', [sha256(token), usuarioId, csrf, Date.now() + DURACAO_SESSAO]);
  res.cookie(COOKIE, token, { httpOnly: true, secure: producao, sameSite: 'lax', path: '/', maxAge: DURACAO_SESSAO });
}

export async function encerrarSessao(req, res) {
  const token = lerCookie(req, COOKIE);
  if (token) await run('DELETE FROM sessoes WHERE token_hash = ?', [sha256(token)]);
  res.clearCookie(COOKIE, { path: '/' });
}

export async function encerrarOutrasSessoes(usuarioId, req) {
  const token = lerCookie(req, COOKIE);
  await run('DELETE FROM sessoes WHERE usuario_id = ? AND token_hash != ?', [usuarioId, token ? sha256(token) : '']);
}

function lerCookie(req, nome) {
  const header = req.headers.cookie || '';
  for (const parte of header.split(';')) {
    const i = parte.indexOf('=');
    if (i > -1 && parte.slice(0, i).trim() === nome) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return null;
}

// Carrega o usuário logado (se houver) em req.usuario.
export async function carregarSessao(req, res, next) {
  try {
    const token = lerCookie(req, COOKIE);
    if (token && token.length < 100) {
      const s = await one(
        `SELECT s.csrf, s.expira_em, u.id, u.usuario, u.papel, u.trocar_senha
         FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id WHERE s.token_hash = ?`,
        [sha256(token)],
      );
      if (s && s.expira_em > Date.now()) {
        req.usuario = { id: s.id, usuario: s.usuario, papel: s.papel, trocarSenha: !!s.trocar_senha };
        req.csrf = s.csrf;
      } else if (s) {
        await run('DELETE FROM sessoes WHERE token_hash = ?', [sha256(token)]);
      }
    }
    res.locals.usuario = req.usuario || null;
    res.locals.csrf = req.csrf || '';
    next();
  } catch (e) { next(e); }
}

export function exigirLogin(req, res, next) {
  if (!req.usuario) return res.redirect('/admin/entrar');
  if (req.usuario.trocarSenha && !['/conta', '/sair'].includes(req.path)) return res.redirect('/admin/conta?msg=trocar');
  next();
}

export function exigirAdmin(req, res, next) {
  if (req.usuario?.papel !== 'admin') return res.status(403).render('admin/erro', { titulo: 'Acesso restrito', mensagem: 'Só administradores podem gerenciar usuários.' });
  next();
}

// Confere a origem do pedido e o token CSRF em todo POST do painel.
export function verificarOrigem(req, res, next) {
  if (req.method !== 'POST') return next();
  const origem = req.headers.origin || req.headers.referer;
  if (origem) {
    try {
      if (new URL(origem).host !== req.headers.host) return res.status(403).send('Origem do pedido não permitida.');
    } catch { return res.status(403).send('Origem do pedido inválida.'); }
  }
  next();
}

export function verificarCsrf(req, res, next) {
  if (req.method !== 'POST') return next();
  const enviado = String(req.body?._csrf || '');
  const a = Buffer.from(enviado);
  const b = Buffer.from(req.csrf || '');
  if (!req.csrf || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).render('admin/erro', { titulo: 'Formulário expirado', mensagem: 'Recarregue a página e tente de novo.' });
  }
  next();
}

export async function limparSessoesVencidas() {
  await run('DELETE FROM sessoes WHERE expira_em < ?', [Date.now()]);
  await run('DELETE FROM tentativas_login WHERE inicio < ? AND bloqueado_ate < ?', [Date.now() - JANELA, Date.now()]);
}

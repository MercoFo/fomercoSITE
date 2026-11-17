// Arquivos (PDFs e imagens) ficam guardados dentro do próprio banco, em partes.
// Assim o site funciona em hospedagens gratuitas que apagam o disco a cada reinício.
import crypto from 'node:crypto';
import { one, run, all } from './db.js';

const TAMANHO_PARTE = 512 * 1024;

export const TIPOS = {
  pdf: { mimes: ['application/pdf'], ext: ['.pdf'], max: 40 * 1024 * 1024 },
  imagem: { mimes: ['image/png', 'image/jpeg', 'image/webp'], ext: ['.png', '.jpg', '.jpeg', '.webp'], max: 5 * 1024 * 1024 },
};

// Confere a assinatura real do arquivo, não só a extensão informada pelo navegador.
function detectarTipo(buf) {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 8 && buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export class ErroArquivo extends Error {}

export function nomeSeguro(nome) {
  const base = String(nome || 'arquivo').normalize('NFD').replace(/[̀-ͯ]/g, '');
  const limpo = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return (limpo || 'arquivo').slice(0, 120);
}

export async function salvarArquivo(file, categoria) {
  if (!file || !file.buffer || file.size === 0) return null;
  const regra = TIPOS[categoria];
  const tipo = detectarTipo(file.buffer);
  if (!tipo || !regra.mimes.includes(tipo)) {
    throw new ErroArquivo(categoria === 'pdf'
      ? `O arquivo "${file.originalname}" não é um PDF válido.`
      : `A imagem "${file.originalname}" precisa ser PNG, JPG ou WebP.`);
  }
  if (file.size > regra.max) {
    throw new ErroArquivo(`O arquivo "${file.originalname}" passa do limite de ${Math.round(regra.max / 1024 / 1024)} MB.`);
  }
  const id = crypto.randomBytes(16).toString('hex');
  await run('INSERT INTO arquivos (id, nome, tipo, tamanho, completo) VALUES (?, ?, ?, ?, 0)', [id, nomeSeguro(file.originalname), tipo, file.size]);
  try {
    for (let i = 0, parte = 0; i < file.buffer.length; i += TAMANHO_PARTE, parte++) {
      await run('INSERT INTO arquivo_partes (arquivo_id, indice, dados) VALUES (?, ?, ?)', [id, parte, file.buffer.subarray(i, i + TAMANHO_PARTE)]);
    }
    await run('UPDATE arquivos SET completo = 1 WHERE id = ?', [id]);
  } catch (e) {
    await apagarArquivo(id);
    throw e;
  }
  return id;
}

export async function apagarArquivo(id) {
  if (!id) return;
  await run('DELETE FROM arquivo_partes WHERE arquivo_id = ?', [id]);
  await run('DELETE FROM arquivos WHERE id = ?', [id]);
}

export async function infoArquivo(id) {
  if (!/^[a-f0-9]{32}$/.test(String(id))) return null;
  return one('SELECT id, nome, tipo, tamanho FROM arquivos WHERE id = ? AND completo = 1', [id]);
}

export async function enviarArquivo(req, res, next) {
  try {
    const info = await infoArquivo(req.params.id);
    if (!info) return next();
    const etag = `"${info.id}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.setHeader('Content-Type', info.tipo);
    res.setHeader('Content-Length', info.tamanho);
    const modo = req.query.baixar ? 'attachment' : 'inline';
    res.setHeader('Content-Disposition', `${modo}; filename="${info.nome}"`);
    const total = await one('SELECT COUNT(*) AS n FROM arquivo_partes WHERE arquivo_id = ?', [info.id]);
    for (let i = 0; i < total.n; i++) {
      const parte = await one('SELECT dados FROM arquivo_partes WHERE arquivo_id = ? AND indice = ?', [info.id, i]);
      const buf = Buffer.from(parte.dados);
      if (!res.write(buf)) await new Promise((ok) => res.once('drain', ok));
    }
    res.end();
  } catch (e) {
    next(e);
  }
}

export async function limparIncompletos() {
  const velhos = await all("SELECT id FROM arquivos WHERE completo = 0 AND criado_em < datetime('now', '-1 hour')");
  for (const a of velhos) await apagarArquivo(a.id);
}

export function urlArquivo(id, nome) {
  return id ? `/arquivos/${id}/${encodeURIComponent(nome || 'arquivo')}` : null;
}


// Cria um banco de DEMONSTRAÇÃO com dados fictícios (data/demo.db) para testar o visual.
// Uso: npm run demo   e depois   DATABASE_URL=file:data/demo.db npm start
process.env.DATABASE_URL = process.env.DATABASE_URL || 'file:data/demo.db';
const fs = await import('node:fs');
const arquivoBanco = process.env.DATABASE_URL.replace(/^file:/, '');
if (fs.existsSync(arquivoBanco)) fs.rmSync(arquivoBanco);
const { migrar, run, salvarConfig } = await import('../src/db.js');
const { salvarArquivo } = await import('../src/arquivos.js');
const { gerarHash } = await import('../src/auth.js');
const { slugNumero } = await import('../src/conteudo.js');

function pdf(texto) {
  const corpo = `BT /F1 18 Tf 72 720 Td (${texto.replace(/[()\\]/g, '')}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${corpo.length} >>\nstream\n${corpo}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let s = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(s.length); s += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = s.length;
  s += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  s += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return { buffer: Buffer.from(s, 'latin1'), size: s.length, originalname: `${texto.slice(0, 40)}.pdf` };
}

await migrar();
await run("INSERT INTO usuarios (usuario, senha_hash, papel, trocar_senha) VALUES ('admin', ?, 'admin', 0)", [await gerarHash('demonstracao-2026')]);
await run("INSERT INTO usuarios (usuario, senha_hash, papel, trocar_senha) VALUES ('editora', ?, 'editor', 1)", [await gerarHash('outra-senha-qualquer')]);
await salvarConfig({ evento_tema: 'Integração regional em tempos de transição', evento_datas: 'Datas a anunciar', evento_local: 'São Paulo (SP)', contato_email: 'contato@exemplo.org' });
await run("UPDATE publicacoes SET instituicao = 'Instituição de exemplo', endereco = 'Rua Exemplo, 100, Centro\nSão Paulo, SP, 01000-000, Brasil', email = 'publicacoes@exemplo.org'");

async function numero(pub, volume, num, ano, titulo, data, comPdf) {
  const pdfId = comPdf ? await salvarArquivo(pdf(`${titulo} ${ano}`), 'pdf') : null;
  const r = await run('INSERT INTO numeros (publicacao, slug, volume, numero, ano, titulo, data_publicacao, pdf_id, publicado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)',
    [pub, slugNumero(volume, num, ano), volume, num, ano, titulo, data, pdfId]);
  return Number(r.lastInsertRowid);
}

const n1 = await numero('anais', 1, 1, 2023, 'Exemplo: encontro de 2023', '2023-12-15', true);
const n2 = await numero('anais', 2, 1, 2025, 'Exemplo: encontro de 2025', '2025-12-10', true);
const trabalhos = [
  ['GT 1: Instituições e governança regional', 'Assimetrias institucionais e tomada de decisão no Mercosul', 'Ana Paula Ribeiro\nCarlos Mendes'],
  ['GT 1: Instituições e governança regional', 'O Parlasul e a representação cidadã: um balanço', 'Joana Ferreira'],
  ['GT 1: Instituições e governança regional', 'Cortes regionais e solução de controvérsias na América do Sul', 'Ricardo Alves\nMarina Costa\nPedro Lima'],
  ['GT 2: Economia política da integração', 'Cadeias regionais de valor e a indústria automotiva no Cone Sul', 'Luísa Martins'],
  ['GT 2: Economia política da integração', 'Acordo Mercosul–União Europeia: impactos setoriais', 'Fernando Rocha\nBeatriz Nunes'],
  ['GT 2: Economia política da integração', 'Infraestrutura física e integração energética regional', 'Gustavo Pereira'],
];
for (const n of [n1, n2]) {
  let i = 1;
  for (const [secao, titulo, autores] of trabalhos) {
    const pdfId = await salvarArquivo(pdf(titulo), 'pdf');
    await run('INSERT INTO trabalhos (numero_id, titulo, autores, resumo, palavras_chave, secao, paginas, ordem, pdf_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [n, titulo, autores, 'Texto de resumo fictício, usado apenas para demonstrar como o resumo aparece na página do trabalho. O resumo real é cadastrado pelo painel.', 'integração regional; Mercosul', secao, `${i * 10 - 9}-${i * 10}`, i, pdfId]);
    i++;
  }
}
await run('INSERT INTO anexos (numero_id, rotulo, arquivo_id) VALUES (?, ?, ?)', [n2, 'Caderno de resumos', await salvarArquivo(pdf('Caderno de resumos'), 'pdf')]);
const meses = ['Exemplo: agosto', 'Exemplo: setembro', 'Exemplo: outubro', 'Exemplo: novembro'];
for (let i = 0; i < meses.length; i++) await numero('carta', 1, i + 1, 2026, meses[i], `2026-${String(i + 8).padStart(2, '0')}-05`, true);
console.log('Banco de demonstração criado em', arquivoBanco, '\nLogin: admin / demonstracao-2026');

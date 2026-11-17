import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrar, config, one, run } from './db.js';
import { carregarSessao, gerarHash, validarSenha, validarUsuario, limparSessoesVencidas } from './auth.js';
import { enviarArquivo, limparIncompletos } from './arquivos.js';
import { md, designacao, formatarData, tamanhoLegivel } from './conteudo.js';
import publico from './rotas/publico.js';
import admin from './rotas/admin.js';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const producao = process.env.NODE_ENV === 'production';

export async function criarApp() {
  await migrar();
  await criarAdminInicial();

  const app = express();
  app.disable('x-powered-by');
  // Hospedagens como o Render ficam atrás de um proxy; isso faz req.ip ser o IP real do visitante.
  app.set('trust proxy', Number(process.env.TRUST_PROXY ?? (producao ? 1 : 0)));
  app.set('view engine', 'ejs');
  app.set('views', path.join(raiz, 'views'));

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:'], styleSrc: ["'self'"], scriptSrc: ["'self'"], fontSrc: ["'self'"],
        objectSrc: ["'none'"], frameAncestors: ["'self'"], formAction: ["'self'"], baseUri: ["'self'"],
        ...(producao ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    strictTransportSecurity: producao ? undefined : false,
    // Envia a origem nos formulários (necessário para a checagem de origem do painel)
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }));

  app.use('/static', express.static(path.join(raiz, 'public'), { maxAge: producao ? '7d' : 0 }));
  app.get('/favicon.ico', (req, res) => res.redirect(301, '/static/img/favicon.svg'));
  app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /admin\n'));
  app.use(express.urlencoded({ extended: false, limit: '300kb' }));
  app.use(carregarSessao);

  app.use(async (req, res, next) => {
    try {
      res.locals.cfg = await config();
      const base = process.env.SITE_URL ? process.env.SITE_URL.replace(/\/$/, '') : `${req.protocol}://${req.get('host')}`;
      Object.assign(res.locals, { md, designacao, formatarData, tamanhoLegivel, base, caminho: req.path, secao: '', aba: '', titulo: null });
      next();
    } catch (e) { next(e); }
  });

  app.get('/arquivos/:id/:nome', enviarArquivo);
  app.use('/admin', admin);
  app.use('/', publico);

  app.use((req, res) => res.status(404).render('erro', { titulo: 'Página não encontrada', mensagem: 'O endereço pode ter mudado ou o conteúdo foi retirado do site.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return res.end();
    res.status(500).render('erro', { titulo: 'Algo deu errado', mensagem: 'Houve um erro no servidor. Tente de novo em alguns instantes.' });
  });

  return app;
}

// Na primeira vez que o site sobe sem nenhum usuário, cria o administrador
// a partir das variáveis ADMIN_USUARIO e ADMIN_SENHA. Depois disso elas são ignoradas.
async function criarAdminInicial() {
  const existe = await one('SELECT COUNT(*) AS n FROM usuarios');
  if (existe.n > 0) return;
  const usuario = String(process.env.ADMIN_USUARIO || '').trim().toLowerCase();
  const senha = String(process.env.ADMIN_SENHA || '');
  if (!usuario || !senha) {
    console.warn('[FoMerco] Nenhum usuário cadastrado. Defina ADMIN_USUARIO e ADMIN_SENHA para criar o administrador.');
    return;
  }
  const erro = validarUsuario(usuario) || validarSenha(senha, usuario);
  if (erro) { console.error(`[FoMerco] Administrador inicial não criado: ${erro}`); return; }
  await run("INSERT INTO usuarios (usuario, senha_hash, papel, trocar_senha) VALUES (?, ?, 'admin', 1)", [usuario, await gerarHash(senha)]);
  console.log(`[FoMerco] Administrador "${usuario}" criado. A senha deverá ser trocada no primeiro acesso.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await criarApp();
  const porta = Number(process.env.PORT || 3000);
  app.listen(porta, () => console.log(`[FoMerco] Site no ar em http://localhost:${porta}`));
  const limpeza = () => Promise.all([limparSessoesVencidas(), limparIncompletos()]).catch((e) => console.error(e));
  limpeza();
  setInterval(limpeza, 60 * 60 * 1000).unref();
}

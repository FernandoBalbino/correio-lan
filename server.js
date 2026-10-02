import { createApplication } from './src/app.js';

// O carregador Node.js da Hostinger usa require(), que não aceita top-level await.
async function start() {
  const application = await createApplication();
  const PORT = process.env.PORT || 3000;
  const server = application.app.listen(PORT, '0.0.0.0', () => {
    console.log(`CORREIO LAN iniciado na porta ${PORT}. Dados temporários; um único processo Node.js.`);
  });
  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 10000);
    deadline.unref();
    server.close(async () => { await application.close(); process.exit(0); });
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch(error => {
  console.error('Falha ao iniciar CORREIO LAN:', error);
  process.exit(1);
});

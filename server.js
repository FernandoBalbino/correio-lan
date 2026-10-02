import { createApplication } from './src/app.js';

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

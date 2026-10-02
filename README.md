# CORREIO LAN

Simulador educacional de e-mail para turmas acessarem a mesma sala e praticarem comunicação escrita, destinatários, CC, CCO, respostas, encaminhamentos e anexos. Os endereços `username@sala.local` funcionam dentro do simulador. O aplicativo não envia e-mails para a internet.

## Tecnologias e arquitetura

Node.js 24, Express 5, HTML, CSS e JavaScript vanilla com ES Modules. O Express serve `public/` e a API REST no mesmo domínio. A atualização usa polling HTTP, sem WebSocket, Socket.IO ou WebRTC. Salas, sessões, mensagens, atividades e presença ficam em mapas na RAM. Anexos ficam em uma pasta temporária exclusiva do processo, fora de `public/`, com download autenticado.

```text
GitHub → Hostinger Web app Node.js → server.js → Express
                                                   ├── public/ (interface)
                                                   └── /api (rotas → serviços → MemoryStore)
```

O entry point é **`server.js`**. O comando de inicialização é **`npm start`**, que executa `node server.js`. A porta vem de `process.env.PORT || 3000`; o servidor escuta em `0.0.0.0`. Não existe etapa de compilação do frontend. Todas as chamadas do navegador usam `/api/...`, sem domínio ou porta fixos.

## Instalação local

Instale Node.js 24 e execute na raiz do projeto:

```sh
npm ci
npm start
```

Abra [http://localhost:3000](http://localhost:3000). `npm install` também funciona. Para desenvolvimento com reinício automático do backend:

```sh
npm run dev
```

O `.env` é opcional; os valores padrão já permitem executar. Para personalizar, copie `.env.example` para `.env`. No PowerShell: `Copy-Item .env.example .env`. Reinicie o servidor depois de alterar configurações.

## Como funciona

### Salas e sessões

Informe nome, identificador e sala. A sala é normalizada: `2 Ano Info` vira `2-ano-info`, aparece como `2-ANO-INFO` e gera `ana@2-ano-info.local`. Identificadores são únicos na sala e permitem letras sem acento, números, ponto, hífen e sublinhado. Cada entrada recebe um UUID interno e um token aleatório. Toda operação privada usa esse token no cabeçalho `Authorization: Bearer ...`; parâmetros como `username` não selecionam caixas de terceiros.

A sessão fica em `sessionStorage`, por aba. Atualizar a página recupera a mesma caixa. Sem heartbeat, ela pode ser retomada por até 30 minutos, durante os quais o identificador continua reservado. **Sair da sala** invalida o token imediatamente e libera o identificador. Uma nova sessão não herda mensagens da sessão anterior.

### Presença e polling

O `PollingManager` central controla heartbeat a cada 5 segundos, pessoas a cada 3 segundos, mensagens a cada 2 segundos e atividades a cada 5 segundos. Não inicia uma segunda requisição da mesma tarefa enquanto a anterior estiver em andamento. Em falhas aplica espera progressiva e tenta novamente; ao sair da página cancela timers e requisições.

Após 15 segundos sem heartbeat o participante aparece offline; após 60 segundos sai da lista ativa. O diretório de destinatários ainda inclui sessões recuperáveis, permitindo entrega enquanto o aluno está desconectado. Uma sala sem participantes ativos é removida após 30 minutos, com verificação a cada 10 segundos. Fechar uma aba pode depender da política do navegador para restaurar seu `sessionStorage`; a recuperação garantida dentro do app é na aba que conserva o token.

### Mensagens, CC e CCO

O envio aceita múltiplos destinatários da própria sala. Todos são validados antes da entrega; se um endereço for inválido, não há entrega parcial. Remetente, sala, IDs e horário são determinados pelo servidor. Para e CC aparecem no cabeçalho. O CCO recebe sua cópia e vê o aviso de cópia oculta, mas **a API nunca devolve a lista de CCO**, inclusive em Enviados e no polling.

Cada participante tem seu estado de leitura, estrela, pasta e lixeira. Mover ou excluir sua cópia não altera as cópias de outras pessoas. A exclusão definitiva exige que a mensagem esteja na sua lixeira. As pastas incluem Entrada, Enviados, Com estrela, Arquivados, Spam e Adiados; adiar devolve a mensagem à entrada após uma hora. Busca e paginação são restritas à caixa do usuário. As listagens retornam até 50 mensagens por página, sem corpo completo; o corpo é buscado ao abrir. O polling usa um cursor de alterações e só transfere mudanças. Se o histórico do cursor expirou, solicita nova listagem.

Responder usa `Re:` sem duplicar o prefixo. Responder a todos exclui o próprio usuário e usa apenas remetente, Para e CC visíveis. Encaminhar cria `Enc:` e pode reutilizar anexos acessíveis, sem expor CCO. A chave de idempotência evita duplicar uma mensagem quando o navegador repete o mesmo envio após uma falha de rede.

### Rascunhos e anexos

O texto e os destinatários são salvos automaticamente na aba, separados por endereço de sessão. Fechar o compositor salva; descartar remove o rascunho. Há até 50 rascunhos. **Arquivos selecionados não são armazenados em `sessionStorage`**: depois de atualizar a página é necessário selecioná-los novamente ou remover a pendência. Encaminhamentos guardam referências a anexos existentes, que dependem da mensagem original continuar acessível.

São aceitos PDF, PNG, JPG/JPEG, TXT UTF-8 e DOCX, até **3 arquivos de 2 MiB cada**. A validação confere extensão, MIME e assinatura do conteúdo; DOCX também passa por validação de estrutura ZIP, limites de entradas/expansão e rejeição de macros. Nomes são normalizados e o nome físico é um UUID. Arquivos são servidos como download, nunca executados. Isso valida os tipos permitidos; não substitui um antivírus. Arquivos sem referências são limpos após um intervalo de segurança. Reiniciar o processo elimina o acesso a todos os anexos anteriores.

### Modo professor e atividades

Selecione Professor na entrada. Existe **um professor por sala**, com identificador reservado `professor` e endereço `professor@sala.local`. Esse papel é escolhido na entrada, sem conta ou senha: é um recurso para turma supervisionada, não uma autorização institucional.

O professor publica título, instruções e assunto obrigatório. Uma nova publicação encerra a atividade anterior. Um aluno entrega quando envia uma mensagem ao professor da atividade com o assunto obrigatório, sem diferenciar maiúsculas/minúsculas e ignorando espaços nas extremidades. Enviar antes da publicação não conta como entrega. O painel mostra entregues, pendentes, participantes, presença e estatísticas agregadas. O professor só lê mensagens da própria caixa; não acessa conversas privadas dos alunos.

A lista da atividade conserva todos os participantes, inclusive quem fica offline ou sai, e acrescenta quem entra depois. Reconectar com o mesmo token não duplica o aluno. Entrar novamente após sair cria uma nova sessão e uma nova participação.

## Testando vários alunos

1. Entre como Professor na sala `TESTE`.
2. Em abas novas, janela anônima ou outros navegadores, entre como Ana, Bruno e Carla com identificadores distintos, na mesma sala. Evite duplicar uma aba autenticada, pois o navegador pode copiar seu `sessionStorage`.
3. Confira os participantes; envie de Ana para Bruno, CC professor e CCO Carla. Carla deve receber o aviso; Bruno não deve ver Carla no cabeçalho da mensagem.
4. Teste Responder a todos, salvar rascunho, atualizar página, anexar arquivo, lixeira e restauração.
5. Publique uma atividade e envie ao professor com o assunto exigido. Confira a entrega no painel.
6. Entre em outra sala e confira o isolamento. Feche uma aba: o aluno deve ficar offline em cerca de 15 segundos e desaparecer da lista ativa em cerca de 60 segundos. Use Sair para encerrar imediatamente.

Em outros computadores da mesma rede, use `http://IP-DO-COMPUTADOR:3000`, com o servidor ativo e a porta permitida pelo firewall. `localhost` se refere sempre ao computador onde o navegador está aberto.

```sh
npm run check
npm test
```

Os testes exercitam endereços, duplicidade, presença, expiração, envio, CC/CCO, privacidade, respostas, encaminhamentos, rascunhos, estados individuais, anexos, limites e isolamento. O teste HTTP de turma usa 30 alunos, um professor e uma entrada tardia. Isso verifica o cenário funcional; não é um benchmark de capacidade da hospedagem.

## GitHub

Crie um repositório vazio no GitHub. No terminal da pasta deste projeto, inicialize Git caso ainda não exista e substitua `SEU-USUARIO` pelo seu usuário:

```sh
git init -b main
git add .
git commit -m "Implementa Correio LAN"
git remote add origin https://github.com/SEU-USUARIO/correio-lan.git
git push -u origin main
```

Não envie `.env`, `node_modules/` ou `artifacts/`: o `.gitignore` já os exclui. O `package-lock.json`, `server.js`, `src/`, `public/` e suas fontes/ícones devem ser enviados. Para atualizações:

```sh
git add .
git commit -m "Atualiza Correio LAN"
git push
```

## DEPLOY NA HOSTINGER

Use **Web app Node.js**, com o frontend e backend juntos. A [documentação oficial da Hostinger](https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/) confirma integração GitHub, Express e Node.js 24 em planos Business/Cloud. A conta/plano e um deploy real ainda precisam ser configurados no hPanel.

1. Envie o projeto ao GitHub com os passos acima.
2. No hPanel, abra Sites → Adicionar site → Web app Node.js / Deploy Web App.
3. Escolha importar repositório Git, conecte a conta e selecione o repositório e a branch `main`.
4. Confira framework **Express**, Node.js **24.x** e raiz **`.`**.
5. Se houver campo de instalação, use **`npm ci --omit=dev`**. Fontes e ícones já estão em `public/assets/`; os pacotes de fontes de desenvolvimento não são necessários para executar.
6. O projeto não precisa de build. Se o painel exigir um comando de build, use **`npm run check`**. Não configure publicação estática de `public/`: a aplicação precisa executar Express.
7. Confira entry file **`server.js`** e, se houver campo de startup, **`npm start`**. Se aparecer um campo de diretório de saída para a aplicação Express, mantenha a raiz **`.`**; não há pasta `dist` ou `build`.
8. Defina **`NODE_ENV=production`** nas variáveis. Deixe a plataforma fornecer **`PORT`**. `TRUST_PROXY` deve corresponder ao número de proxies confiáveis do ambiente; use `1` somente se confirmar exatamente um proxy à frente do Node. Isso influencia o limite de entradas por IP.
9. Publique, abra o domínio HTTPS e teste **`/api/health`**. Deve responder `success: true` com `data.status: "ok"`.
10. Teste professor e alunos no domínio. Verifique que chamadas `/api` chegam ao Express, sem cache no proxy/CDN. Mantenha **um único processo/instância**: os dados estão na RAM e não são compartilhados entre processos.

Os rótulos do painel podem variar. A integração GitHub pode disparar novo deploy a cada push; confira a configuração no hPanel. Todo deploy/reinício cria uma nova execução, portanto esvazia salas e mensagens. Faça atualizações entre aulas.

O carregador da Hostinger inicia `server.js` com `require()`. A inicialização assíncrona fica dentro de uma função para permitir esse carregamento no Node.js 24. Não use `await` no nível principal do arquivo de entrada ou de suas dependências: isso causa `ERR_REQUIRE_ASYNC_MODULE` e resposta 503 mesmo quando a compilação termina com sucesso. `npm test` verifica a inicialização via CLI e via `require()`, incluindo frontend e `/api/health`.

As respostas ficam agrupadas em conversas na caixa de entrada e em Enviados. Abra uma conversa para ler a mensagem original e as respostas em ordem, recolher/expandir cada mensagem e responder a qualquer uma delas. Novas respostas atualizam a conversa aberta por polling. O histórico respeita o acesso individual e o CCO; participantes incluídos depois veem apenas as mensagens recebidas ou enviadas por sua sessão.

## Variáveis de ambiente

Todas estão em `.env.example`. Tempos são em milissegundos; limites de arquivo em bytes.

| Variável | Padrão | Uso |
| --- | ---: | --- |
| `NODE_ENV` | `development` | `production` ativa cabeçalhos de produção/HTTPS |
| `PORT` | `3000` | Fornecida pela plataforma no deploy |
| `TRUST_PROXY` | `0` | Quantidade de proxies confiáveis à frente do Express |
| `USER_OFFLINE_TIMEOUT` | `15000` | Ficar offline |
| `USER_ACTIVE_TIMEOUT` | `60000` | Sair da lista ativa |
| `USER_SESSION_TIMEOUT` | `1800000` | Expirar sessão sem heartbeat |
| `ROOM_CLEANUP_TIMEOUT` | `1800000` | Limpar sala sem participantes ativos |
| `CLEANUP_INTERVAL` | `10000` | Verificação periódica de limpeza |
| `POLL_MESSAGES_INTERVAL` | `2000` | Polling incremental da caixa |
| `POLL_USERS_INTERVAL` | `3000` | Polling de pessoas |
| `POLL_ACTIVITIES_INTERVAL` | `5000` | Polling da atividade/painel |
| `HEARTBEAT_INTERVAL` | `5000` | Heartbeat de presença |
| `MAX_MESSAGE_LENGTH` | `10000` | Caracteres do corpo |
| `MAX_ATTACHMENT_SIZE` | `2097152` | 2 MiB por arquivo |
| `MAX_ATTACHMENTS` | `3` | Arquivos por envio, incluindo encaminhados |
| `MAX_RECIPIENTS` | `30` | Soma de Para, CC e CCO antes de remover duplicados |
| `MAX_ROOMS` | `100` | Salas por processo |
| `MAX_USERS_PER_ROOM` | `150` | Sessões reservadas por sala |
| `MAX_MESSAGES_PER_ROOM` | `3000` | Mensagens guardadas por sala |
| `MAX_UPLOAD_BYTES` | `268435456` | 256 MiB em anexos temporários por processo |
| `MAX_CONCURRENT_UPLOADS` | `8` | Requisições multipart simultâneas |
| `JOIN_RATE_LIMIT` | `300` | Entradas por IP na janela |
| `JOIN_RATE_WINDOW` | `300000` | Janela de entradas: 5 minutos |
| `MESSAGE_RATE_LIMIT` | `10` | Envios por sessão/minuto |
| `HEARTBEAT_RATE_LIMIT` | `30` | Heartbeats por sessão/minuto |

Os timeouts devem obedecer heartbeat < offline < ativo < sessão. Nome tem até 50 caracteres; identificador e sala até 30; assunto até 100; atividades até 100 por sala. O limite de entrada considera turmas que compartilham o mesmo IP; os limites de envio e heartbeat são por sessão.

## API

Veja a lista completa e os formatos em [docs/API.md](docs/API.md). Respostas JSON usam `{ "success": true, "data": ... }` ou `{ "success": false, "error": { "code": "...", "message": "..." } }`, com status HTTP adequado. Download de anexo é binário. O health é público e mostra contagens agregadas, não nomes, tokens ou conteúdo.

## Estrutura e entrega

| Caminho | Responsabilidade |
| --- | --- |
| `server.js` | Inicialização e encerramento |
| `src/app.js`, `src/config.js` | Express, autenticação, validação de configuração e limpeza |
| `src/routes/` | Salas, mensagens e atividades |
| `src/services/` | Regras de salas/presença, mensagens, anexos e atividades |
| `src/repositories/memory-store.js` | Estado temporário e expiração |
| `src/middleware/`, `src/utils/` | Rate limit, validação e erros |
| `public/index.html`, `public/app.html` | Entrada e aplicativo de correio |
| `public/css/`, `public/js/` | Layout, controles, API, rascunhos e polling |
| `public/assets/` | Ícones exportados do Figma, fontes locais e licenças |
| `tests/`, `scripts/check.js` | Testes automatizados e verificação de sintaxe |

O diretório estava vazio no início; os arquivos da aplicação foram criados nesta implementação. O resumo de funcionalidades e verificações está em [docs/ENTREGA.md](docs/ENTREGA.md).

## Referência visual

A interface foi implementada a partir do [Gmail UI kit indicado](https://www.figma.com/community/file/1419898786931603227/gmail-ui-kit) e da [cópia fornecida no Figma](https://www.figma.com/design/YlVAGj3uRDfyA8TqHDZvOU/Gmail-UI-kit--Community-). Usa os assets exportados pelo plugin, cores, fontes e medidas do frame de referência, com textos em português, pessoas da sala e atividades educacionais. Há adaptação responsiva. Confira os créditos em [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Limitações e melhorias futuras

Salas, caixas e atividades não persistem após reinício. Anexos usam armazenamento temporário, sem recuperação posterior. Não há SMTP/IMAP, contas permanentes, login institucional, antivírus, histórico durável ou sincronização de rascunhos entre dispositivos. O aluno só acessa sua caixa e sala; o professor não tem acesso irrestrito a caixas privadas. Os limites de recursos são configuráveis e a capacidade real depende do plano contratado. A solução exige um único processo; múltiplas instâncias dividiriam o estado.

Para persistência futura, rotas e serviços estão separados do `MemoryStore`. Um `MySQLStore` poderá substituir os mapas com adaptação das operações de repositório e transações dos serviços, preservando os contratos da API; não existe MySQL nesta versão. Outras evoluções possíveis são autenticação do professor, retenção configurável, antivírus, exportação pedagógica e armazenamento persistente de anexos.

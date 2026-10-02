# API do CORREIO LAN

Base `/api`, no mesmo domínio da interface. Exceto entrada e health, envie `Authorization: Bearer SESSION_TOKEN`. O token nunca deve ser colocado na URL. Identidade e sala são derivadas da sessão; fornecer campos de outro usuário não altera o contexto.

## Rotas

| Método | Rota | Operação |
| --- | --- | --- |
| GET | `/api/health` | Status público, uptime, salas, sessões reservadas e ID da execução |
| POST | `/api/rooms/join` | Entrar; retorna token, usuário, sala e configurações públicas |
| POST | `/api/rooms/leave` | Encerrar sessão e liberar identificador |
| GET | `/api/rooms/current` | Recuperar sessão atual |
| GET | `/api/rooms/users` | Lista ativa, diretório de destinatários e total online da própria sala |
| POST | `/api/presence/heartbeat` | Atualizar presença da sessão |
| GET | `/api/messages/inbox` | Caixa de entrada |
| GET | `/api/messages/sent` | Enviados |
| GET | `/api/messages/trash` | Lixeira |
| GET | `/api/messages/starred` | Com estrela |
| GET | `/api/messages/archive` | Arquivados |
| GET | `/api/messages/spam` | Spam |
| GET | `/api/messages/snoozed` | Adiados |
| GET | `/api/messages/sync?cursor=N` | Alterações incrementais da própria caixa |
| POST | `/api/messages` | Enviar aos destinatários da sala |
| GET | `/api/messages/:id` | Corpo completo da mensagem acessível |
| GET | `/api/messages/:id/thread` | Histórico da conversa; apenas mensagens acessíveis à sessão |
| PATCH | `/api/messages/:id/thread/:action` | Aplicar read, star, trash, restore ou location às próprias cópias da conversa |
| DELETE | `/api/messages/:id/thread` | Excluir próprias cópias da conversa, todas previamente na lixeira |
| GET | `/api/messages/:id/attachments/:attachmentId` | Download autenticado de anexo acessível |
| PATCH | `/api/messages/:id/read` | Estado individual de leitura |
| PATCH | `/api/messages/:id/star` | Estado individual de estrela |
| PATCH | `/api/messages/:id/trash` | Mover própria cópia à lixeira |
| PATCH | `/api/messages/:id/restore` | Restaurar própria cópia da lixeira |
| PATCH | `/api/messages/:id/location` | Alterar pasta; adiar por uma hora |
| DELETE | `/api/messages/:id` | Excluir definitivamente própria cópia na lixeira |
| POST | `/api/activities` | Professor publica atividade |
| GET | `/api/activities/current` | Atividade atual e próprio estado de entrega |
| GET | `/api/activities/status` | Professor consulta lista de entregas e estatísticas |

Rascunhos são locais à aba e não têm rota de backend.

## Entrada

`POST /api/rooms/join` com JSON:

```json
{ "name": "Ana Silva", "username": "ana", "room": "TESTE", "role": "student" }
```

`role` pode ser `student` ou `teacher`. Para professor, o identificador é obrigatoriamente `professor`. Guarde `data.sessionToken` na aba; as outras respostas nunca expõem tokens de participantes. `users` contém sessões ativas até 60 segundos; `directory` contém as sessões recuperáveis até 30 minutos, ambas sem tokens.

## Envio

Sem anexos, `POST /api/messages` aceita JSON:

```json
{
  "to": ["bruno@teste.local"],
  "cc": ["professor@teste.local"],
  "bcc": ["carla@teste.local"],
  "subject": "Atividade 01",
  "body": "Olá, professor! Segue minha atividade."
}
```

Com anexos use `multipart/form-data`: campo textual `message` contendo o mesmo JSON e até três arquivos no campo `attachments`. O navegador deve gerar o boundary. Encaminhar anexos usa `forwardMessageId` e `forwardedAttachmentIds`; o servidor valida acesso à origem e aos arquivos. Novos arquivos e encaminhados compartilham o limite de três.

Opcionalmente envie cabeçalho `Idempotency-Key` com 16–80 caracteres (`A-Z`, `a-z`, números, `_`, `-`). Repetir a chave e o mesmo conteúdo recupera o resultado anterior; usá-la com conteúdo diferente retorna `409`. A validação de sessão e destinatários continua obrigatória nas tentativas.

O remetente e horário vêm do servidor. O campo `bcc` **só existe na entrada do envio e no estado interno**; nenhuma projeção JSON o devolve. `receivedAsBcc` é apenas um booleano da própria cópia. Corpo e nomes são tratados como texto, sem HTML executável na interface.

Respostas enviam `inReplyTo` com o ID da mensagem respondida. O servidor exige acesso a essa mensagem e deriva `threadId` da conversa; não aceita um ID de conversa fornecido pelo cliente para conceder acesso. Assuntos iguais, sem `inReplyTo`, continuam sendo mensagens independentes. Encaminhamentos iniciam outra conversa. O histórico nunca inclui mensagens que a sessão não enviou ou recebeu, mesmo para destinatários adicionados posteriormente.

## Listagens e sincronização

Listagens aceitam `offset` (padrão 0), `limit` (1–50, padrão 50) e `q` (busca de até 100 caracteres). Retornam `messages`, `total`, `offset`, `limit`, `hasMore`, `cursor` e `totals`. O corpo completo está somente em `GET /messages/:id`. Estrela/leitura/lixeira/pasta são individuais.

Com `view=threads`, listagens paginam conversas e retornam uma linha por conversa, com `threadCount`, participantes remetentes visíveis, assunto original, prévia mais recente e totais por conversa. A busca consulta apenas mensagens acessíveis. `GET /messages/:id/thread` retorna `id`, `subject` e `messages` em ordem cronológica, com os corpos completos e metadados autorizados de cada mensagem. `view=threads` também faz a sincronização retornar totais por conversa; os eventos continuam sendo por mensagem.

`GET /messages/sync?cursor=N` retorna `cursor`, `reset`, alterações e totais. Cada evento identifica criação/atualização/exclusão e sua mensagem segura; exclusões usam mensagem nula. O cursor é crescente por usuário. Quando o cursor é antigo demais, `reset: true` exige recarregar a listagem; não tente inferir mensagens ausentes.

## Alterações e atividades

```json
{ "read": true }
```

Para estrela: `{ "starred": true }`. Para pasta: `{ "location": "inbox" }`, com opções `inbox`, `archive`, `spam`, `snoozed`. Lixeira, restauração e exclusão não precisam de corpo. Restaurar conserva a pasta anterior à lixeira.

Professor publica:

```json
{
  "title": "Minha primeira mensagem",
  "requiredSubject": "Atividade 01",
  "instructions": "Envie ao professor uma saudação e o que aprendeu."
}
```

Se `requiredSubject` não for informado, usa o título. A atividade e a lista de participação pertencem somente à sala autenticada. O painel do professor não retorna conteúdo de conversas privadas.

## Erros

JSON de sucesso: `{ "success": true, "data": {} }`. Erro: `{ "success": false, "error": { "code": "...", "message": "..." } }`.

| Status | Significado |
| --- | --- |
| 200 / 201 | Operação concluída / recurso criado |
| 400 | Campos, destinatários, JSON ou tipo/conteúdo de anexo inválidos |
| 401 | Sessão ausente, expirada ou invalidada |
| 403 | Operação exclusiva do professor ou origem incompatível |
| 404 | Recurso inexistente ou sem acesso nesta caixa/sala |
| 409 | Identificador reservado, professor existente, chave de envio conflitante ou exclusão fora da lixeira |
| 413 | Tamanho/quantidade de arquivos ou requisição acima do limite |
| 429 | Limite de frequência ou capacidade; limites de frequência incluem `Retry-After` |
| 500 | Falha interna; detalhes não são expostos ao cliente |

Respostas da API usam `Cache-Control: no-store`. Download usa `Content-Disposition: attachment` e `X-Content-Type-Options: nosniff`, conservando a autenticação e o acesso por cópia.

import 'dotenv/config';

export function createConfig(env = process.env) {
  const number = (key, fallback, min = 1) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isSafeInteger(value) || value < min) throw new Error(`Configuração inválida: ${key}`);
    return value;
  };
  const config = {
    production: env.NODE_ENV === 'production',
    trustProxy: number('TRUST_PROXY', 0, 0),
    offlineTimeout: number('USER_OFFLINE_TIMEOUT', 15000),
    activeTimeout: number('USER_ACTIVE_TIMEOUT', 60000),
    sessionTimeout: number('USER_SESSION_TIMEOUT', 1800000),
    roomCleanupTimeout: number('ROOM_CLEANUP_TIMEOUT', 1800000),
    cleanupInterval: number('CLEANUP_INTERVAL', 10000),
    pollMessagesInterval: number('POLL_MESSAGES_INTERVAL', 2000, 500),
    pollUsersInterval: number('POLL_USERS_INTERVAL', 3000, 500),
    pollActivitiesInterval: number('POLL_ACTIVITIES_INTERVAL', 5000, 500),
    heartbeatInterval: number('HEARTBEAT_INTERVAL', 5000, 500),
    maxMessageLength: number('MAX_MESSAGE_LENGTH', 10000),
    maxAttachmentSize: number('MAX_ATTACHMENT_SIZE', 2 * 1024 * 1024),
    maxAttachments: number('MAX_ATTACHMENTS', 3),
    maxRecipients: number('MAX_RECIPIENTS', 30),
    maxRooms: number('MAX_ROOMS', 100),
    maxUsersPerRoom: number('MAX_USERS_PER_ROOM', 150),
    maxMessagesPerRoom: number('MAX_MESSAGES_PER_ROOM', 3000),
    maxUploadBytes: number('MAX_UPLOAD_BYTES', 256 * 1024 * 1024),
    maxConcurrentUploads: number('MAX_CONCURRENT_UPLOADS', 8),
    joinRateLimit: number('JOIN_RATE_LIMIT', 300),
    joinRateWindow: number('JOIN_RATE_WINDOW', 300000),
    messageRateLimit: number('MESSAGE_RATE_LIMIT', 10),
    heartbeatRateLimit: number('HEARTBEAT_RATE_LIMIT', 30),
    changesLimit: 1000,
  };
  if (config.offlineTimeout >= config.activeTimeout || config.activeTimeout >= config.sessionTimeout) {
    throw new Error('Os timeouts devem obedecer: offline < ativo < sessão.');
  }
  if (config.heartbeatInterval >= config.offlineTimeout) throw new Error('Heartbeat deve ser menor que o timeout offline.');
  return config;
}

export function clientConfig(config) {
  return {
    pollMessagesInterval: config.pollMessagesInterval,
    pollUsersInterval: config.pollUsersInterval,
    pollActivitiesInterval: config.pollActivitiesInterval,
    heartbeatInterval: config.heartbeatInterval,
    maxMessageLength: config.maxMessageLength,
    maxAttachmentSize: config.maxAttachmentSize,
    maxAttachments: config.maxAttachments,
    maxRecipients: config.maxRecipients,
  };
}

import { randomBytes, randomUUID } from 'node:crypto';
import { AppError } from '../utils/errors.js';
import { normalizeRoom, normalizeUsername, text } from '../utils/validation.js';

export class RoomService {
  constructor(store, config) { this.store = store; this.config = config; }
  join(input) {
    this.store.cleanup();
    const name = text(input.name, 'Nome', 50);
    const key = normalizeRoom(input.room);
    const role = input.role ?? 'student';
    if (!['teacher', 'student'].includes(role)) throw new AppError(400, 'INVALID_ROLE', 'Perfil inválido.');
    const username = role === 'teacher' ? 'professor' : normalizeUsername(input.username);
    if (role === 'student' && username === 'professor') throw new AppError(409, 'RESERVED_USERNAME', 'O identificador professor é reservado ao professor da sala.');
    let room = this.store.rooms.get(key);
    if (!room && this.store.rooms.size >= this.config.maxRooms) throw new AppError(429, 'ROOM_LIMIT', 'O servidor atingiu o limite de salas temporárias.');
    if (room?.usernames.has(username)) throw new AppError(409, 'USERNAME_ALREADY_EXISTS', role === 'teacher'
      ? 'Já existe um professor nesta sala. Recupere a sessão anterior ou aguarde sua expiração.'
      : 'Este identificador já está sendo utilizado nesta sala.');
    if (room && room.users.size >= this.config.maxUsersPerRoom) throw new AppError(429, 'USER_LIMIT', 'Esta sala atingiu o limite de participantes.');
    room ??= this.store.createRoom(key);
    const user = {
      id: randomUUID(), token: randomBytes(32).toString('base64url'), name, username,
      email: `${username}@${key}.local`, room: key, role, lastSeen: this.store.now(),
      mailbox: new Map(), revision: 0, changes: [], idempotency: new Map(),
    };
    room.users.set(user.id, user);
    room.usernames.set(username, user.id);
    room.emptySince = null;
    this.store.sessions.set(user.token, user);
    const activity = room.activities.get(room.currentActivityId);
    if (role === 'student' && activity && !activity.closed) this.addParticipant(activity, user);
    return user;
  }
  addParticipant(activity, user) {
    if (!activity.participants.has(user.id)) activity.participants.set(user.id, {
      id: user.id, name: user.name, email: user.email, delivered: false, deliveredAt: null,
    });
  }
  authenticate(token) {
    const user = this.store.sessions.get(token);
    if (!user || this.store.now() - user.lastSeen >= this.config.sessionTimeout) {
      if (user) this.store.removeUser(user);
      throw new AppError(401, 'SESSION_EXPIRED', 'Sua sessão expirou ou o servidor reiniciou. Entre novamente na sala.');
    }
    return user;
  }
  publicUser(user) {
    return {
      id: user.id, name: user.name, username: user.username, email: user.email,
      room: user.room.toUpperCase(), role: user.role,
      online: this.store.now() - user.lastSeen < this.config.offlineTimeout,
    };
  }
  current(user) {
    const room = this.store.rooms.get(user.room);
    return { user: this.publicUser(user), room: { name: room.name, createdAt: room.createdAt }, instanceId: this.store.instanceId };
  }
  users(user) {
    this.store.cleanup();
    const room = this.store.rooms.get(user.room);
    const directory = [...room.users.values()].map(item => this.publicUser(item));
    const users = directory.filter(item => this.store.now() - room.users.get(item.id).lastSeen < this.config.activeTimeout);
    return { users, directory, onlineCount: directory.filter(item => item.online).length };
  }
  heartbeat(user) {
    user.lastSeen = this.store.now();
    this.store.rooms.get(user.room).emptySince = null;
    return { online: true, serverTime: this.store.now() };
  }
  leave(user) { this.store.removeUser(user); return { left: true }; }
}

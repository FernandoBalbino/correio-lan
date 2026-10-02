import { randomUUID } from 'node:crypto';

// Somente uma instância/processo. Um restart descarta todo o estado pedagógico.
export class MemoryStore {
  constructor({ config, now = Date.now }) {
    this.config = config;
    this.now = now;
    this.instanceId = randomUUID();
    this.rooms = new Map();
    this.sessions = new Map();
  }
  createRoom(key) {
    const room = {
      key, name: key.toUpperCase(), createdAt: this.now(), emptySince: null,
      users: new Map(), usernames: new Map(), messages: new Map(), activities: new Map(),
      currentActivityId: null, sentCount: 0, deliveredCount: 0,
    };
    this.rooms.set(key, room);
    return room;
  }
  recordChange(user, messageId, kind) {
    user.revision += 1;
    user.changes.push({ revision: user.revision, messageId, kind });
    if (user.changes.length > this.config.changesLimit) user.changes.shift();
  }
  removeUser(user) {
    const room = this.rooms.get(user.room);
    if (!room) return;
    this.sessions.delete(user.token);
    room.users.delete(user.id);
    room.usernames.delete(user.username);
    if (user.role === 'teacher' && room.currentActivityId) {
      const activity = room.activities.get(room.currentActivityId);
      if (activity?.teacherId === user.id) activity.closed = true;
    }
    for (const [id, message] of room.messages) {
      message.copies.delete(user.id);
      if (!message.copies.size) room.messages.delete(id);
    }
  }
  cleanup() {
    const now = this.now();
    for (const room of this.rooms.values()) {
      for (const user of room.users.values()) {
        if (now - user.lastSeen >= this.config.sessionTimeout) this.removeUser(user);
      }
      const active = [...room.users.values()].some(user => now - user.lastSeen < this.config.activeTimeout);
      room.emptySince = active ? null : (room.emptySince ?? now);
      if (room.emptySince !== null && now - room.emptySince >= this.config.roomCleanupTimeout) {
        for (const user of room.users.values()) this.sessions.delete(user.token);
        this.rooms.delete(room.key);
      }
    }
  }
}

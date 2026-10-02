import { randomUUID } from 'node:crypto';
import { AppError } from '../utils/errors.js';
import { text } from '../utils/validation.js';

export class ActivityService {
  constructor(store, roomService) { this.store = store; this.roomService = roomService; }
  requireTeacher(user) { if (user.role !== 'teacher') throw new AppError(403, 'TEACHER_REQUIRED', 'Esta ação é exclusiva do professor.'); }
  publish(user, input) {
    this.requireTeacher(user);
    const room = this.store.rooms.get(user.room);
    if (room.activities.size >= 100) throw new AppError(429, 'ACTIVITY_LIMIT', 'Limite de atividades temporárias atingido.');
    const activity = {
      id: randomUUID(), title: text(input.title, 'Título', 100),
      instructions: text(input.instructions, 'Instruções', 10000, { multiline: true }),
      requiredSubject: text(input.requiredSubject || input.title, 'Assunto obrigatório', 100),
      teacherId: user.id, teacherEmail: user.email, createdAt: this.store.now(), participants: new Map(), closed: false,
    };
    for (const student of room.users.values()) if (student.role === 'student') this.roomService.addParticipant(activity, student);
    const previous = room.activities.get(room.currentActivityId);
    if (previous) previous.closed = true;
    room.activities.set(activity.id, activity); room.currentActivityId = activity.id;
    return this.current(user);
  }
  current(user) {
    const room = this.store.rooms.get(user.room);
    const activity = room.activities.get(room.currentActivityId);
    if (!activity) return null;
    const { participants, teacherId, ...safe } = activity;
    return { ...safe, delivered: participants.get(user.id)?.delivered ?? false };
  }
  status(user) {
    this.requireTeacher(user);
    const room = this.store.rooms.get(user.room);
    const activity = room.activities.get(room.currentActivityId);
    const participants = activity ? [...activity.participants.values()] : [];
    const delivered = participants.filter(item => item.delivered).length;
    return { activity: this.current(user), participants, delivered, pending: participants.length - delivered,
      total: participants.length, onlineStudents: [...room.users.values()].filter(item => item.role === 'student'
        && this.store.now() - item.lastSeen < this.store.config.offlineTimeout).length,
      sentCount: room.sentCount, deliveredCount: room.deliveredCount, createdAt: room.createdAt };
  }
}

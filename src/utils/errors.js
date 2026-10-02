export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

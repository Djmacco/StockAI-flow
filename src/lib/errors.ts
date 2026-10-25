/**
 * Errors carry a translation key + params so the UI can show a clear message
 * in the user's language (never a bare "Error 500").
 */
export class AppError extends Error {
  constructor(public key: string, public params: Record<string, string | number> = {}) {
    super(key);
    this.name = 'AppError';
  }
}
export const fail = (key: string, params?: Record<string, string | number>): never => {
  throw new AppError(key, params);
};

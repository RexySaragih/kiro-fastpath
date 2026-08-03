import { AuthService } from './auth';

export const svc = new AuthService();

export async function boot(): Promise<string> {
  return svc.login({ email: 'a@b.com', password: 'longenough' });
}

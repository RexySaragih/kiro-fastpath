export interface Credentials {
  email: string;
  password: string;
}

export class AuthService {
  async login(credentials: Credentials): Promise<string> {
    return this.validateJwt(credentials.email);
  }

  validateJwt(token: string): string {
    return `jwt:${token}`;
  }
}

export function authenticateUser(email: string, password: string): boolean {
  return email.includes('@') && password.length > 8;
}

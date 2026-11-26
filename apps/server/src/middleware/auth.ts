import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { AccountRole } from '@ptc/shared';

export interface AuthUser {
  accountId: string;
  username: string;
  role: AccountRole;
  staffId: string | null;
  studentId: string | null;
  isPublicGuest: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const getJwtSecret = (): string => process.env.JWT_SECRET || 'dev-practice-secret';
export const isPublicDemoMode = (): boolean => process.env.PUBLIC_DEMO_MODE !== 'false';

export function signAuthToken(user: Omit<AuthUser, 'isPublicGuest'>): string {
  return jwt.sign(user, getJwtSecret(), { expiresIn: '7d' });
}

export function verifyAuthToken(token: string): AuthUser | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret()) as Omit<AuthUser, 'isPublicGuest'>;
    return { ...decoded, isPublicGuest: false };
  } catch {
    return null;
  }
}

export function attachAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const parsed = verifyAuthToken(header.slice(7).trim());
    if (parsed) {
      req.user = parsed;
      next();
      return;
    }
  }

  // Practice/Public mode: allow direct public access as scheduler/admin without requiring login first
  if (isPublicDemoMode()) {
    const roleOverride = req.headers['x-demo-role'] as AccountRole | undefined;
    const validRoles: AccountRole[] = ['admin', 'scheduler', 'teacher', 'student', 'viewer'];
    req.user = {
      accountId: 'public-demo',
      username: 'public-demo',
      role: roleOverride && validRoles.includes(roleOverride) ? roleOverride : 'admin',
      staffId: null,
      studentId: null,
      isPublicGuest: true,
    };
  }
  next();
}

export function requireRole(...allowed: AccountRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isPublicDemoMode()) {
      next();
      return;
    }
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!allowed.includes(req.user.role)) {
      res.status(403).json({ error: 'Forbidden for role ' + req.user.role });
      return;
    }
    next();
  };
}

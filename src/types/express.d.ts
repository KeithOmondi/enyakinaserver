// Request augmentation, populated by middleware/auth.ts:
//   authenticate -> req.user
//   tenant       -> req.businessId, req.role
export type Role = 'super_admin' | 'admin' | 'shop_manager';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  isSuperAdmin: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      businessId?: string;
      role?: Role;
    }
  }
}

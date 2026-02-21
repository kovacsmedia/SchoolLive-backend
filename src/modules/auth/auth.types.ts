export type JwtPayload = {
  sub: string;          // userId
  role: string;
  tenantId: string | null;
};

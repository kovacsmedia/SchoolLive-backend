export interface JwtPayload {
  sub:        string;
  role:       string;
  tenantId:   string | null;
  sessionId?: string;
}
export interface JwtPayload {
  sub:        string;
  role:       string;
  tenantId:   string | null;
  tenantName?: string | null;
  sessionId?: string;
}
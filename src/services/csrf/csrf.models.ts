export interface CsrfToken {
  headerName: string;
  parameterName: string;
  token: string;
  expirationTime: number; // Epoch milliseconds when the token expires
}

export interface CsrfTokenResponse {
  headerName: string;
  parameterName: string;
  token: string;
  expirationTime?: number; // Optional: epoch milliseconds when the token expires
}

export interface CsrfError {
  message: string;
  code?: string;
  status?: number;
}

export const CSRF_TOKEN_EXPIRATION_BUFFER = 5 * 60 * 1000; // 5 minutes before expiration
export const CSRF_RETRY_DELAYS = [1000, 2000, 5000, 10000]; // Exponential backoff in ms
export const CSRF_MAX_RETRY_ATTEMPTS = 3;

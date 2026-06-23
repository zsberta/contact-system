import {
  CsrfToken,
  CsrfTokenResponse,
  CsrfError,
  CSRF_TOKEN_EXPIRATION_BUFFER,
  CSRF_RETRY_DELAYS,
  CSRF_MAX_RETRY_ATTEMPTS,
} from "./csrf.models";

/**
 * CSRF Token Service for React
 * Manages CSRF tokens fetched from backend API
 * Singleton pattern for app-wide token management
 */
class CsrfTokenServiceClass {
  private currentToken: CsrfToken | null = null;
  private expirationTime: number = 0;
  private isRefreshing: boolean = false;
  private refreshRetryCount = 0;
  private refreshPromise: Promise<CsrfToken> | null = null;
  private listeners: Set<(token: CsrfToken | null) => void> = new Set();
  private isInitialized: boolean = false;
  private initPromise: Promise<void> | null = null;
  private autoRefreshInterval: number | null = null;

  // API endpoints
  private readonly CSRF_ENDPOINT = "/api/csrf";
  private readonly CSRF_REFRESH_ENDPOINT = "/api/csrf/refresh";

  /**
   * Subscribe to token changes
   */
  subscribe(callback: (token: CsrfToken | null) => void): () => void {
    this.listeners.add(callback);
    // Immediately call with current token
    callback(this.currentToken);

    // Return unsubscribe function
    return () => {
      this.listeners.delete(callback);
    };
  }

  /**
   * Notify all listeners of token change
   */
  private notifyListeners(): void {
    this.listeners.forEach((callback) => callback(this.currentToken));
  }

  /**
   * Initialize the service by fetching a token and starting auto-refresh
   * This should be called when the application starts
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    if (this.initPromise != null) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize();

    try {
      await this.initPromise;
      this.isInitialized = true;
    } finally {
      this.initPromise = null;
    }
  }

  /**
   * Internal initialization method
   */
  private async doInitialize(): Promise<void> {
    try {
      await this.fetchToken();
      this.initializeAutoRefresh();
    } catch (error) {
      console.error("[CsrfTokenService] Initialization failed:", error);
      throw error;
    }
  }

  /**
   * Get the current CSRF token synchronously (returns null if not available)
   */
  getToken(): CsrfToken | null {
    return this.currentToken;
  }

  /**
   * Ensure a valid token is available by fetching a fresh token from the server.
   * Always fetches a new token from /csrf endpoint - the backend generates a fresh token
   * on every call, so we should always get the latest.
   * This method will wait for initialization to complete.
   */
  async ensureValidToken(): Promise<CsrfToken> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    return this.fetchToken();
  }

  /**
   * Fetch a new CSRF token from the backend
   */
  async fetchToken(): Promise<CsrfToken> {
    // If already refreshing, return the existing promise
    if (this.isRefreshing && this.refreshPromise != null) {
      return this.refreshPromise;
    }

    this.isRefreshing = true;
    this.refreshPromise = this.doFetchToken();

    try {
      const token = await this.refreshPromise;
      return token;
    } finally {
      this.isRefreshing = false;
      this.refreshPromise = null;
    }
  }

  /**
   * Internal method to fetch token
   */
  private async doFetchToken(): Promise<CsrfToken> {
    try {
      const response = await fetch(this.CSRF_ENDPOINT, {
        method: "GET",
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch CSRF token: ${response.status} ${response.statusText}`,
        );
      }

      const data: CsrfTokenResponse = await response.json();
      const token: CsrfToken = {
        headerName: data.headerName,
        parameterName: data.parameterName,
        token: data.token,
        expirationTime: data.expirationTime || Date.now() + 24 * 60 * 60 * 1000, // Fallback: 24 hours
      };

      this.updateToken(token);
      this.refreshRetryCount = 0;

      return token;
    } catch (error) {
      console.error("[CsrfTokenService] Failed to fetch token:", error);
      throw error;
    }
  }

  /**
   * Refresh the current CSRF token
   */
  async refreshToken(): Promise<CsrfToken> {
    // If already refreshing, return the existing promise
    if (this.isRefreshing && this.refreshPromise != null) {
      return this.refreshPromise;
    }

    this.isRefreshing = true;
    this.refreshPromise = this.doRefreshToken();

    try {
      const token = await this.refreshPromise;
      return token;
    } finally {
      this.isRefreshing = false;
      this.refreshPromise = null;
    }
  }

  /**
   * Internal method to refresh token
   */
  private async doRefreshToken(): Promise<CsrfToken> {
    try {
      const response = await fetch(this.CSRF_REFRESH_ENDPOINT, {
        method: "POST",
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(
          `Failed to refresh CSRF token: ${response.status} ${response.statusText}`,
        );
      }

      const data: CsrfTokenResponse = await response.json();
      const token: CsrfToken = {
        headerName: data.headerName,
        parameterName: data.parameterName,
        token: data.token,
        expirationTime: data.expirationTime || Date.now() + 24 * 60 * 60 * 1000, // Fallback: 24 hours
      };

      this.updateToken(token);
      this.refreshRetryCount = 0;

      return token;
    } catch (error) {
      console.error("[CsrfTokenService] Failed to refresh token:", error);
      throw error;
    }
  }

  /**
   * Handle 403 CSRF errors with automatic retry
   */
  async handle403Error(): Promise<CsrfToken> {
    if (this.refreshRetryCount >= CSRF_MAX_RETRY_ATTEMPTS) {
      this.refreshRetryCount = 0;
      throw new Error("Max retry attempts reached for CSRF token refresh");
    }

    const delay =
      CSRF_RETRY_DELAYS[
        Math.min(this.refreshRetryCount, CSRF_RETRY_DELAYS.length - 1)
      ];
    this.refreshRetryCount++;

    await this.sleep(delay);

    try {
      return await this.fetchToken();
    } catch (error) {
      console.error(
        `[CsrfTokenService] Retry ${this.refreshRetryCount} failed:`,
        error,
      );
      if (this.refreshRetryCount >= CSRF_MAX_RETRY_ATTEMPTS) {
        this.refreshRetryCount = 0;
        throw error;
      }
      return this.handle403Error();
    }
  }

  /**
   * Update the current token and set expiration
   */
  private updateToken(token: CsrfToken): void {
    this.currentToken = token;
    this.expirationTime = token.expirationTime;
    this.notifyListeners();
  }

  /**
   * Check if the token is valid (not expired)
   */
  private isTokenValid(): boolean {
    if (!this.currentToken) {
      return false;
    }
    const now = Date.now();
    return now < this.expirationTime - CSRF_TOKEN_EXPIRATION_BUFFER;
  }

  /**
   * Get time until token expires (in milliseconds)
   */
  getTimeUntilExpiration(): number {
    if (!this.currentToken) {
      return 0;
    }
    return Math.max(0, this.expirationTime - Date.now());
  }

  /**
   * Sleep utility for delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Initialize automatic token refresh timer
   * This method sets up an interval to check and refresh the token before expiration
   */
  initializeAutoRefresh(): void {
    // Clear any existing interval to avoid duplicates
    if (this.autoRefreshInterval !== null) {
      clearInterval(this.autoRefreshInterval);
    }

    // Check every minute if token needs refresh
    this.autoRefreshInterval = window.setInterval(() => {
      const timeUntilExpiration = this.getTimeUntilExpiration();
      const minutesUntilExpiration = timeUntilExpiration / 1000 / 60;

      // Refresh if token expires in less than 30 minutes
      if (minutesUntilExpiration < 30 && !this.isRefreshing) {
        this.refreshToken().catch((error) => {
          console.error("[CsrfTokenService] Auto-refresh failed:", error);
        });
      }
    }, 60000); // Every minute
  }

  /**
   * Stop the auto-refresh timer
   * Useful for cleanup or testing
   */
  stopAutoRefresh(): void {
    if (this.autoRefreshInterval !== null) {
      clearInterval(this.autoRefreshInterval);
      this.autoRefreshInterval = null;
    }
  }

  /**
   * Cleanup method (call on logout)
   */
  destroy(): void {
    this.stopAutoRefresh();
    this.currentToken = null;
    this.expirationTime = 0;
    this.isInitialized = false;
    this.listeners.clear();
  }
}

// Export singleton instance
export const CsrfTokenService = new CsrfTokenServiceClass();

// Export type for TypeScript
export type { CsrfTokenServiceClass as CsrfTokenServiceType };

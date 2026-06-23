import {
  JwtAuthenticationResponse,
  SigninRequest,
  UserDetailsDTO,
} from "@/types/auth";
import { CsrfTokenService } from "@/services/csrf";
import { QueryParams as CommonQueryParams } from "@/types/common";
import type { Page } from "@/types/common";
import {
  UserCreateUpdateDTO,
  UserDetails,
  UserDTO,
} from "@/types/user";

// Use relative path so Vite proxy can handle CORS
const API_BASE_URL = "/api";

interface ApiError {
  message: string;
  status: number;
}

// Flag to prevent multiple CSRF refresh attempts
let isCsrfRefreshing = false;
// Queue of requests to retry after CSRF refresh
let csrfRefreshQueue: Array<{
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  endpoint: string;
  options: RequestInit;
}> = [];

// Flag to prevent multiple JWT refresh attempts
let isJwtRefreshing = false;
// Queue of requests to retry after JWT refresh
let jwtRefreshQueue: Array<{
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  endpoint: string;
  options: RequestInit;
}> = [];

// Helper function for API calls
export async function apiFetch<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  // endpoint already starts with / (e.g., /auth/signin)
  const url = `${API_BASE_URL}${endpoint}`;

  const headers = {
    "Content-Type": "application/json",
    ...options.headers,
  };

  const attemptFetch = async (): Promise<T> => {
    // CSRF Token Handling: Add CSRF header for state-changing requests using CsrfTokenService
    // The CsrfTokenService manages token retrieval and caching
    const requestHeaders: HeadersInit = { ...headers };
    const method = options.method?.toUpperCase() || "GET";

    // Only add CSRF token for state-changing methods (POST, PUT, DELETE, PATCH)
    // Skip CSRF for login endpoint - standard security practice
    if (["POST", "PUT", "DELETE", "PATCH"].includes(method)) {
      const isPublicAuthEndpoint = endpoint.includes("/auth/signin");
      if (!isPublicAuthEndpoint) {
        const csrfToken = await CsrfTokenService.ensureValidToken();
        if (csrfToken) {
          (requestHeaders as Record<string, string>)[csrfToken.headerName] =
            csrfToken.token;
        }
      }
    }

    const response = await fetch(url, {
      ...options,
      headers: requestHeaders,
      credentials: "include", // Send cookies automatically
    });

    // Handle 403 CSRF errors with automatic retry
    if (
      response.status === 403 &&
      ["POST", "PUT", "DELETE", "PATCH"].includes(method)
    ) {
      console.warn(
        "[apiFetch] CSRF validation failed, attempting token refresh...",
      );

      // If already refreshing, queue this request
      if (isCsrfRefreshing) {
        return new Promise<T>((resolve, reject) => {
          csrfRefreshQueue.push({ resolve, reject, endpoint, options });
        });
      }

      try {
        isCsrfRefreshing = true;

        // Refresh token
        await CsrfTokenService.handle403Error();

        // Get the new token
        const newToken = CsrfTokenService.getToken();
        if (newToken) {
          (requestHeaders as Record<string, string>)[newToken.headerName] =
            newToken.token;

          // Retry the original request with new token
          const retryResponse = await fetch(url, {
            ...options,
            headers: requestHeaders,
            credentials: "include",
          });

          // Process all queued requests with the new token
          const queuedPromises = csrfRefreshQueue.map(
            async ({ resolve, reject, endpoint, options }) => {
              try {
                const queuedUrl = `${API_BASE_URL}${endpoint}`;
                const queuedResponse = await fetch(queuedUrl, {
                  ...options,
                  headers: {
                    ...requestHeaders,
                    [newToken.headerName]: newToken.token,
                  },
                  credentials: "include",
                });

                if (!queuedResponse.ok) {
                  return reject(
                    new Error(
                      `Queued request failed: ${queuedResponse.statusText}`,
                    ),
                  );
                }

                const text = await queuedResponse.text();
                if (!text) return resolve(null as T);
                try {
                  resolve(JSON.parse(text) as T);
                } catch (e) {
                  resolve(text as unknown as T);
                }
              } catch (error) {
                reject(error);
              }
            },
          );

          csrfRefreshQueue = [];
          await Promise.all(queuedPromises);

          if (!retryResponse.ok) {
            const error: ApiError = {
              message: `API call failed after token refresh: ${retryResponse.statusText}`,
              status: retryResponse.status,
            };
            try {
              const errorBody = await retryResponse.json();
              error.message =
                errorBody.errorMessage || errorBody.message || error.message;
            } catch (e) {
              // Ignore if response body is not JSON
            }
            throw error;
          }

          console.log("[apiFetch] Request succeeded after token refresh");

          // Handle 204 No Content
          if (retryResponse.status === 204) {
            return null as T;
          }

          const text = await retryResponse.text();
          if (!text) {
            return null as T;
          }
          try {
            return JSON.parse(text) as T;
          } catch (e) {
            return text as unknown as T;
          }
        }
      } catch (error) {
        // Reject all queued requests
        csrfRefreshQueue.forEach(({ reject }) => reject(error));
        csrfRefreshQueue = [];
        throw error;
      } finally {
        isCsrfRefreshing = false;
      }
    }

    if (response.status === 401) {
      // If we're already refreshing, queue this request
      if (isJwtRefreshing) {
        return new Promise<T>((resolve, reject) => {
          jwtRefreshQueue.push({ resolve, reject, endpoint, options });
        });
      }

      // Try to refresh token
      try {
        isJwtRefreshing = true;
        await refreshAuthToken();

        // Retry original request
        const retryResponse = await fetch(url, {
          ...options,
          headers: requestHeaders,
          credentials: "include",
        });

        if (!retryResponse.ok) {
          const error: ApiError = {
            message: `API call failed: ${retryResponse.statusText}`,
            status: retryResponse.status,
          };
          try {
            const errorBody = await retryResponse.json();
            error.message =
              errorBody.errorMessage || errorBody.message || error.message;
          } catch (e) {
            // Ignore if response body is not JSON
          }
          throw error;
        }

        // Process all queued requests
        const queuedPromises = jwtRefreshQueue.map(
          async ({ resolve, reject, endpoint, options }) => {
            try {
              const queuedUrl = `${API_BASE_URL}${endpoint}`;
              const queuedResponse = await fetch(queuedUrl, {
                ...options,
                headers: requestHeaders,
                credentials: "include",
              });

              if (!queuedResponse.ok) {
                const error: ApiError = {
                  message: `API call failed: ${queuedResponse.statusText}`,
                  status: queuedResponse.status,
                };
                try {
                  const errorBody = await queuedResponse.json();
                  error.message =
                    errorBody.errorMessage ||
                    errorBody.message ||
                    error.message;
                } catch (e) {
                  // Ignore if response body is not JSON
                }
                return reject(error);
              }

              const text = await queuedResponse.text();
              if (!text) {
                return resolve(null as T);
              }
              try {
                resolve(JSON.parse(text) as T);
              } catch (e) {
                resolve(text as unknown as T);
              }
            } catch (error) {
              reject(error);
            }
          },
        );

        // Clear queue
        jwtRefreshQueue = [];

        // Wait for all queued requests to complete
        await Promise.all(queuedPromises);

        // Process original successful response
        const text = await retryResponse.text();
        if (!text) {
          return null as T;
        }
        try {
          return JSON.parse(text) as T;
        } catch (e) {
          return text as unknown as T;
        }
      } catch (refreshError) {
        // Refresh failed, reject all queued requests
        jwtRefreshQueue.forEach(({ reject }) => reject(refreshError));
        jwtRefreshQueue = [];

        // Throw refresh error
        throw refreshError;
      } finally {
        isJwtRefreshing = false;
      }
    }

    if (!response.ok) {
      const error: ApiError = {
        message: `API call failed: ${response.statusText}`,
        status: response.status,
      };
      try {
        const errorBody = await response.json();
        error.message =
          errorBody.errorMessage || errorBody.message || error.message;
      } catch (e) {
        // Ignore if response body is not JSON
      }
      throw error;
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return null as T;
    }

    const text = await response.text();
    if (!text) {
      return null as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch (e) {
      // If it's not JSON, return text if T is string, otherwise throw
      // This is a bit loose but handles "unexpected end of json" if it was empty (handled above)
      // or if it is just a plain string response.
      return text as unknown as T;
    }
  };

  return attemptFetch();
}

// Function to refresh auth token using HttpOnly cookie
async function refreshAuthToken(): Promise<void> {
  try {
    const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: "POST",
      credentials: "include",
    });

    if (!response.ok) {
      throw new Error("Token refresh failed");
    }

    // The server will automatically update http-only cookies via Set-Cookie header
    return;
  } catch (error) {
    console.error("Token refresh failed:", error);
    throw error;
  }
}

// Helper function to build query string from parameters
export function buildQueryString(params: CommonQueryParams): string {
  const query = new URLSearchParams();
  if (params.page !== undefined) query.append("page", String(params.page));
  if (params.size !== undefined) query.append("size", String(params.size));
  if (params.sortField) query.append("sortField", params.sortField);
  if (params.sortOrder) query.append("sortOrder", params.sortOrder);
  if (params.filterType) query.append("filterType", params.filterType);
  if (params.status) query.append("status", params.status);
  if (params.locationType) query.append("locationType", params.locationType);
  if (params.locationId !== undefined)
    query.append("locationId", String(params.locationId));
  if (params.queries && params.queries.length > 0) {
    params.queries.forEach((q) => query.append("queries", q));
  }
  return query.toString();
}

// Helper function for file uploads (multipart/form-data)
export async function apiUpload<T>(
  endpoint: string,
  formData: FormData,
  method: "POST" | "PUT" = "POST",
  queryParams: Record<string, string> = {},
): Promise<T> {
  const query = new URLSearchParams(queryParams).toString();
  const url = `${API_BASE_URL}${endpoint}${query ? `?${query}` : ""}`;

  const response = await fetch(url, {
    method: method,
    body: formData,
    credentials: "include", // Send cookies automatically
  });

  if (!response.ok) {
    const error: ApiError = {
      message: `API upload failed: ${response.statusText}`,
      status: response.status,
    };
    try {
      const errorBody = await response.json();
      error.message =
        errorBody.errorMessage || errorBody.message || error.message;
    } catch (e) {
      // Ignore if response body is not JSON
    }
    throw error;
  }

  if (response.status === 204) {
    return null as T;
  }

  return response.json() as Promise<T>;
}

// --- Auth specific API calls ---

export async function signIn(
  credentials: SigninRequest,
): Promise<JwtAuthenticationResponse> {
  return apiFetch<JwtAuthenticationResponse>("/auth/signin", {
    method: "POST",
    body: JSON.stringify(credentials),
  });
}

export async function refreshToken(): Promise<JwtAuthenticationResponse> {
  return apiFetch<JwtAuthenticationResponse>("/auth/refresh", {
    method: "POST",
    credentials: "include",
  });
}

export async function validateSession(): Promise<{
  user: UserDetailsDTO | null;
}> {
  try {
    const response = await apiFetch<{ user: UserDetailsDTO }>("/auth/me", {
      method: "GET",
    });
    return response;
  } catch (error) {
    console.error("Session validation error:", error);
    // If validation fails, return null user
    return { user: null };
  }
}

export async function logout(): Promise<void> {
  return apiFetch<void>("/auth/logout", {
    method: "POST",
  });
}

// --- User management API calls ---

export const getAllUsersPaged = (
  params: CommonQueryParams = {},
): Promise<Page<UserDTO>> => {
  return apiFetch<Page<UserDTO>>(`/users?${buildQueryString(params)}`);
};

export const getUserById = (id: number): Promise<UserDetails> => {
  return apiFetch<UserDetails>(`/users/${id}`);
};

export const createUser = (
  data: UserCreateUpdateDTO,
): Promise<UserDetails> => {
  return apiFetch<UserDetails>("/users", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

export const updateUser = (
  id: number,
  data: UserCreateUpdateDTO,
): Promise<UserDetails> => {
  return apiFetch<UserDetails>(`/users/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
};

export const deleteUser = (id: number): Promise<void> => {
  return apiFetch<void>(`/users/${id}`, {
    method: "DELETE",
  });
};

import type { UserRole } from "./user";

export interface SigninRequest {
  identifier: string;
  password: string;
}

export interface UserDetailsDTO {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  enabled: boolean;
  role: UserRole;
  mustSetPassword: boolean;
  // Project assignments; [] for admins.
  projectIds: number[];
}

export interface JwtAuthenticationResponse {
  errorMessage: string | null;
  user: UserDetailsDTO | null;
  passwordChangeRequired: boolean;
}

export interface AuthState {
  isAuthenticated: boolean;
  user: UserDetailsDTO | null;
}

export interface ChangePasswordRequest {
  oldPassword: string;
  newPassword: string;
}

// Set-password (invite flow). Used by /set-password?token=… on a fresh
// invite. The token is in the URL query string and is bound to a single
// user.
export interface SetPasswordRequest {
  token: string;
  newPassword: string;
}

// Forgot-password. The server always returns 200; the optional message
// is the same regardless of whether the email exists.
export interface ForgotPasswordRequest {
  email: string;
}

export interface ForgotPasswordResponse {
  success: boolean;
  message: string;
}

// Reset-password. Used by /reset-password?token=… after the user clicks
// the link in the forgot-password email.
export interface ResetPasswordRequest {
  token: string;
  newPassword: string;
}

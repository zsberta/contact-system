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

import type { Page } from "./common";

export type UserRole = "admin" | "enduser";

export interface UserDTO {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  enabled: boolean;
  role: UserRole;
  mustSetPassword: boolean;
  createdAt: string;
  // Project assignments. Only meaningful for endusers; admins always get [].
  projectIds: number[];
}

// UserDetails is intentionally a structural alias of UserDTO in v1 — kept as a
// separate type so future fields (last login, lock state, etc.) can land without
// a sweeping type change across the FE.
export type UserDetails = UserDTO;

export interface UserCreateUpdateDTO {
  firstName: string;
  lastName: string;
  email: string;
  password?: string;
  enabled?: boolean;
  role?: UserRole;
}

export type PageUserDTO = Page<UserDTO>;

// Result of POST /api/users when creating an enduser. The server issues an
// invite and returns the plaintext token so the admin can copy it. The token
// is also emailed to the enduser.
export interface CreateUserResponse extends UserDTO {
  inviteToken?: string;
}

// Result of POST /api/users/:id/invite — re-issues an invite. The plaintext
// token is returned so the admin can copy it manually if the email didn't
// deliver.
export interface InviteIssuedResponse {
  inviteToken: string;
  expiresAt: string;
}

// Result of DELETE /api/users/:id/invite — revokes all outstanding invites.
export interface RevokeInviteResponse {
  revoked: number;
}

// Result of PUT /api/users/:id/projects — replaces the assignment set.
export interface ReplaceAssignmentsResponse {
  userId: number;
  projectIds: number[];
}

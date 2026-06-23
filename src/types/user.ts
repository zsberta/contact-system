import type { Page } from "./common";

export interface UserDTO {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  enabled: boolean;
  createdAt: string;
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
}

export type PageUserDTO = Page<UserDTO>;

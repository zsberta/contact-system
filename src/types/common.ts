export type PermissionAction = "READ" | "WRITE" | "DELETE" | "ALL";

export interface PermissionDTO {
  id: number;
  name: string;
  action: PermissionAction;
  displayNameHu?: string;
  displayNameEn?: string;
  tooltipHu?: string;
  tooltipEn?: string;
}

export interface RoleDTO {
  id: number;
  name: string;
}

export interface SortObject {
  sorted: boolean;
  unsorted: boolean;
  empty: boolean;
}

export interface PageableObject {
  paged: boolean;
  pageSize: number;
  pageNumber: number;
  unpaged: boolean;
  offset: number;
  sort: SortObject;
}

export interface Page<T> {
  totalPages: number;
  totalElements: number;
  pageable: PageableObject;
  numberOfElements: number;
  size: number;
  content: T[];
  number: number;
  sort: SortObject;
  first: boolean;
  last: boolean;
  empty: boolean;
}

export interface QueryParams {
  page?: number;
  size?: number;
  sortField?: string;
  sortOrder?: "asc" | "desc";
  queries?: string[];
  filterType?: "any" | "all";
  status?: string;
  locationType?: string;
  locationId?: number;
  projectId?: number;
}

export interface DocumentQueryParams extends QueryParams {
  documentType?: string;
  documentStatus?: string;
}

export type PageRoleDTO = Page<RoleDTO>;

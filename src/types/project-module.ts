export type ProjectModuleKind =
  | "form"
  | "reservation"
  | "blog"
  | "faq"
  | "service"
  | "analytics"
  | "ai-assistant";

export interface ProjectModuleDTO {
  id: number;
  projectId: number;
  kind: ProjectModuleKind;
  /** Source config ID for forms/reservations/analytics/ai; null for collections. */
  resourceId: number | null;
  label: string;
}

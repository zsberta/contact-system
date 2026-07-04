// Form DTOs (admin + public). Stripped down per ADR 0009:
//   - No `kind` / `nameI18n` (only one form purpose now)
//   - No `fields` / `consentRequired` / `customCss` (BE is opaque on data)
//   - `slug` is a kebab-case HUMAN label, distinct from `secretToken` which
//     is the credential used in API URLs.

export type FormStatus = "active" | "disabled";

// Admin: returned by GET /api/forms, GET /api/forms/:id, POST /api/forms,
// PUT /api/forms/:id.
export interface FormDTO {
  id: number;
  name: string;
  // `slug` is human-readable kebab-case label, immutable post-create.
  slug: string;
  // `secretToken` is the 22-char credential used in API URLs
  // (/api/public/forms/${secretToken}/submissions). Server-generated
  // at create time, immutable thereafter.
  secretToken: string;
  projectId: number;
  projectName: string;
  allowedOrigins: string[];
  status: FormStatus;
  createdAt: string;
  updatedAt: string;
}

// POST /api/forms body. `secretToken` is server-generated and not
// accepted here. `slug` must be unique across all forms.
export interface FormCreateDTO {
  name: string;
  slug: string;
  projectId: number;
  allowedOrigins: string[];
  status?: FormStatus;
}

// PUT /api/forms/:id body. `projectId` and `secretToken` are immutable
// post-create; the BE rejects any payload containing them (see
// routes/forms.js). `slug` is editable — collision → 409.
export interface FormUpdateDTO {
  name?: string;
  slug?: string;
  allowedOrigins?: string[];
  status?: FormStatus;
}

// Snippet response from GET /api/forms/:id/snippet.
export interface FormSnippetResponse {
  html: string;
  secretToken: string;
  slug: string;
  origin: string;
  allowedOrigins: string[];
}

// Single submission, returned by GET /api/forms/:id/submissions and
// GET /api/forms/:id/submissions/:submissionId. There is intentionally
// no field-snapshot field — forms have no schema to drift from.
export interface FormSubmissionDTO {
  id: number;
  formId: number;
  submittedAt: string;
  createdAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  referer: string | null;
  // Validated bag — plain JSONB. The BE knows nothing about field names.
  data: Record<string, unknown>;
  locale: string | null;
}

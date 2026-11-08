// Types for the nexus-gateway billing proxy (/api/gateway/*).
// The gateway wraps every response in { success, message, data, meta }.

export interface GatewayProject {
  id: string;
  name: string;
  is_active: boolean;
  /** Null = gateway master BILLINGO_BLOCK_ID. */
  billingo_block_id: string | null;
  email_company_name: string | null;
  email_contact_address: string | null;
  email_theme_color: string | null;
  email_language: string | null;
  created_at: string;
  updated_at: string;
}

export interface GatewayPagination {
  current_page: number;
  per_page: number;
  total: number;
  last_page: number;
}

export interface GatewayListResponse {
  success: boolean;
  message: string;
  data: GatewayProject[];
  meta: {
    version: string;
    timestamp: string;
    pagination: GatewayPagination;
  };
}

export interface GatewayProjectCreate {
  name: string;
  is_active?: boolean;
  /** Omitted = 1 year. Explicit null = never expires. */
  expires_in_days?: number | null;
  /** Omitted/null = gateway master block. */
  billingo_block_id?: string | null;
  email_company_name?: string | null;
  email_contact_address?: string | null;
  email_theme_color?: string | null;
  email_language?: string | null;
}

export interface GatewayTokenResult {
  project: GatewayProject;
  bearer_token: string;
  expires_at: string | null;
}

export interface GatewayMutationResponse {
  success: boolean;
  message: string;
  data: GatewayProject | GatewayTokenResult | GatewayMerchant | null;
  meta: {
    version: string;
    timestamp: string;
  };
}

export interface GatewayMerchant {
  id: string;
  name: string;
  email: string;
  billingo_block_id: string | null;
  email_company_name: string | null;
  email_contact_address: string | null;
  email_theme_color: string | null;
  email_language: string | null;
  created_at: string;
  updated_at: string;
}

export interface GatewayMerchantListResponse {
  success: boolean;
  message: string;
  data: GatewayMerchant[];
  meta: {
    version: string;
    timestamp: string;
    pagination: GatewayPagination;
  };
}

export interface GatewayMerchantUpdate {
  name?: string;
  email?: string;
  /** Null clears the override — the gateway falls back to its master block. */
  billingo_block_id?: string | null;
  email_company_name?: string | null;
  email_contact_address?: string | null;
  email_theme_color?: string | null;
  email_language?: string | null;
}

export interface GatewayInvoiceBlock {
  id: number;
  name: string;
  type: string;
}

export interface GatewayInvoiceBlockListResponse {
  success: boolean;
  message: string;
  data: GatewayInvoiceBlock[];
  meta: {
    version: string;
    timestamp: string;
  };
}

export interface GatewayTestEmailResponse {
  success: boolean;
  message: string;
  data: {
    to: string;
  };
}

export interface GatewayTransactionOwner {
  name?: string;
  email?: string;
  [k: string]: unknown;
}

export interface GatewayTransaction {
  id: string;
  owner_type: string;
  owner_id: string;
  stripe_checkout_session_id: string;
  billingo_invoice_id: string | null;
  amount: number;
  currency: string;
  status: string;
  metadata: Record<string, unknown> | null;
  owner: GatewayTransactionOwner | null;
  created_at: string;
  updated_at: string;
}

export interface GatewayTransactionListResponse {
  success: boolean;
  message: string;
  data: GatewayTransaction[];
  meta: {
    version: string;
    timestamp: string;
    pagination: GatewayPagination;
  };
}

export interface GatewayResendResponse {
  success: boolean;
  message: string;
  data: { to: string; invoice_number: string | null; pdf_bytes: number };
  meta: {
    version: string;
    timestamp: string;
  };
}

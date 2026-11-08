// Client for the nexus-gateway billing proxy (/api/gateway/*).
// The operator token stays server-side in Express; the browser only ever
// sends its own cookie session (same as every other admin API here).
import { apiFetch } from "./api";
import type {
  GatewayInvoiceBlockListResponse,
  GatewayListResponse,
  GatewayMerchantListResponse,
  GatewayMerchantUpdate,
  GatewayMutationResponse,
  GatewayProjectCreate,
  GatewayResendResponse,
  GatewayTestEmailResponse,
  GatewayTransactionListResponse,
} from "@/types/gateway";

export const listGatewayProjects = (page = 1, perPage = 15): Promise<GatewayListResponse> =>
  apiFetch<GatewayListResponse>(`/gateway/projects?page=${page}&per_page=${perPage}`);

export const createGatewayProject = (
  data: GatewayProjectCreate,
): Promise<GatewayMutationResponse> =>
  apiFetch<GatewayMutationResponse>("/gateway/projects", {
    method: "POST",
    body: JSON.stringify(data),
  });

export const updateGatewayProject = (
  id: string,
  data: Partial<GatewayProjectCreate>,
): Promise<GatewayMutationResponse> =>
  apiFetch<GatewayMutationResponse>(`/gateway/projects/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });

export const deleteGatewayProject = (id: string): Promise<GatewayMutationResponse> =>
  apiFetch<GatewayMutationResponse>(`/gateway/projects/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });

export const rotateGatewayToken = (
  id: string,
  expiresInDays?: number | null,
): Promise<GatewayMutationResponse> =>
  apiFetch<GatewayMutationResponse>(
    `/gateway/projects/${encodeURIComponent(id)}/tokens`,
    {
      method: "POST",
      body: JSON.stringify(
        expiresInDays === undefined ? {} : { expires_in_days: expiresInDays },
      ),
    },
  );

// --- Merchants (invoicing identities; secrets stay in the gateway) ---

export const listGatewayMerchants = (page = 1, perPage = 15): Promise<GatewayMerchantListResponse> =>
  apiFetch<GatewayMerchantListResponse>(`/gateway/merchants?page=${page}&per_page=${perPage}`);

export const updateGatewayMerchant = (
  id: string,
  data: GatewayMerchantUpdate,
): Promise<GatewayMutationResponse> =>
  apiFetch<GatewayMutationResponse>(`/gateway/merchants/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });

// --- Live Billingo invoice blocks (dropdown source, never typed by hand) ---

export const listProjectInvoiceBlocks = (
  projectId: string,
): Promise<GatewayInvoiceBlockListResponse> =>
  apiFetch<GatewayInvoiceBlockListResponse>(
    `/gateway/projects/${encodeURIComponent(projectId)}/billingo-blocks`,
  );

export const listMerchantInvoiceBlocks = (
  merchantId: string,
): Promise<GatewayInvoiceBlockListResponse> =>
  apiFetch<GatewayInvoiceBlockListResponse>(
    `/gateway/merchants/${encodeURIComponent(merchantId)}/billingo-blocks`,
  );

// --- Merchant onboarding (credentials sync + live block preview) ---

export interface GatewayMerchantCredentials {
  merchant_id?: string;
  name: string;
  email: string;
  stripe_secret_key: string;
  billingo_api_key: string;
  billingo_block_id?: string | number | null;
  email_company_name?: string | null;
  email_contact_address?: string | null;
  email_theme_color?: string | null;
  email_language?: string | null;
}

export const syncMerchantCredentials = (
  data: GatewayMerchantCredentials,
): Promise<GatewayMutationResponse> =>
  apiFetch<GatewayMutationResponse>("/gateway/merchants/credentials", {
    method: "POST",
    body: JSON.stringify(data),
  });

export const previewMerchantBlocks = (
  billingoApiKey: string,
): Promise<GatewayInvoiceBlockListResponse> =>
  apiFetch<GatewayInvoiceBlockListResponse>("/gateway/merchants/blocks-preview", {
    method: "POST",
    body: JSON.stringify({ billingo_api_key: billingoApiKey }),
  });

// --- Branded test emails (sample email, no invoice attached) ---

export const sendProjectTestEmail = (
  id: string,
  toEmail: string,
): Promise<GatewayTestEmailResponse> =>
  apiFetch<GatewayTestEmailResponse>(
    `/gateway/projects/${encodeURIComponent(id)}/test-email`,
    {
      method: "POST",
      body: JSON.stringify({ to_email: toEmail }),
    },
  );

export const sendMerchantTestEmail = (
  id: string,
  toEmail: string,
): Promise<GatewayTestEmailResponse> =>
  apiFetch<GatewayTestEmailResponse>(
    `/gateway/merchants/${encodeURIComponent(id)}/test-email`,
    {
      method: "POST",
      body: JSON.stringify({ to_email: toEmail }),
    },
  );

// --- Transactions (payment ledger + manual resend) ---

export const listGatewayTransactions = (
  page = 1,
  perPage = 15,
  status?: string,
): Promise<GatewayTransactionListResponse> => {
  const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
  if (status && status !== "all") params.set("status", status);
  return apiFetch<GatewayTransactionListResponse>(`/gateway/transactions?${params.toString()}`);
};

export const resendGatewayInvoice = (
  id: string,
): Promise<GatewayResendResponse> =>
  apiFetch<GatewayResendResponse>(
    `/gateway/transactions/${encodeURIComponent(id)}/resend`,
    { method: "POST" },
  );

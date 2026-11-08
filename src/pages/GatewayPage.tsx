// ----------------------------------------------------------------------------
// GatewayPage — admin-only management UI for the nexus-gateway billing API
// (proxied via /api/gateway/* so the operator token never reaches the
// browser).
//
// Projects tab: SaaS portfolios — register (token shown once), rotate
// tokens, suspend/activate, delete, and set the per-project Billingo
// invoice block (empty = gateway master default). Row details open in a
// Details dialog (identity, token, billing, email branding).
//
// Merchants tab: invoicing identities synced from Nexus — edit the
// per-merchant Billingo block here (empty = master default). Secrets are
// never shown and are rotated via the credentials sync, not this UI.
// ----------------------------------------------------------------------------

import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Check,
  Copy,
  Eye,
  KeyRound,
  Mail,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import {
  createGatewayProject,
  deleteGatewayProject,
  listGatewayMerchants,
  listGatewayProjects,
  listGatewayTransactions,
  listMerchantInvoiceBlocks,
  listProjectInvoiceBlocks,
  previewMerchantBlocks,
  resendGatewayInvoice,
  rotateGatewayToken,
  sendMerchantTestEmail,
  sendProjectTestEmail,
  syncMerchantCredentials,
  updateGatewayMerchant,
  updateGatewayProject,
} from "@/lib/gateway";
import { getAllProjectsPaged, updateProject as updateLocalProject } from "@/lib/api";
import type {
  GatewayMerchant,
  GatewayProject,
  GatewayTokenResult,
  GatewayTransaction,
} from "@/types/gateway";
import { showError, showSuccess } from "@/utils/toast";

type LifetimeChoice = "year" | "month" | "never";

function toExpiresInDays(choice: LifetimeChoice): number | null {
  if (choice === "never") return null;
  if (choice === "month") return 30;
  return 365;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

const DEFAULT_THEME_COLOR = "#4F46E5";

function isValidHexColor(value: string | null | undefined): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

interface BlockEditTarget {
  kind: "project" | "merchant";
  id: string;
  name: string;
  current: string | null;
}

const GatewayPage = () => {
  const { t } = useTranslation(["gateway", "common"]);
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [merchantPage, setMerchantPage] = useState(1);
  const [paymentPage, setPaymentPage] = useState(1);
  const [paymentStatus, setPaymentStatus] = useState("all");
  const [paymentDetails, setPaymentDetails] = useState<GatewayTransaction | null>(null);
  const [resendTarget, setResendTarget] = useState<GatewayTransaction | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createActive, setCreateActive] = useState(true);
  const [createLifetime, setCreateLifetime] = useState<LifetimeChoice>("year");
  const [createBlock, setCreateBlock] = useState("");
  const [createCompany, setCreateCompany] = useState("");
  const [createContact, setCreateContact] = useState("");
  const [createColor, setCreateColor] = useState("");

  const [tokenResult, setTokenResult] = useState<GatewayTokenResult | null>(null);
  const [copied, setCopied] = useState(false);

  const [rotateTarget, setRotateTarget] = useState<GatewayProject | null>(null);
  const [rotateLifetime, setRotateLifetime] = useState<LifetimeChoice>("year");
  const [deleteTarget, setDeleteTarget] = useState<GatewayProject | null>(null);

  const [blockTarget, setBlockTarget] = useState<BlockEditTarget | null>(null);
  const [blockValue, setBlockValue] = useState("");

  // Details dialog (the per-row centerpiece) + its branding/test-email form.
  const [detailsProject, setDetailsProject] = useState<GatewayProject | null>(null);
  const [detailsMerchant, setDetailsMerchant] = useState<GatewayMerchant | null>(null);
  const [brandCompany, setBrandCompany] = useState("");
  const [brandContact, setBrandContact] = useState("");
  const [brandColor, setBrandColor] = useState("");
  const [brandLang, setBrandLang] = useState("");
  const [testTo, setTestTo] = useState("");

  // Merchant onboarding (credentials sync + live block pick + Nexus link).
  const [onboardOpen, setOnboardOpen] = useState(false);
  const [onboardProjectId, setOnboardProjectId] = useState("");
  const [onboardName, setOnboardName] = useState("");
  const [onboardEmail, setOnboardEmail] = useState("");
  const [onboardStripeKey, setOnboardStripeKey] = useState("");
  const [onboardBillingoKey, setOnboardBillingoKey] = useState("");
  const [onboardBlock, setOnboardBlock] = useState("");
  const [onboardCompany, setOnboardCompany] = useState("");
  const [onboardContact, setOnboardContact] = useState("");
  const [onboardColor, setOnboardColor] = useState("");

  const projectsQuery = useQuery({
    queryKey: ["gateway-projects", page],
    queryFn: () => listGatewayProjects(page, 15),
  });

  const merchantsQuery = useQuery({
    queryKey: ["gateway-merchants", merchantPage],
    queryFn: () => listGatewayMerchants(merchantPage, 15),
  });

  const localProjectsQuery = useQuery({
    queryKey: ["local-projects-for-billing"],
    queryFn: () => getAllProjectsPaged({ size: 100 }),
  });
  const localProjects = localProjectsQuery.data?.content ?? [];
  const linkedName = (merchantId: string): string | null =>
    localProjects.find((p) => p.gatewayMerchantId === merchantId)?.name ?? null;

  // Live invoice blocks for the open editor — fetched with the owner's own
  // Billingo key, so the admin picks a real block instead of typing an id.
  const blocksQuery = useQuery({
    queryKey: ["gateway-blocks", blockTarget?.kind, blockTarget?.id],
    queryFn: () =>
      blockTarget?.kind === "merchant"
        ? listMerchantInvoiceBlocks(blockTarget.id)
        : listProjectInvoiceBlocks(blockTarget?.id ?? ""),
    enabled: blockTarget !== null,
  });

  const invalidateProjects = () =>
    queryClient.invalidateQueries({ queryKey: ["gateway-projects"] });
  const invalidateMerchants = () =>
    queryClient.invalidateQueries({ queryKey: ["gateway-merchants"] });
  const invalidatePayments = () =>
    queryClient.invalidateQueries({ queryKey: ["gateway-payments"] });

  const paymentsQuery = useQuery({
    queryKey: ["gateway-payments", paymentPage, paymentStatus],
    queryFn: () => listGatewayTransactions(paymentPage, 15, paymentStatus),
  });

  const resendMutation = useMutation({
    mutationFn: (tx: GatewayTransaction) => resendGatewayInvoice(tx.id),
    onSuccess: () => {
      setResendTarget(null);
      showSuccess(t("gateway:resend_sent"));
      invalidatePayments();
    },
    onError: (err) => showError(resendErrorMessage(err)),
  });

  // The gateway answers in English; surface the known resend failures in
  // Hungarian instead of the raw upstream text.
  const resendErrorMessage = (err: unknown): string => {
    const raw = err instanceof Error ? err.message : "";
    if (raw.includes("Only paid transactions can be resent.")) {
      return "Csak fizetett tranzakció küldhető újra.";
    }
    if (raw.includes("This transaction has no invoice yet.")) {
      return "Ehhez a tranzakcióhoz még nincs számla.";
    }
    if (raw.includes("Resend failed.")) {
      return "Az újraküldés sikertelen.";
    }
    return extractError(err);
  };

  const paymentStatusBadge = (status: string) => {
    const variant =
      status === "paid"
        ? "default"
        : status === "failed"
          ? "destructive"
          : status === "refunded"
            ? "outline"
            : "secondary";
    const label =
      status === "paid"
        ? t("gateway:status_paid")
        : status === "failed"
          ? t("gateway:status_failed")
          : status === "refunded"
            ? t("gateway:status_refunded")
            : t("gateway:status_pending");
    return <Badge variant={variant}>{label}</Badge>;
  };

  const formatMoney = (amountMinor: number, currency: string) =>
    `${(amountMinor / 100).toFixed(2)} ${currency}`;

  const shortOwnerType = (ownerType: string) =>
    ownerType.replace(/^App\\Models\\/, "");

  const extractError = (err: unknown): string =>
    err instanceof Error ? err.message : t("common:operation_failed", { error: "" });

  const createMutation = useMutation({
    mutationFn: () =>
      createGatewayProject({
        name: createName.trim(),
        is_active: createActive,
        expires_in_days: toExpiresInDays(createLifetime),
        billingo_block_id: createBlock.trim() === "" ? null : createBlock.trim(),
        email_company_name: emptyToNull(createCompany),
        email_contact_address: emptyToNull(createContact),
        email_theme_color: emptyToNull(createColor),
        email_language: brandLang === "" ? null : brandLang,
      }),
    onSuccess: (res) => {
      const payload = res.data as GatewayTokenResult;
      setCreateOpen(false);
      setCreateName("");
      setCreateActive(true);
      setCreateLifetime("year");
      setCreateBlock("");
      setCreateCompany("");
      setCreateContact("");
      setCreateColor("");
      setBrandLang("");
      setCopied(false);
      setTokenResult(payload);
      invalidateProjects();
    },
    onError: (err) => showError(extractError(err)),
  });

  const rotateMutation = useMutation({
    mutationFn: (project: GatewayProject) =>
      rotateGatewayToken(project.id, toExpiresInDays(rotateLifetime)),
    onSuccess: (res) => {
      setRotateTarget(null);
      setCopied(false);
      setTokenResult(res.data as GatewayTokenResult);
      invalidateProjects();
    },
    onError: (err) => showError(extractError(err)),
  });

  const toggleMutation = useMutation({
    mutationFn: (project: GatewayProject) =>
      updateGatewayProject(project.id, { is_active: !project.is_active }),
    onSuccess: () => {
      showSuccess(t("common:update_success", { item: t("gateway:title") }));
      invalidateProjects();
    },
    onError: (err) => showError(extractError(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: (project: GatewayProject) => deleteGatewayProject(project.id),
    onSuccess: () => {
      setDeleteTarget(null);
      showSuccess(t("common:delete_success", { item: t("gateway:title") }));
      invalidateProjects();
    },
    onError: (err) => showError(extractError(err)),
  });

  const blockMutation = useMutation({
    mutationFn: (target: BlockEditTarget) => {
      // "__default" is the dropdown's master-default option; empty text
      // means the same. Anything else is a real Billingo block id.
      const trimmed = blockValue === "__default" ? "" : blockValue.trim();
      const value = trimmed === "" ? null : trimmed;
      return target.kind === "project"
        ? updateGatewayProject(target.id, { billingo_block_id: value })
        : updateGatewayMerchant(target.id, { billingo_block_id: value });
    },
    onSuccess: (_, target) => {
      setBlockTarget(null);
      showSuccess(t("common:update_success", { item: t("gateway:block") }));
      if (target.kind === "project") invalidateProjects();
      else invalidateMerchants();
    },
    onError: (err) => showError(extractError(err)),
  });

  // Details dialog: save the email branding fields.
  const brandingMutation = useMutation({
    mutationFn: (target: { kind: "project" | "merchant"; id: string }) => {
      const payload = {
        email_company_name: emptyToNull(brandCompany),
        email_contact_address: emptyToNull(brandContact),
        email_theme_color: emptyToNull(brandColor),
        email_language: brandLang === "" ? null : brandLang,
      };
      return target.kind === "project"
        ? updateGatewayProject(target.id, payload)
        : updateGatewayMerchant(target.id, payload);
    },
    onSuccess: (_, target) => {
      showSuccess(t("common:update_success", { item: t("gateway:email_branding") }));
      if (target.kind === "project") {
        invalidateProjects();
        setDetailsProject((p) =>
          p && p.id === target.id
            ? {
                ...p,
                email_company_name: emptyToNull(brandCompany),
                email_contact_address: emptyToNull(brandContact),
                email_theme_color: emptyToNull(brandColor),
                email_language: brandLang === "" ? null : brandLang,
              }
            : p,
        );
      } else {
        invalidateMerchants();
        setDetailsMerchant((m) =>
          m && m.id === target.id
            ? {
                ...m,
                email_company_name: emptyToNull(brandCompany),
                email_contact_address: emptyToNull(brandContact),
                email_theme_color: emptyToNull(brandColor),
                email_language: brandLang === "" ? null : brandLang,
              }
            : m,
        );
      }
    },
    onError: (err) => showError(extractError(err)),
  });

  // Details dialog: send a sample branded email (no invoice attached).
  const testEmailMutation = useMutation({
    mutationFn: (target: { kind: "project" | "merchant"; id: string; to: string }) =>
      target.kind === "project"
        ? sendProjectTestEmail(target.id, target.to)
        : sendMerchantTestEmail(target.id, target.to),
    onSuccess: () => {
      setTestTo("");
      showSuccess(t("gateway:test_email_sent"));
    },
    onError: (err) => showError(extractError(err)),
  });

  // Onboarding: preview live blocks for the pasted (not yet stored) key.
  const previewMutation = useMutation({
    mutationFn: (billingoKey: string) => previewMerchantBlocks(billingoKey),
    onError: (err) => showError(extractError(err)),
  });

  const onboardMutation = useMutation({
    mutationFn: async () => {
      const created = await syncMerchantCredentials({
        name: onboardName.trim(),
        email: onboardEmail.trim(),
        stripe_secret_key: onboardStripeKey.trim(),
        billingo_api_key: onboardBillingoKey.trim(),
        billingo_block_id: onboardBlock === "" ? null : onboardBlock,
        email_company_name: emptyToNull(onboardCompany),
        email_contact_address: emptyToNull(onboardContact),
        email_theme_color: emptyToNull(onboardColor),
        email_language: brandLang === "" ? null : brandLang,
      });
      const merchant = created.data as GatewayMerchant;
      if (onboardProjectId !== "" && onboardProjectId !== "__none") {
        await updateLocalProject(Number(onboardProjectId), {
          gatewayMerchantId: merchant.id,
        });
      }
      return merchant;
    },
    onSuccess: () => {
      setOnboardOpen(false);
      resetOnboardForm();
      invalidateMerchants();
      queryClient.invalidateQueries({ queryKey: ["local-projects-for-billing"] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      showSuccess(t("common:create_success", { item: t("gateway:tab_merchants") }));
    },
    onError: (err) => showError(extractError(err)),
  });

  const unlinkMutation = useMutation({
    mutationFn: (localProjectId: number) =>
      updateLocalProject(localProjectId, { gatewayMerchantId: null }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["local-projects-for-billing"] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      showSuccess(t("common:update_success", { item: t("gateway:tab_merchants") }));
    },
    onError: (err) => showError(extractError(err)),
  });

  const resetOnboardForm = () => {
    setOnboardProjectId("");
    setOnboardName("");
    setOnboardEmail("");
    setOnboardStripeKey("");
    setOnboardBillingoKey("");
    setOnboardBlock("");
    setOnboardCompany("");
    setOnboardContact("");
    setOnboardColor("");
    setBrandLang("");
    previewMutation.reset();
  };

  const prefillFromLocalProject = (localId: string) => {
    if (localId === "__none") {
      setOnboardProjectId("");
      return;
    }
    setOnboardProjectId(localId);
    const local = localProjects.find((p) => String(p.id) === localId);
    if (local) {
      setOnboardName(local.name);
      setOnboardEmail(local.customerEmail ?? "");
    }
  };

  const openProjectDetails = (project: GatewayProject) => {
    setDetailsMerchant(null);
    setDetailsProject(project);
    setBrandCompany(project.email_company_name ?? "");
    setBrandContact(project.email_contact_address ?? "");
    setBrandColor(project.email_theme_color ?? "");
    setBrandLang(project.email_language ?? "");
    setTestTo("");
  };

  const openMerchantDetails = (merchant: GatewayMerchant) => {
    setDetailsProject(null);
    setDetailsMerchant(merchant);
    setBrandCompany(merchant.email_company_name ?? "");
    setBrandContact(merchant.email_contact_address ?? "");
    setBrandColor(merchant.email_theme_color ?? "");
    setBrandLang(merchant.email_language ?? "");
    setTestTo("");
  };

  const closeDetails = () => {
    setDetailsProject(null);
    setDetailsMerchant(null);
  };

  const copyToken = async () => {
    if (!tokenResult) return;
    try {
      await navigator.clipboard.writeText(tokenResult.bearer_token);
      setCopied(true);
      showSuccess(t("gateway:copied"));
    } catch {
      showError(t("gateway:copy"));
    }
  };

  const openBlockEditor = (target: BlockEditTarget) => {
    setBlockValue(target.current ?? "");
    setBlockTarget(target);
  };

  const projects = projectsQuery.data?.data ?? [];
  const projectPagination = projectsQuery.data?.meta.pagination;
  const projectError =
    projectsQuery.error instanceof Error ? projectsQuery.error.message : null;

  const merchants = merchantsQuery.data?.data ?? [];
  const merchantPagination = merchantsQuery.data?.meta.pagination;
  const merchantError =
    merchantsQuery.error instanceof Error ? merchantsQuery.error.message : null;

  const payments = paymentsQuery.data?.data ?? [];
  const paymentPagination = paymentsQuery.data?.meta.pagination;
  const paymentError =
    paymentsQuery.error instanceof Error ? paymentsQuery.error.message : null;

  const renderBlockBadge = (blockId: string | null) =>
    blockId ? (
      <span className="font-mono text-sm">{blockId}</span>
    ) : (
      <Badge variant="outline">{t("gateway:block_default")}</Badge>
    );

  const renderBrandCell = (company: string | null, color: string | null) => (
    <div className="flex items-center gap-2 text-sm">
      <span
        className="inline-block h-3.5 w-3.5 shrink-0 rounded-full border"
        style={{ backgroundColor: isValidHexColor(color) ? color : "transparent" }}
      />
      <span className={company ? undefined : "text-muted-foreground"}>
        {company || "—"}
      </span>
    </div>
  );

  const DetailRow = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="flex items-start justify-between gap-4 py-1 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );

  // Shared branding inputs (create dialog, onboard dialog, details dialog).
  const renderBrandingInputs = (
    prefix: string,
    company: string,
    setCompany: (v: string) => void,
    contact: string,
    setContact: (v: string) => void,
    color: string,
    setColor: (v: string) => void,
  ) => (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${prefix}-company`}>{t("gateway:company_name")}</Label>
        <Input
          id={`${prefix}-company`}
          value={company}
          onChange={(e) => setCompany(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${prefix}-contact`}>{t("gateway:contact_email")}</Label>
        <Input
          id={`${prefix}-contact`}
          type="email"
          value={contact}
          onChange={(e) => setContact(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${prefix}-color`}>{t("gateway:theme_color")}</Label>
        <div className="flex items-center gap-2">
          <Input
            type="color"
            aria-label={t("gateway:theme_color")}
            className="h-9 w-14 shrink-0 cursor-pointer p-1"
            value={isValidHexColor(color.trim()) ? color.trim() : DEFAULT_THEME_COLOR}
            onChange={(e) => setColor(e.target.value)}
          />
          <Input
            id={`${prefix}-color`}
            value={color}
            placeholder="#4F46E5"
            className="font-mono"
            onChange={(e) => setColor(e.target.value)}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t("gateway:theme_color_hint")}</p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${prefix}-lang`}>{t("gateway:email_language")}</Label>
        <Select
          value={brandLang === "" ? "__default" : brandLang}
          onValueChange={(v) => setBrandLang(v === "__default" ? "" : v)}
        >
          <SelectTrigger id={`${prefix}-lang`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__default">{t("gateway:lang_default")}</SelectItem>
            <SelectItem value="hu">{t("gateway:lang_hu")}</SelectItem>
            <SelectItem value="en">{t("gateway:lang_en")}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t("gateway:email_language_hint")}</p>
      </div>
    </>
  );

  // Frontend-only mini preview of the branded header (not the real template).
  const renderBrandPreview = (fallbackName: string) => {
    const previewColor = isValidHexColor(brandColor.trim())
      ? brandColor.trim()
      : DEFAULT_THEME_COLOR;
    return (
      <div>
        <Label>{t("gateway:email_preview")}</Label>
        <div className="mt-1.5 overflow-hidden rounded-md border">
          <div
            className="px-3 py-2 text-sm font-semibold text-white"
            style={{ backgroundColor: previewColor }}
          >
            {brandCompany.trim() || fallbackName}
          </div>
          <div className="space-y-2 p-3">
            <p className="text-sm font-medium">
              {brandLang === "hu" ? "Sikeres fizetés" : "Payment successful"}
            </p>
            <div className="h-2 w-3/4 rounded bg-muted" />
            <div className="h-2 w-1/2 rounded bg-muted" />
            <p className="text-xs text-muted-foreground">
              {brandContact.trim() || "—"}
            </p>
          </div>
        </div>
      </div>
    );
  };

  // Email branding section shared by the project/merchant details dialogs.
  const renderBrandingSection = (
    prefix: string,
    kind: "project" | "merchant",
    id: string,
    fallbackName: string,
  ) => (
    <section className="flex flex-col gap-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Palette className="h-4 w-4" />
        {t("gateway:email_branding")}
      </h3>
      <p className="text-xs text-muted-foreground">{t("gateway:email_branding_hint")}</p>
      {renderBrandingInputs(
        prefix,
        brandCompany,
        setBrandCompany,
        brandContact,
        setBrandContact,
        brandColor,
        setBrandColor,
      )}
      {renderBrandPreview(fallbackName)}
      <Button
        size="sm"
        className="self-start"
        disabled={brandingMutation.isPending}
        onClick={() => brandingMutation.mutate({ kind, id })}
      >
        {t("common:save")}
      </Button>
      <div className="flex flex-col gap-2 rounded-md border p-3">
        <Label htmlFor={`${prefix}-test-to`}>{t("gateway:test_email_to")}</Label>
        <div className="flex gap-2">
          <Input
            id={`${prefix}-test-to`}
            type="email"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            disabled={!testTo.trim() || testEmailMutation.isPending}
            onClick={() => testEmailMutation.mutate({ kind, id, to: testTo.trim() })}
          >
            <Mail className="mr-2 h-4 w-4" />
            {t("gateway:test_email")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("gateway:test_email_hint")}</p>
      </div>
    </section>
  );

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>{t("gateway:title")}</CardTitle>
            <CardDescription>{t("gateway:description")}</CardDescription>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => {
                projectsQuery.refetch();
                merchantsQuery.refetch();
              }}
              disabled={projectsQuery.isFetching || merchantsQuery.isFetching}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              {t("gateway:refresh")}
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              {t("gateway:create")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="projects">
            <TabsList className="mb-4">
              <TabsTrigger value="projects">{t("gateway:tab_projects")}</TabsTrigger>
              <TabsTrigger value="merchants">{t("gateway:tab_merchants")}</TabsTrigger>
              <TabsTrigger value="payments">{t("gateway:tab_payments")}</TabsTrigger>
            </TabsList>

            <TabsContent value="projects">
              {projectError ? (
                <div className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <div>
                    <p className="font-medium">{projectError}</p>
                    <p className="mt-1 text-muted-foreground">{t("gateway:setup_hint")}</p>
                  </div>
                </div>
              ) : projects.length === 0 && !projectsQuery.isLoading ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {t("gateway:empty")}
                </p>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("gateway:name")}</TableHead>
                          <TableHead>{t("gateway:status")}</TableHead>
                          <TableHead>{t("gateway:block")}</TableHead>
                          <TableHead>{t("gateway:email_branding")}</TableHead>
                          <TableHead className="text-right">
                            {t("common:actions")}
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {projects.map((project) => (
                          <TableRow key={project.id}>
                            <TableCell>
                              <div className="font-medium">{project.name}</div>
                              <div className="font-mono text-xs text-muted-foreground">
                                {project.id}
                              </div>
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant={project.is_active ? "default" : "secondary"}
                              >
                                {project.is_active
                                  ? t("gateway:status_active")
                                  : t("gateway:status_inactive")}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              {renderBlockBadge(project.billingo_block_id)}
                            </TableCell>
                            <TableCell>
                              {renderBrandCell(
                                project.email_company_name,
                                project.email_theme_color,
                              )}
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-right">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => openProjectDetails(project)}
                              >
                                <Eye className="mr-2 h-4 w-4" />
                                {t("gateway:details")}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="ml-1 text-destructive"
                                title={t("common:delete")}
                                aria-label={t("common:delete")}
                                onClick={() => setDeleteTarget(project)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  {projectPagination && projectPagination.last_page > 1 && (
                    <div className="mt-4 flex items-center justify-end gap-2 text-sm">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={page <= 1}
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                      >
                        {t("gateway:previous")}
                      </Button>
                      <span className="text-muted-foreground">
                        {page} / {projectPagination.last_page}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={page >= projectPagination.last_page}
                        onClick={() => setPage((p) => p + 1)}
                      >
                        {t("gateway:next")}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </TabsContent>

            <TabsContent value="merchants">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground">
                  {t("gateway:merchants_hint")}
                </p>
                <Button size="sm" onClick={() => { resetOnboardForm(); setOnboardOpen(true); }}>
                  <Plus className="mr-2 h-4 w-4" />
                  {t("gateway:onboard")}
                </Button>
              </div>
              {merchantError ? (
                <div className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <div>
                    <p className="font-medium">{merchantError}</p>
                    <p className="mt-1 text-muted-foreground">{t("gateway:setup_hint")}</p>
                  </div>
                </div>
              ) : merchants.length === 0 && !merchantsQuery.isLoading ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {t("gateway:merchants_empty")}
                </p>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("gateway:name")}</TableHead>
                          <TableHead>{t("gateway:email")}</TableHead>
                          <TableHead>{t("gateway:block")}</TableHead>
                          <TableHead>{t("gateway:email_branding")}</TableHead>
                          <TableHead className="text-right">
                            {t("common:actions")}
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {merchants.map((merchant: GatewayMerchant) => {
                          const linked = localProjects.find(
                            (p) => p.gatewayMerchantId === merchant.id,
                          );
                          return (
                          <TableRow key={merchant.id}>
                            <TableCell>
                              <div className="font-medium">{merchant.name}</div>
                              <div className="font-mono text-xs text-muted-foreground">
                                {merchant.id}
                              </div>
                              {linked && (
                                <div className="mt-0.5 text-xs text-muted-foreground">
                                  ↳ {linked.name}
                                </div>
                              )}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {merchant.email}
                            </TableCell>
                            <TableCell>
                              {renderBlockBadge(merchant.billingo_block_id)}
                            </TableCell>
                            <TableCell>
                              {renderBrandCell(
                                merchant.email_company_name,
                                merchant.email_theme_color,
                              )}
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-right">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => openMerchantDetails(merchant)}
                              >
                                <Eye className="mr-2 h-4 w-4" />
                                {t("gateway:details")}
                              </Button>
                              {linked && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="ml-1"
                                  onClick={() => unlinkMutation.mutate(linked.id)}
                                  disabled={unlinkMutation.isPending}
                                >
                                  {t("gateway:unlink")}
                                </Button>
                              )}
                            </TableCell>
                          </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                  {merchantPagination && merchantPagination.last_page > 1 && (
                    <div className="mt-4 flex items-center justify-end gap-2 text-sm">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={merchantPage <= 1}
                        onClick={() => setMerchantPage((p) => Math.max(1, p - 1))}
                      >
                        {t("gateway:previous")}
                      </Button>
                      <span className="text-muted-foreground">
                        {merchantPage} / {merchantPagination.last_page}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={merchantPage >= merchantPagination.last_page}
                        onClick={() => setMerchantPage((p) => p + 1)}
                      >
                        {t("gateway:next")}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </TabsContent>

            <TabsContent value="payments">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground">
                  {t("gateway:payments_hint")}
                </p>
                <div className="flex items-center gap-2">
                  <Label htmlFor="gateway-payment-status">{t("gateway:filter_status")}</Label>
                  <Select
                    value={paymentStatus}
                    onValueChange={(v) => { setPaymentStatus(v); setPaymentPage(1); }}
                  >
                    <SelectTrigger id="gateway-payment-status" className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t("gateway:filter_all")}</SelectItem>
                      <SelectItem value="pending">{t("gateway:status_pending")}</SelectItem>
                      <SelectItem value="paid">{t("gateway:status_paid")}</SelectItem>
                      <SelectItem value="failed">{t("gateway:status_failed")}</SelectItem>
                      <SelectItem value="refunded">{t("gateway:status_refunded")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {paymentError ? (
                <div className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <div>
                    <p className="font-medium">{paymentError}</p>
                    <p className="mt-1 text-muted-foreground">{t("gateway:setup_hint")}</p>
                  </div>
                </div>
              ) : payments.length === 0 && !paymentsQuery.isLoading ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {t("gateway:payments_empty")}
                </p>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("gateway:col_date")}</TableHead>
                          <TableHead>{t("gateway:col_owner")}</TableHead>
                          <TableHead>{t("gateway:col_amount")}</TableHead>
                          <TableHead>{t("gateway:col_status")}</TableHead>
                          <TableHead>{t("gateway:col_invoice")}</TableHead>
                          <TableHead>{t("gateway:col_session")}</TableHead>
                          <TableHead className="text-right">
                            {t("common:actions")}
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {payments.map((tx) => {
                          const canResend = tx.status === "paid" && !!tx.billingo_invoice_id;
                          return (
                          <TableRow key={tx.id}>
                            <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                              {formatDateTime(tx.created_at)}
                            </TableCell>
                            <TableCell>
                              <div className="font-medium">
                                {tx.owner?.name ?? shortOwnerType(tx.owner_type)}
                              </div>
                              {tx.owner?.email && (
                                <div className="text-xs text-muted-foreground">
                                  {tx.owner.email}
                                </div>
                              )}
                            </TableCell>
                            <TableCell className="whitespace-nowrap font-medium">
                              {formatMoney(tx.amount, tx.currency)}
                            </TableCell>
                            <TableCell>{paymentStatusBadge(tx.status)}</TableCell>
                            <TableCell>
                              {tx.billingo_invoice_id ? (
                                <span className="font-mono text-sm">{tx.billingo_invoice_id}</span>
                              ) : (
                                <span className="text-muted-foreground">{t("gateway:no_invoice")}</span>
                              )}
                            </TableCell>
                            <TableCell>
                              <span
                                className="font-mono text-xs text-muted-foreground"
                                title={tx.stripe_checkout_session_id}
                              >
                                {tx.stripe_checkout_session_id.slice(0, 12)}…
                              </span>
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-right">
                              <Button
                                variant="ghost"
                                size="sm"
                                title={t("gateway:details")}
                                onClick={() => setPaymentDetails(tx)}
                              >
                                <Eye className="h-4 w-4" />
                              </Button>
                              {canResend && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  title={t("gateway:resend")}
                                  onClick={() => setResendTarget(tx)}
                                  disabled={resendMutation.isPending}
                                >
                                  <Mail className="h-4 w-4" />
                                </Button>
                              )}
                            </TableCell>
                          </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                  {paymentPagination && paymentPagination.last_page > 1 && (
                    <div className="mt-4 flex items-center justify-end gap-2 text-sm">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={paymentPage <= 1}
                        onClick={() => setPaymentPage((p) => Math.max(1, p - 1))}
                      >
                        {t("gateway:previous")}
                      </Button>
                      <span className="text-muted-foreground">
                        {paymentPage} / {paymentPagination.last_page}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={paymentPage >= paymentPagination.last_page}
                        onClick={() => setPaymentPage((p) => p + 1)}
                      >
                        {t("gateway:next")}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Details dialog — the per-row centerpiece */}
      <Dialog
        open={detailsProject !== null || detailsMerchant !== null}
        onOpenChange={(open) => { if (!open) closeDetails(); }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {detailsProject?.name ?? detailsMerchant?.name ?? ""}
            </DialogTitle>
            <DialogDescription className="font-mono text-xs">
              {detailsProject?.id ?? detailsMerchant?.id ?? ""}
            </DialogDescription>
          </DialogHeader>

          {detailsProject && (
            <div className="flex flex-col gap-6 py-2">
              <section className="flex flex-col gap-1">
                <h3 className="mb-1 text-sm font-semibold">
                  {t("gateway:identity_section")}
                </h3>
                <DetailRow label={t("gateway:id_label")}>
                  <span className="font-mono text-xs">{detailsProject.id}</span>
                </DetailRow>
                <DetailRow label={t("gateway:name")}>{detailsProject.name}</DetailRow>
                <DetailRow label={t("gateway:status")}>
                  <Badge variant={detailsProject.is_active ? "default" : "secondary"}>
                    {detailsProject.is_active
                      ? t("gateway:status_active")
                      : t("gateway:status_inactive")}
                  </Badge>
                </DetailRow>
                <DetailRow label={t("gateway:created")}>
                  {formatDateTime(detailsProject.created_at)}
                </DetailRow>
                <DetailRow label={t("gateway:block")}>
                  {renderBlockBadge(detailsProject.billingo_block_id)}
                </DetailRow>
              </section>

              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold">{t("gateway:token_section")}</h3>
                <p className="text-xs text-muted-foreground">
                  {t("gateway:token_warning")}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setRotateLifetime("year");
                      setRotateTarget(detailsProject);
                    }}
                  >
                    <KeyRound className="mr-2 h-4 w-4" />
                    {t("gateway:rotate")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={toggleMutation.isPending}
                    onClick={() => toggleMutation.mutate(detailsProject)}
                  >
                    {detailsProject.is_active
                      ? t("gateway:deactivate")
                      : t("gateway:activate")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={() => setDeleteTarget(detailsProject)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    {t("common:delete")}
                  </Button>
                </div>
              </section>

              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold">{t("gateway:billing_section")}</h3>
                <div className="flex items-center gap-2">
                  {renderBlockBadge(detailsProject.billingo_block_id)}
                  <Button
                    variant="ghost"
                    size="sm"
                    title={t("gateway:block_edit")}
                    onClick={() =>
                      openBlockEditor({
                        kind: "project",
                        id: detailsProject.id,
                        name: detailsProject.name,
                        current: detailsProject.billingo_block_id,
                      })
                    }
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </section>

              {renderBrandingSection(
                "gateway-detail",
                "project",
                detailsProject.id,
                detailsProject.name,
              )}
            </div>
          )}

          {detailsMerchant && (
            <div className="flex flex-col gap-6 py-2">
              <section className="flex flex-col gap-1">
                <h3 className="mb-1 text-sm font-semibold">
                  {t("gateway:identity_section")}
                </h3>
                <DetailRow label={t("gateway:id_label")}>
                  <span className="font-mono text-xs">{detailsMerchant.id}</span>
                </DetailRow>
                <DetailRow label={t("gateway:name")}>{detailsMerchant.name}</DetailRow>
                <DetailRow label={t("gateway:email")}>{detailsMerchant.email}</DetailRow>
                <DetailRow label={t("gateway:onboard_project")}>
                  {linkedName(detailsMerchant.id) ?? t("gateway:onboard_no_link")}
                </DetailRow>
                <DetailRow label={t("gateway:created")}>
                  {formatDateTime(detailsMerchant.created_at)}
                </DetailRow>
                <DetailRow label={t("gateway:block")}>
                  {renderBlockBadge(detailsMerchant.billingo_block_id)}
                </DetailRow>
              </section>

              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold">{t("gateway:billing_section")}</h3>
                <div className="flex items-center gap-2">
                  {renderBlockBadge(detailsMerchant.billingo_block_id)}
                  <Button
                    variant="ghost"
                    size="sm"
                    title={t("gateway:block_edit")}
                    onClick={() =>
                      openBlockEditor({
                        kind: "merchant",
                        id: detailsMerchant.id,
                        name: detailsMerchant.name,
                        current: detailsMerchant.billingo_block_id,
                      })
                    }
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </section>

              {renderBrandingSection(
                "gateway-detail",
                "merchant",
                detailsMerchant.id,
                detailsMerchant.name,
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={closeDetails}>
              {t("common:close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Payment details dialog */}
      <Dialog
        open={paymentDetails !== null}
        onOpenChange={(open) => { if (!open) setPaymentDetails(null); }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("gateway:details_title")}</DialogTitle>
            <DialogDescription className="font-mono text-xs">
              {paymentDetails?.id ?? ""}
            </DialogDescription>
          </DialogHeader>

          {paymentDetails && (
            <div className="flex flex-col gap-6 py-2">
              <section className="flex flex-col gap-1">
                <h3 className="mb-1 text-sm font-semibold">
                  {t("gateway:identity_section")}
                </h3>
                <DetailRow label={t("gateway:col_date")}>
                  {formatDateTime(paymentDetails.created_at)}
                </DetailRow>
                <DetailRow label={t("gateway:col_status")}>
                  {paymentStatusBadge(paymentDetails.status)}
                </DetailRow>
                <DetailRow label={t("gateway:col_owner")}>
                  {paymentDetails.owner?.name ?? shortOwnerType(paymentDetails.owner_type)}
                </DetailRow>
                {paymentDetails.owner?.email && (
                  <DetailRow label={t("gateway:email")}>
                    {paymentDetails.owner.email}
                  </DetailRow>
                )}
                <DetailRow label={t("gateway:col_amount")}>
                  {formatMoney(paymentDetails.amount, paymentDetails.currency)}
                </DetailRow>
                <DetailRow label={t("gateway:col_session")}>
                  <span className="font-mono text-xs break-all">
                    {paymentDetails.stripe_checkout_session_id}
                  </span>
                </DetailRow>
                <DetailRow label={t("gateway:col_invoice")}>
                  {paymentDetails.billingo_invoice_id ? (
                    <span className="font-mono text-xs">
                      {paymentDetails.billingo_invoice_id}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">{t("gateway:no_invoice")}</span>
                  )}
                </DetailRow>
                <DetailRow label={t("gateway:contact_email")}>
                  {typeof paymentDetails.metadata?.["customer_email"] === "string" &&
                  (paymentDetails.metadata["customer_email"] as string) !== "" ? (
                    paymentDetails.metadata["customer_email"] as string
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </DetailRow>
              </section>

              {(() => {
                const raw = paymentDetails.metadata?.["line_items"];
                if (!Array.isArray(raw) || raw.length === 0) return null;
                const rows: Array<{ name: string; qty: string; unit: string }> = [];
                for (const entry of raw) {
                  if (typeof entry !== "object" || entry === null) continue;
                  const item = entry as Record<string, unknown>;
                  const price =
                    typeof item["price_data"] === "object" && item["price_data"] !== null
                      ? (item["price_data"] as Record<string, unknown>)
                      : {};
                  const product =
                    typeof price["product_data"] === "object" && price["product_data"] !== null
                      ? (price["product_data"] as Record<string, unknown>)
                      : {};
                  const name =
                    typeof product["name"] === "string" && product["name"] !== ""
                      ? product["name"]
                      : "Service";
                  const qty =
                    typeof item["quantity"] === "number" ? String(item["quantity"]) : "1";
                  const unit =
                    typeof price["unit_amount"] === "number"
                      ? `${(price["unit_amount"] / 100).toFixed(2)} ${String(price["currency"] ?? "").toUpperCase()}`
                      : "—";
                  rows.push({ name, qty, unit });
                }
                if (rows.length === 0) return null;
                return (
                  <section className="flex flex-col gap-1">
                    <h3 className="mb-1 text-sm font-semibold">
                      {t("gateway:items_title")}
                    </h3>
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>{t("gateway:name")}</TableHead>
                            <TableHead>{t("gateway:col_qty")}</TableHead>
                            <TableHead className="text-right">
                              {t("gateway:col_unit_price")}
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {rows.map((row, i) => (
                            <TableRow key={i}>
                              <TableCell>{row.name}</TableCell>
                              <TableCell>{row.qty}</TableCell>
                              <TableCell className="text-right">{row.unit}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </section>
                );
              })()}

              {paymentDetails.status === "paid" && paymentDetails.billingo_invoice_id && (
                <div className="flex justify-start">
                  <Button
                    size="sm"
                    onClick={() => setResendTarget(paymentDetails)}
                    disabled={resendMutation.isPending}
                  >
                    <Mail className="mr-2 h-4 w-4" />
                    {t("gateway:resend")}
                  </Button>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setPaymentDetails(null)}>
              {t("common:close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Resend confirm */}
      <AlertDialog open={resendTarget !== null} onOpenChange={() => setResendTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("gateway:resend_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("gateway:resend_description", {
                email:
                  typeof resendTarget?.metadata?.["customer_email"] === "string"
                    ? (resendTarget.metadata["customer_email"] as string)
                    : "—",
                invoice: resendTarget?.billingo_invoice_id ?? "—",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => resendTarget && resendMutation.mutate(resendTarget)}
            >
              {t("gateway:resend")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("gateway:create_title")}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="gateway-name">{t("gateway:name")}</Label>
              <Input
                id="gateway-name"
                value={createName}
                placeholder={t("gateway:name_placeholder")}
                onChange={(e) => setCreateName(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t("gateway:name_hint")}</p>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="gateway-block">{t("gateway:block")}</Label>
              <Input
                id="gateway-block"
                value={createBlock}
                placeholder={t("gateway:block_placeholder")}
                onChange={(e) => setCreateBlock(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t("gateway:block_hint")}</p>
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="gateway-active">{t("gateway:active")}</Label>
              <Switch
                id="gateway-active"
                checked={createActive}
                onCheckedChange={setCreateActive}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label>{t("gateway:lifetime")}</Label>
              <Select
                value={createLifetime}
                onValueChange={(v) => setCreateLifetime(v as LifetimeChoice)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="year">{t("gateway:lifetime_1y")}</SelectItem>
                  <SelectItem value="month">{t("gateway:lifetime_30d")}</SelectItem>
                  <SelectItem value="never">{t("gateway:lifetime_never")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <fieldset className="flex flex-col gap-4 rounded-md border p-3">
              <legend className="-ml-1 px-1 text-sm font-medium">
                {t("gateway:email_branding")}
              </legend>
              {renderBrandingInputs(
                "gateway-create",
                createCompany,
                setCreateCompany,
                createContact,
                setCreateContact,
                createColor,
                setCreateColor,
              )}
            </fieldset>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t("common:cancel")}
            </Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={!createName.trim() || createMutation.isPending}
            >
              {t("common:create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Block edit dialog (projects + merchants) — live dropdown of the
          owner's real Billingo blocks, with a free-text fallback if the
          Billingo lookup fails. Empty = master default. */}
      <Dialog open={blockTarget !== null} onOpenChange={() => setBlockTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("gateway:block_edit_title", { name: blockTarget?.name ?? "" })}
            </DialogTitle>
            <DialogDescription>{t("gateway:block_hint")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 py-2">
            <Label htmlFor="gateway-block-edit">{t("gateway:block")}</Label>
            {blocksQuery.data ? (
              <Select value={blockValue} onValueChange={setBlockValue}>
                <SelectTrigger id="gateway-block-edit">
                  <SelectValue placeholder={t("gateway:block_default")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default">
                    {t("gateway:block_default")}
                  </SelectItem>
                  {blocksQuery.data.data.map((block) => (
                    <SelectItem key={block.id} value={String(block.id)}>
                      {block.name} ({block.id})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <>
                <Input
                  id="gateway-block-edit"
                  value={blockValue}
                  placeholder={t("gateway:block_placeholder")}
                  onChange={(e) => setBlockValue(e.target.value)}
                  disabled={blocksQuery.isLoading}
                />
                <p className="text-xs text-muted-foreground">
                  {blocksQuery.isLoading
                    ? t("gateway:block_loading")
                    : t("gateway:block_load_failed")}
                </p>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBlockTarget(null)}>
              {t("common:cancel")}
            </Button>
            <Button
              onClick={() => blockTarget && blockMutation.mutate(blockTarget)}
              disabled={blockMutation.isPending}
            >
              {t("common:save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Token reveal dialog (shown once) */}
      <Dialog open={tokenResult !== null} onOpenChange={() => setTokenResult(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("gateway:token_title")}</DialogTitle>
            <DialogDescription>{t("gateway:token_warning")}</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-md bg-muted p-3 font-mono text-xs break-all">
            <span className="flex-1">{tokenResult?.bearer_token}</span>
            <Button variant="outline" size="sm" onClick={copyToken}>
              {copied ? (
                <Check className="h-4 w-4" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
              <span className="ml-1">{t("gateway:copy")}</span>
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setTokenResult(null)}>{t("gateway:done")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rotate confirm */}
      <AlertDialog open={rotateTarget !== null} onOpenChange={() => setRotateTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("gateway:rotate_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("gateway:rotate_description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-2 py-1">
            <Label>{t("gateway:lifetime")}</Label>
            <Select
              value={rotateLifetime}
              onValueChange={(v) => setRotateLifetime(v as LifetimeChoice)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="year">{t("gateway:lifetime_1y")}</SelectItem>
                <SelectItem value="month">{t("gateway:lifetime_30d")}</SelectItem>
                <SelectItem value="never">{t("gateway:lifetime_never")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => rotateTarget && rotateMutation.mutate(rotateTarget)}
            >
              {t("gateway:rotate")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirm */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("gateway:delete_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("gateway:delete_description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
            >
              {t("common:delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Merchant onboarding: Nexus project -> credentials sync -> link */}
      <Dialog open={onboardOpen} onOpenChange={(open) => { if (!open) resetOnboardForm(); setOnboardOpen(open); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("gateway:onboard_title")}</DialogTitle>
            <DialogDescription>{t("gateway:onboard_description")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-2">
              <Label>{t("gateway:onboard_project")}</Label>
              <Select value={onboardProjectId} onValueChange={prefillFromLocalProject}>
                <SelectTrigger>
                  <SelectValue placeholder={t("gateway:onboard_no_link")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">{t("gateway:onboard_no_link")}</SelectItem>
                  {localProjects
                    .filter((p) => !p.gatewayMerchantId)
                    .map((p) => (
                      <SelectItem key={p.id} value={String(p.id)}>
                        {p.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="gateway-ob-name">{t("gateway:name")}</Label>
              <Input
                id="gateway-ob-name"
                value={onboardName}
                onChange={(e) => setOnboardName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="gateway-ob-email">{t("gateway:email")}</Label>
              <Input
                id="gateway-ob-email"
                type="email"
                value={onboardEmail}
                onChange={(e) => setOnboardEmail(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="gateway-ob-stripe">{t("gateway:stripe_key")}</Label>
              <Input
                id="gateway-ob-stripe"
                type="password"
                autoComplete="new-password"
                value={onboardStripeKey}
                placeholder="sk_live_..."
                onChange={(e) => { setOnboardStripeKey(e.target.value); previewMutation.reset(); }}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="gateway-ob-billingo">{t("gateway:billingo_key")}</Label>
              <Input
                id="gateway-ob-billingo"
                type="password"
                autoComplete="new-password"
                value={onboardBillingoKey}
                onChange={(e) => { setOnboardBillingoKey(e.target.value); previewMutation.reset(); }}
              />
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label>{t("gateway:block")}</Label>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={onboardBillingoKey.trim().length < 8 || previewMutation.isPending}
                  onClick={() => previewMutation.mutate(onboardBillingoKey.trim())}
                >
                  {t("gateway:load_blocks")}
                </Button>
              </div>
              {previewMutation.data ? (
                <Select value={onboardBlock} onValueChange={setOnboardBlock}>
                  <SelectTrigger>
                    <SelectValue placeholder={t("gateway:block_default")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">{t("gateway:block_default")}</SelectItem>
                    {previewMutation.data.data.map((block) => (
                      <SelectItem key={block.id} value={String(block.id)}>
                        {block.name} ({block.id})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {previewMutation.isPending
                    ? t("gateway:block_loading")
                    : t("gateway:block_lookup_hint")}
                </p>
              )}
            </div>
            <fieldset className="flex flex-col gap-4 rounded-md border p-3">
              <legend className="-ml-1 px-1 text-sm font-medium">
                {t("gateway:email_branding")}
              </legend>
              {renderBrandingInputs(
                "gateway-ob",
                onboardCompany,
                setOnboardCompany,
                onboardContact,
                setOnboardContact,
                onboardColor,
                setOnboardColor,
              )}
            </fieldset>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { resetOnboardForm(); setOnboardOpen(false); }}>
              {t("common:cancel")}
            </Button>
            <Button
              onClick={() => onboardMutation.mutate()}
              disabled={
                !onboardName.trim() ||
                !onboardEmail.trim() ||
                onboardStripeKey.trim() === "" ||
                onboardBillingoKey.trim().length < 8 ||
                onboardMutation.isPending
              }
            >
              {t("gateway:onboard_submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default GatewayPage;

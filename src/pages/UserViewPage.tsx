// UserViewPage — admin only.
//
// Shows the user details plus (for endusers) their project assignments
// and a "send invite" / "resend invite" / "revoke invite" action set.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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
import { ArrowLeft, Pencil, Trash2, Mail, MailX, Copy, Check, KeyRound, X } from "lucide-react";
import { showError, showSuccess } from "@/utils/toast";
import type { UserDetails, InviteIssuedResponse } from "@/types/user";
import {
  deleteUser,
  getUserById,
  getAllProjectsPaged,
  issueInvite,
  revokeInvite,
  setUserProjects,
  removeUserProject,
} from "@/lib/api";
import { ProjectAssignmentsCard } from "@/components/users/ProjectAssignmentsCard";

const UserViewPage: React.FC = () => {
  const { t } = useTranslation(["users", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { id } = useParams<{ id: string }>();
  const userId = id ? Number.parseInt(id) : null;

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isRevokeDialogOpen, setIsRevokeDialogOpen] = useState(false);
  const [inviteDialog, setInviteDialog] = useState<{
    open: boolean;
    inviteToken: string;
  }>({ open: false, inviteToken: "" });
  const [copied, setCopied] = useState(false);

  const { data: initialData, isLoading, error } = useQuery<UserDetails, Error>({
    queryKey: ["user", userId],
    queryFn: () => getUserById(userId!),
    enabled: !!userId,
  });

  const { data: projectsData } = useQuery({
    queryKey: ["projects", "for-assignments", { page: 0, size: 200 }],
    queryFn: () =>
      getAllProjectsPaged({ page: 0, size: 200, sortField: "name", sortOrder: "asc" }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteUser(userId!),
    onSuccess: () => {
      showSuccess(t("common:delete_success", { item: t("users:user") }));
      queryClient.invalidateQueries({ queryKey: ["users"] });
      navigate("/users");
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  const inviteMutation = useMutation({
    mutationFn: () => issueInvite(userId!),
    onSuccess: (data: InviteIssuedResponse) => {
      showSuccess(t("users:invite_resent"));
      setInviteDialog({ open: true, inviteToken: data.inviteToken });
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  const revokeMutation = useMutation({
    mutationFn: () => revokeInvite(userId!),
    onSuccess: () => {
      showSuccess(t("users:invite_revoked"));
      setIsRevokeDialogOpen(false);
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  const inviteLink = inviteDialog.inviteToken
    ? `${window.location.origin}/set-password?token=${encodeURIComponent(inviteDialog.inviteToken)}`
    : "";

  const handleCopyInviteLink = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      showSuccess(t("users:invite_link_copied"));
      window.setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      showError(t("common:operation_failed", { error: String(e) }));
    }
  };

  if (error) {
    showError(t("common:operation_failed", { error: error.message }));
  }
  if (!userId)
    return <div className="text-center p-8">{t("common:invalid_id")}</div>;
  if (isLoading)
    return (
      <div className="text-center p-8">{t("auth:loading_user_data")}</div>
    );
  if (!initialData)
    return (
      <div className="text-center p-8">{t("users:user_not_found")}</div>
    );

  const details: Array<{ label: string; value: React.ReactNode }> = [
    { label: t("common:id"), value: initialData.id },
    {
      label: t("users:full_name"),
      value: `${initialData.lastName} ${initialData.firstName}`,
    },
    { label: t("common:email"), value: initialData.email },
    {
      label: t("users:role"),
      value: (
        <Badge variant={initialData.role === "admin" ? "default" : "secondary"}>
          {t(`users:role_${initialData.role}`)}
        </Badge>
      ),
    },
    {
      label: t("common:status"),
      value: (
        <Badge variant={initialData.enabled ? "default" : "destructive"}>
          {initialData.enabled ? t("common:active") : t("common:disabled")}
        </Badge>
      ),
    },
    {
      label: t("common:created_at"),
      value: new Date(initialData.createdAt).toLocaleString(),
    },
  ];

  if (initialData.role === "enduser") {
    details.push({
      label: t("users:must_set_password"),
      value: initialData.mustSetPassword
        ? t("users:pending_invite")
        : t("common:completed"),
    });
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6 w-full">
      <Card>
        <CardHeader className="flex flex-col space-y-4 pb-2">
          <CardTitle className="text-2xl font-bold break-words">
            {t("users:user_details")}: {initialData.firstName} {initialData.lastName}
          </CardTitle>
          <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto sm:flex-wrap">
            <Button
              variant="outline"
              onClick={() => navigate("/users")}
              className="w-full sm:w-auto"
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              {t("common:back")}
            </Button>
            {initialData.role === "enduser" && (
              <>
                <Button
                  onClick={() => inviteMutation.mutate()}
                  disabled={inviteMutation.isPending}
                  className="w-full sm:w-auto"
                >
                  <KeyRound className="mr-2 h-4 w-4" />
                  {initialData.mustSetPassword
                    ? t("users:resend_invite")
                    : t("users:send_invite")}
                </Button>
                {initialData.mustSetPassword && (
                  <Button
                    variant="outline"
                    onClick={() => setIsRevokeDialogOpen(true)}
                    disabled={revokeMutation.isPending}
                    className="w-full sm:w-auto"
                  >
                    <MailX className="mr-2 h-4 w-4" />
                    {t("users:revoke_invite")}
                  </Button>
                )}
              </>
            )}
            <Button
              variant="outline"
              onClick={() => navigate(`/users/edit/${initialData.id}`)}
              className="w-full sm:w-auto"
            >
              <Pencil className="mr-2 h-4 w-4" />
              {t("common:edit")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => setIsDeleteDialogOpen(true)}
              disabled={deleteMutation.isPending}
              className="w-full sm:w-auto"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {t("common:delete")}
            </Button>
          </div>
        </CardHeader>
        <Separator />
        <CardContent className="pt-6 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {details.map((item) => (
              <div key={item.label} className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">
                  {item.label}
                </p>
                <div className="text-base font-semibold break-words">
                  {item.value}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Project assignments — only for endusers. Admins are not
          assigned to projects. */}
      {initialData.role === "enduser" && (
        <ProjectAssignmentsCard
          userId={initialData.id}
          assignedProjectIds={initialData.projectIds || []}
          allProjects={projectsData?.content || []}
        />
      )}

      {/* Delete confirm */}
      <AlertDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("users:confirm_delete_title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("users:confirm_delete_description", {
                name: `${initialData.firstName} ${initialData.lastName}`,
                email: initialData.email,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              className="bg-destructive hover:bg-destructive/90"
            >
              {deleteMutation.isPending
                ? t("common:deleting")
                : t("common:delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Revoke invite confirm */}
      <AlertDialog
        open={isRevokeDialogOpen}
        onOpenChange={setIsRevokeDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("users:revoke_invite_title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("users:revite_invite_description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revokeMutation.isPending}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => revokeMutation.mutate()}
              disabled={revokeMutation.isPending}
              className="bg-destructive hover:bg-destructive/90"
            >
              {revokeMutation.isPending
                ? t("common:deleting")
                : t("users:revoke_invite")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Invite link display */}
      <AlertDialog
        open={inviteDialog.open}
        onOpenChange={(open) => setInviteDialog((d) => ({ ...d, open }))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("users:invite")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("users:invite_resent")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium">
              {t("users:invite_link_label")}
            </label>
            <div className="flex items-center gap-2">
              <Input value={inviteLink} readOnly />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={handleCopyInviteLink}
                aria-label="Copy"
              >
                {copied ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogAction>{t("common:close")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default UserViewPage;

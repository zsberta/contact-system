// UserCreatePage — admin only.
//
// On create-success for an enduser, the server returns the plaintext
// invite token in the response (it was also emailed). We surface a
// "copy the link" dialog so the admin can manually deliver the link if
// the email didn't go out. Admins don't have invites — they go
// straight to the user view.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { showError, showSuccess } from "@/utils/toast";
import { createUser } from "@/lib/api";
import type { CreateUserResponse, UserCreateUpdateDTO, UserDetails } from "@/types/user";
import UserForm, { UserFormValues } from "@/components/users/UserForm";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Copy, Check } from "lucide-react";

const UserCreatePage: React.FC = () => {
  const { t } = useTranslation(["users", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [inviteDialog, setInviteDialog] = useState({
    open: false,
    inviteToken: "",
  });
  const [copied, setCopied] = useState(false);

  const createMutation = useMutation({
    mutationFn: (data: UserCreateUpdateDTO) => createUser(data),
    onSuccess: (data: CreateUserResponse) => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      if (data.role === "enduser" && data.inviteToken) {
        // Show the invite dialog so the admin can copy the link. They
        // can close it to navigate to the user view (or to send
        // another invite later).
        setInviteDialog({ open: true, inviteToken: data.inviteToken });
      } else {
        showSuccess(t("common:create_success", { item: t("users:user") }));
        navigate(`/users/view/${data.id}`);
      }
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  const inviteLink = inviteDialog.inviteToken
    ? `${window.location.origin}/set-password?token=${encodeURIComponent(inviteDialog.inviteToken)}`
    : "";

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      showSuccess(t("users:invite_link_copied"));
      window.setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      showError(t("common:operation_failed", { error: String(e) }));
    }
  };

  return (
    <>
      <UserForm
        mode="create"
        isSubmitting={createMutation.isPending}
        onSubmit={(values: UserFormValues) => {
          // For endusers, the BE rejects any password value. We strip
          // it on the wire so the BE never sees an empty string vs.
          // null distinction.
          const payload: UserCreateUpdateDTO = {
            firstName: values.firstName,
            lastName: values.lastName,
            email: values.email,
            role: values.role,
          };
          if (values.role === "admin" && values.password) {
            payload.password = values.password;
          }
          createMutation.mutate(payload);
        }}
      />
      <AlertDialog
        open={inviteDialog.open}
        onOpenChange={(open) => {
          setInviteDialog((d) => ({ ...d, open }));
          if (!open && createMutation.data) {
            // When the admin closes the dialog, take them to the
            // user view where they can manage project assignments.
            navigate(`/users/view/${createMutation.data.id}`);
          }
        }}
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
                onClick={handleCopy}
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
            <AlertDialogAction>
              {t("common:close")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default UserCreatePage;

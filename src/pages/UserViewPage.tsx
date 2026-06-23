import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
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
import { ArrowLeft, Pencil, Trash2 } from "lucide-react";
import { showError, showSuccess } from "@/utils/toast";
import { UserDetails } from "@/types/user";
import { deleteUser, getUserById } from "@/lib/api";

const UserViewPage: React.FC = () => {
  const { t } = useTranslation(["users", "common", "auth"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { id } = useParams<{ id: string }>();
  const userId = id ? Number.parseInt(id) : null;

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

  const { data: user, isLoading, error } = useQuery<UserDetails, Error>({
    queryKey: ["user", userId],
    queryFn: () => getUserById(userId!),
    enabled: !!userId,
  });

  // TODO(future-work): guard against deleting the currently signed-in user.
  // For v1 single-user this isn't a concern, but once we wire useAuth() here
  // we should compare user.id === currentUser.id and disable the button.
  const deleteMutation = useMutation({
    mutationFn: () => deleteUser(user!.id),
    onSuccess: () => {
      showSuccess(
        t("common:delete_success", { item: t("users:user") }),
      );
      queryClient.invalidateQueries({ queryKey: ["users"] });
      navigate("/users");
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  if (error) {
    showError(t("common:operation_failed", { error: error.message }));
  }
  if (!userId)
    return <div className="text-center p-8">{t("common:invalid_id")}</div>;
  if (isLoading)
    return (
      <div className="text-center p-8">{t("auth:loading_user_data")}</div>
    );
  if (!user)
    return (
      <div className="text-center p-8">{t("users:user_not_found")}</div>
    );

  const details = [
    { label: t("common:id"), value: user.id },
    { label: t("users:first_name"), value: user.firstName },
    { label: t("users:last_name"), value: user.lastName },
    { label: t("common:email"), value: user.email },
    {
      label: t("common:status"),
      value: user.enabled ? t("common:active") : t("common:disabled"),
    },
    {
      label: t("common:created_at"),
      value: new Date(user.createdAt).toLocaleString(),
    },
  ];

  return (
    <div className="max-w-2xl mx-auto space-y-6 w-full">
      <Card>
        <CardHeader className="flex flex-col space-y-4 pb-2">
          <CardTitle className="text-2xl font-bold break-words">
            {t("users:user_details")}: {user.firstName} {user.lastName}
          </CardTitle>
          <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
            <Button
              variant="outline"
              onClick={() => navigate("/users")}
              className="w-full sm:w-auto"
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              {t("common:back")}
            </Button>
            <Button
              onClick={() => navigate(`/users/edit/${user.id}`)}
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
                <p className="text-base font-semibold">{item.value}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

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
                name: `${user.firstName} ${user.lastName}`,
                email: user.email,
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
    </div>
  );
};

export default UserViewPage;

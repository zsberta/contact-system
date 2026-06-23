import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { showError, showSuccess } from "@/utils/toast";
import { UserCreateUpdateDTO, UserDetails } from "@/types/user";
import { getUserById, updateUser } from "@/lib/api";
import UserForm, { UserFormValues } from "@/components/users/UserForm";

const UserEditPage: React.FC = () => {
  const { t } = useTranslation(["users", "common", "auth"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { id } = useParams<{ id: string }>();
  const userId = id ? Number.parseInt(id) : null;

  const { data: initialData, isLoading, error } = useQuery<UserDetails, Error>({
    queryKey: ["user", userId],
    queryFn: () => getUserById(userId!),
    enabled: !!userId,
  });

  const updateMutation = useMutation({
    mutationFn: (data: UserCreateUpdateDTO) => updateUser(userId!, data),
    onSuccess: () => {
      showSuccess(t("common:update_success", { item: t("users:user") }));
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["user", userId] });
      navigate(`/users/view/${userId}`);
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  if (error) {
    showError(t("common:operation_failed", { error: error.message }));
  }

  if (!userId) {
    return <div className="text-center p-8">{t("common:invalid_id")}</div>;
  }
  if (isLoading) {
    return (
      <div className="text-center p-8">{t("auth:loading_user_data")}</div>
    );
  }
  if (!initialData) {
    return (
      <div className="text-center p-8">{t("users:user_not_found")}</div>
    );
  }

  return (
    <UserForm
      mode="edit"
      initialData={initialData}
      isSubmitting={updateMutation.isPending}
      onSubmit={(values: UserFormValues) => {
        const payload: UserCreateUpdateDTO = {
          firstName: values.firstName,
          lastName: values.lastName,
          email: values.email,
        };
        // Only send password if user typed one (and matches confirmation).
        if (values.password && values.password.length > 0) {
          payload.password = values.password;
        }
        updateMutation.mutate(payload);
      }}
    />
  );
};

export default UserEditPage;

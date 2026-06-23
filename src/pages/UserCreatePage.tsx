import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { showError, showSuccess } from "@/utils/toast";
import { UserCreateUpdateDTO, UserDetails } from "@/types/user";
import { createUser } from "@/lib/api";
import UserForm, { UserFormValues } from "@/components/users/UserForm";

const UserCreatePage: React.FC = () => {
  const { t } = useTranslation(["users", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: (data: UserCreateUpdateDTO) => createUser(data),
    onSuccess: (data: UserDetails) => {
      showSuccess(t("common:create_success", { item: t("users:user") }));
      queryClient.invalidateQueries({ queryKey: ["users"] });
      navigate(`/users/view/${data.id}`);
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  return (
    <UserForm
      mode="create"
      isSubmitting={createMutation.isPending}
      onSubmit={(values: UserFormValues) => {
        createMutation.mutate({
          firstName: values.firstName,
          lastName: values.lastName,
          email: values.email,
          password: values.password ?? "",
        });
      }}
    />
  );
};

export default UserCreatePage;

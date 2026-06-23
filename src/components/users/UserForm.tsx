import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useTranslation } from "react-i18next";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { User, Mail, Lock, ShieldCheck } from "lucide-react";
import { UserDetails } from "@/types/user";

export interface UserFormValues {
  firstName: string;
  lastName: string;
  email: string;
  password?: string;
  passwordConfirm?: string;
}

interface UserFormProps {
  initialData?: UserDetails;
  mode: "create" | "edit";
  isSubmitting: boolean;
  onSubmit: (values: UserFormValues) => void;
}

const UserForm = ({
  initialData,
  mode,
  isSubmitting,
  onSubmit,
}: UserFormProps) => {
  const { t } = useTranslation(["users", "common", "auth"]);

  // Password is required on create; on edit, empty = keep current.
  const passwordRequired = mode === "create";

  const formSchema = z
    .object({
      firstName: z
        .string()
        .min(1, { message: "common:required_field" })
        .max(50, { message: "common:required_field" }),
      lastName: z
        .string()
        .min(1, { message: "common:required_field" })
        .max(50, { message: "common:required_field" }),
      email: z
        .string()
        .min(1, { message: "common:required_field" })
        .max(255, { message: "common:required_field" })
        .email({ message: "auth:invalid_email" }),
      password: passwordRequired
        ? z.string().min(8, { message: "users:password_min_length" })
        : z.string().optional(),
      passwordConfirm: passwordRequired
        ? z.string().min(8, { message: "users:password_min_length" })
        : z.string().optional(),
    })
    .refine(
      (data) => !data.password || data.password === data.passwordConfirm,
      {
        message: "users:passwords_must_match",
        path: ["passwordConfirm"],
      },
    );

  const form = useForm<UserFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      firstName: initialData?.firstName ?? "",
      lastName: initialData?.lastName ?? "",
      email: initialData?.email ?? "",
      password: "",
      passwordConfirm: "",
    },
  });

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="max-w-2xl mx-auto space-y-6 w-full"
      >
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">
              {mode === "create"
                ? t("users:create_user")
                : t("users:edit_user")}
            </CardTitle>
            <CardDescription>
              {mode === "create"
                ? t("users:create_user_description")
                : `${initialData?.firstName} ${initialData?.lastName} (${initialData?.email})`}
            </CardDescription>
          </CardHeader>
          <Separator />
          <CardContent className="pt-6 space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="firstName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>{t("users:first_name")}</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <User className="absolute left-3 top-1/2 h-4 w-4 text-gray-400 transform -translate-y-1/2" />
                        <Input
                          placeholder={t("users:first_name")}
                          autoComplete="given-name"
                          className="pl-10"
                          {...field}
                        />
                      </div>
                    </FormControl>
                    <FormMessage>
                      {form.formState.errors.firstName?.message &&
                        t(
                          form.formState.errors.firstName.message as string,
                        )}
                    </FormMessage>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="lastName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>{t("users:last_name")}</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <User className="absolute left-3 top-1/2 h-4 w-4 text-gray-400 transform -translate-y-1/2" />
                        <Input
                          placeholder={t("users:last_name")}
                          autoComplete="family-name"
                          className="pl-10"
                          {...field}
                        />
                      </div>
                    </FormControl>
                    <FormMessage>
                      {form.formState.errors.lastName?.message &&
                        t(form.formState.errors.lastName.message as string)}
                    </FormMessage>
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("common:email")}</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 h-4 w-4 text-gray-400 transform -translate-y-1/2" />
                      <Input
                        type="email"
                        placeholder={t("common:email_placeholder")}
                        autoComplete="email"
                        className="pl-10"
                        {...field}
                      />
                    </div>
                  </FormControl>
                  <FormMessage>
                    {form.formState.errors.email?.message &&
                      t(form.formState.errors.email.message as string)}
                  </FormMessage>
                </FormItem>
              )}
            />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required={passwordRequired}>
                      {passwordRequired
                        ? t("users:password")
                        : t("users:new_password_optional")}
                    </FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Lock className="absolute left-3 top-1/2 h-4 w-4 text-gray-400 transform -translate-y-1/2" />
                        <Input
                          type="password"
                          placeholder={
                            passwordRequired
                              ? t("users:password_placeholder")
                              : t("users:leave_blank_to_keep")
                          }
                          autoComplete={
                            mode === "create"
                              ? "new-password"
                              : "current-password"
                          }
                          className="pl-10"
                          {...field}
                        />
                      </div>
                    </FormControl>
                    <FormMessage>
                      {form.formState.errors.password?.message &&
                        t(form.formState.errors.password.message as string)}
                    </FormMessage>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="passwordConfirm"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required={passwordRequired}>
                      {t("users:password_confirm")}
                    </FormLabel>
                    <FormControl>
                      <div className="relative">
                        <ShieldCheck className="absolute left-3 top-1/2 h-4 w-4 text-gray-400 transform -translate-y-1/2" />
                        <Input
                          type="password"
                          placeholder={t("users:password_confirm_placeholder")}
                          autoComplete={
                            mode === "create"
                              ? "new-password"
                              : "current-password"
                          }
                          className="pl-10"
                          {...field}
                        />
                      </div>
                    </FormControl>
                    <FormMessage>
                      {form.formState.errors.passwordConfirm?.message &&
                        t(
                          form.formState.errors.passwordConfirm
                            .message as string,
                        )}
                    </FormMessage>
                  </FormItem>
                )}
              />
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => window.history.back()}
            disabled={isSubmitting}
          >
            {t("common:cancel")}
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting
              ? t("common:saving")
              : mode === "create"
                ? t("common:create")
                : t("common:save")}
          </Button>
        </div>
      </form>
    </Form>
  );
};

export default UserForm;

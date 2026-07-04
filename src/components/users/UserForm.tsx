// UserForm — admin-only form for creating and editing users.
//
// Two modes:
//   * admin   — full password field (required on create, optional on edit).
//   * enduser — password field is hidden; a "send invite" hint is shown
//               instead. The server ignores any password on the wire for
//               endusers and issues an invite token in the response.
//
// Role is selectable on create (admin vs enduser) and shown read-only
// on edit (changing a user's role from admin→enduser after they have
// a password is dangerous; we leave that to the BE to reject with 400).

import { useEffect } from "react";
import { useForm, Controller } from "react-hook-form";
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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { User, Mail, Lock, ShieldCheck, Info, Users, Shield } from "lucide-react";
import type { UserDetails, UserRole } from "@/types/user";

export interface UserFormValues {
  firstName: string;
  lastName: string;
  email: string;
  role: UserRole;
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

  // Endusers don't set a password on the create form; admins do.
  const passwordRequired = mode === "create";

  // Build the password rules based on the current role. The role is
  // watched in the schema via superRefine below.
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
      role: z.enum(["admin", "enduser"]).default("admin"),
      password: z.string().optional(),
      passwordConfirm: z.string().optional(),
    })
    .superRefine((data, ctx) => {
      // Admins on create: password required.
      if (data.role === "admin" && passwordRequired) {
        if (!data.password || data.password.length < 8) {
          ctx.addIssue({
            code: "custom",
            path: ["password"],
            message: "users:password_min_length",
          });
        }
        if (data.password && (!data.passwordConfirm || data.passwordConfirm.length < 8)) {
          ctx.addIssue({
            code: "custom",
            path: ["passwordConfirm"],
            message: "users:password_min_length",
          });
        }
      } else if (data.password) {
        // Edit mode: optional. If supplied, must be 8+ and match confirm.
        if (data.password.length < 8) {
          ctx.addIssue({
            code: "custom",
            path: ["password"],
            message: "users:password_min_length",
          });
        }
        if (data.password !== data.passwordConfirm) {
          ctx.addIssue({
            code: "custom",
            path: ["passwordConfirm"],
            message: "users:passwords_must_match",
          });
        }
      }
    });

  const form = useForm<UserFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      firstName: initialData?.firstName ?? "",
      lastName: initialData?.lastName ?? "",
      email: initialData?.email ?? "",
      role: initialData?.role ?? "admin",
      password: "",
      passwordConfirm: "",
    },
  });

  // Watch the role so we can swap the password section live.
  const role = form.watch("role");
  const isEnduser = role === "enduser";

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

            {/* Role selector — only on create. We don't allow flipping an
                existing user's role because admin→enduser would orphan
                their password (it's nullable for endusers) and the
                reverse would let them sign in without a must-set gate. */}
            {mode === "create" && (
              <FormField
                control={form.control}
                name="role"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>{t("users:role")}</FormLabel>
                    <FormControl>
                      <Controller
                        control={form.control}
                        name="role"
                        render={({ field: ctrlField }) => (
                          <Select
                            value={ctrlField.value}
                            onValueChange={(v) =>
                              ctrlField.onChange(v as UserRole)
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="admin">
                                <div className="flex items-center gap-2">
                                  <Shield className="h-4 w-4" />
                                  <div>
                                    <div className="font-medium">
                                      {t("users:role_admin")}
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                      {t("users:role_admin_description")}
                                    </div>
                                  </div>
                                </div>
                              </SelectItem>
                              <SelectItem value="enduser">
                                <div className="flex items-center gap-2">
                                  <Users className="h-4 w-4" />
                                  <div>
                                    <div className="font-medium">
                                      {t("users:role_enduser")}
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                      {t("users:role_enduser_description")}
                                    </div>
                                  </div>
                                </div>
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        )}
                      />
                    </FormControl>
                    <FormDescription>
                      {t("users:enduser_landing_intro")}
                    </FormDescription>
                    <FormMessage>
                      {form.formState.errors.role?.message &&
                        t(form.formState.errors.role.message as string)}
                    </FormMessage>
                  </FormItem>
                )}
              />
            )}

            {mode === "edit" && (
              <FormField
                control={form.control}
                name="role"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("users:role")}</FormLabel>
                    <FormControl>
                      <Controller
                        control={form.control}
                        name="role"
                        render={({ field: ctrlField }) => (
                          <Select
                            value={ctrlField.value}
                            onValueChange={(v) =>
                              ctrlField.onChange(v as UserRole)
                            }
                            disabled
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="admin">
                                {t("users:role_admin")}
                              </SelectItem>
                              <SelectItem value="enduser">
                                {t("users:role_enduser")}
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        )}
                      />
                    </FormControl>
                    <FormDescription>
                      {t("users:enduser_landing_intro")}
                    </FormDescription>
                  </FormItem>
                )}
              />
            )}

            {/* Password section: required for admins on create, hidden for
                endusers on create (they get an invite), optional for everyone
                on edit. */}
            {!(isEnduser && mode === "create") && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel required={passwordRequired && !isEnduser}>
                        {passwordRequired && !isEnduser
                          ? t("users:password")
                          : t("users:new_password_optional")}
                      </FormLabel>
                      <FormControl>
                        <div className="relative">
                          <Lock className="absolute left-3 top-1/2 h-4 w-4 text-gray-400 transform -translate-y-1/2" />
                          <Input
                            type="password"
                            placeholder={
                              passwordRequired && !isEnduser
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
                      <FormLabel required={passwordRequired && !isEnduser}>
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
            )}

            {isEnduser && mode === "create" && (
              <div className="flex items-start gap-2 p-3 border border-info/40 bg-info/10 rounded-md text-sm">
                <Info className="h-4 w-4 mt-0.5 text-info-foreground" />
                <p>{t("users:invite_required_password")}</p>
              </div>
            )}
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

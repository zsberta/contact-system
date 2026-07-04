// Public page: /reset-password?token=<plain>
//
// Reached by clicking the link in a forgot-password email. On success
// we redirect to /login with a success toast.

import React, { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Lock, ShieldCheck, KeyRound, ArrowLeft } from "lucide-react";
import { resetPassword } from "@/lib/api";
import { showError, showSuccess } from "@/utils/toast";
import SEO from "@/components/SEO";
import ParticleBackground from "@/components/ParticleBackground";

const ResetPasswordPage: React.FC = () => {
  const { t } = useTranslation(["auth", "common"]);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get("token") || "";
  const [invalidToken, setInvalidToken] = useState(token.length < 16);

  const formSchema = z
    .object({
      newPassword: z
        .string()
        .min(8, { message: "users:password_min_length" })
        .max(128, { message: "users:password_min_length" }),
      confirmPassword: z
        .string()
        .min(8, { message: "users:password_min_length" })
        .max(128, { message: "users:password_min_length" }),
    })
    .refine((data) => data.newPassword === data.confirmPassword, {
      message: "users:passwords_must_match",
      path: ["confirmPassword"],
    });

  const form = useForm({
    resolver: zodResolver(formSchema),
    defaultValues: { newPassword: "", confirmPassword: "" },
  });

  const onSubmit = async (values) => {
    try {
      await resetPassword({ token, newPassword: values.newPassword });
      showSuccess(t("auth:reset_password_success"));
      navigate("/login");
    } catch (error) {
      const msg = error?.message || "";
      if (
        typeof msg === "string" &&
        (msg.toLowerCase().includes("token") ||
          msg.toLowerCase().includes("expired") ||
          msg.toLowerCase().includes("invalid"))
      ) {
        setInvalidToken(true);
      } else {
        showError(msg);
      }
    }
  };

  if (invalidToken) {
    return (
      <div className="min-h-screen flex items-center justify-center relative overflow-hidden">
        <ParticleBackground />
        <Card className="border-none shadow-lg pt-8 max-w-md w-full mx-3 z-10">
          <CardHeader className="text-center">
            <h1 className="text-2xl font-bold text-primary">
              {t("auth:reset_password_title")}
            </h1>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground text-center">
              {t("auth:reset_password_invalid_token")}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => navigate("/forgot-password")}
              >
                {t("auth:forgot_password_submit")}
              </Button>
              <Link to="/login" className="flex-1">
                <Button variant="ghost" className="w-full">
                  {t("auth:forgot_password_back_to_login")}
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden">
      <SEO
        fallbackTitle={t("auth:reset_password_title")}
        fallbackDescription={t("auth:reset_password_description")}
      />
      <ParticleBackground />
      <div className="w-full max-w-md z-10 relative mx-3">
        <Card className="border-none shadow-lg pt-8">
          <CardHeader className="text-center px-6 pt-0 pb-0">
            <div className="flex flex-row items-center justify-center space-x-2">
              <img
                src="/logo.svg"
                alt="BuzzCRM Logo"
                className="h-16 w-auto object-contain"
              />
              <h1 className="text-3xl font-extrabold text-primary tracking-wider">
                BuzzCRM
              </h1>
            </div>
          </CardHeader>
          <CardContent className="pt-6 px-6">
            <p className="text-sm text-muted-foreground text-center mb-6">
              {t("auth:reset_password_description")}
            </p>
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onSubmit)}
                className="space-y-6"
              >
                <FormField
                  control={form.control}
                  name="newPassword"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel required>{t("auth:password")}</FormLabel>
                      <FormControl>
                        <div className="relative">
                          <Lock className="absolute left-3 top-1/2 h-5 w-5 text-gray-400 transform -translate-y-1/2" />
                          <Input
                            type="password"
                            placeholder="••••••••"
                            autoComplete="new-password"
                            className="pl-10 h-11"
                            {...field}
                          />
                        </div>
                      </FormControl>
                      <FormMessage>
                        {form.formState.errors.newPassword?.message &&
                          t(form.formState.errors.newPassword.message as string)}
                      </FormMessage>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="confirmPassword"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel required>
                        {t("users:password_confirm")}
                      </FormLabel>
                      <FormControl>
                        <div className="relative">
                          <ShieldCheck className="absolute left-3 top-1/2 h-5 w-5 text-gray-400 transform -translate-y-1/2" />
                          <Input
                            type="password"
                            placeholder="••••••••"
                            autoComplete="new-password"
                            className="pl-10 h-11"
                            {...field}
                          />
                        </div>
                      </FormControl>
                      <FormMessage>
                        {form.formState.errors.confirmPassword?.message &&
                          t(
                            form.formState.errors.confirmPassword
                              .message as string,
                          )}
                      </FormMessage>
                    </FormItem>
                  )}
                />
                <Button
                  type="submit"
                  className="w-full h-11"
                  disabled={form.formState.isSubmitting}
                >
                  {form.formState.isSubmitting ? (
                    <div className="flex items-center justify-center">
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                      {t("common:loading")}
                    </div>
                  ) : (
                    <div className="flex items-center justify-center">
                      <KeyRound className="mr-2 h-5 w-5" />
                      {t("auth:reset_password_submit")}
                    </div>
                  )}
                </Button>
              </form>
            </Form>
            <div className="text-center mt-4">
              <Link
                to="/login"
                className="text-sm text-primary hover:underline inline-flex items-center"
              >
                <ArrowLeft className="mr-1 h-3 w-3" />
                {t("auth:forgot_password_back_to_login")}
              </Link>
            </div>
          </CardContent>
        </Card>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          &copy; {new Date().getFullYear()} Zsolt Berta
        </p>
      </div>
    </div>
  );
};

export default ResetPasswordPage;

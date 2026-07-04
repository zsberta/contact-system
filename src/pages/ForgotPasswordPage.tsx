// Public page: /forgot-password
//
// Always shows the same "check your inbox" message on submit, regardless
// of whether the email actually exists. This is intentional — it
// defeats email enumeration. The toast / inline success is the same
// text either way.

import React, { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useNavigate, Link } from "react-router-dom";
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
import { Mail, ArrowLeft } from "lucide-react";
import { forgotPassword } from "@/lib/api";
import SEO from "@/components/SEO";
import ParticleBackground from "@/components/ParticleBackground";

const ForgotPasswordPage: React.FC = () => {
  const { t } = useTranslation(["auth", "common"]);
  const navigate = useNavigate();
  const [submitted, setSubmitted] = useState(false);

  const formSchema = z.object({
    email: z
      .string()
      .min(1, { message: "common:required_field" })
      .email({ message: "auth:invalid_email" })
      .max(255, { message: "common:required_field" }),
  });

  const form = useForm({
    resolver: zodResolver(formSchema),
    defaultValues: { email: "" },
  });

  const onSubmit = async (values) => {
    try {
      await forgotPassword({ email: values.email });
    } catch {
      // We deliberately do NOT show an error toast — the server always
      // returns 200 with a generic message so an attacker can't probe
      // valid emails. Any client-side error is also non-fatal.
    }
    setSubmitted(true);
  };

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden">
      <SEO
        fallbackTitle={t("auth:forgot_password_title")}
        fallbackDescription={t("auth:forgot_password_description")}
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
            {submitted ? (
              <div className="space-y-4 text-center">
                <p className="text-sm text-muted-foreground">
                  {t("auth:forgot_password_submitted")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("auth:forgot_password_check_inbox")}
                </p>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => navigate("/login")}
                >
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  {t("auth:forgot_password_back_to_login")}
                </Button>
              </div>
            ) : (
              <>
                <p className="text-sm text-muted-foreground text-center mb-6">
                  {t("auth:forgot_password_description")}
                </p>
                <Form {...form}>
                  <form
                    onSubmit={form.handleSubmit(onSubmit)}
                    className="space-y-6"
                  >
                    <FormField
                      control={form.control}
                      name="email"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel required>{t("auth:email")}</FormLabel>
                          <FormControl>
                            <div className="relative">
                              <Mail className="absolute left-3 top-1/2 h-5 w-5 text-gray-400 transform -translate-y-1/2" />
                              <Input
                                type="email"
                                placeholder={t("auth:email_placeholder")}
                                autoComplete="email"
                                className="pl-10 h-11"
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
                    <Button
                      type="submit"
                      className="w-full h-11"
                      disabled={form.formState.isSubmitting}
                    >
                      {form.formState.isSubmitting
                        ? t("common:loading")
                        : t("auth:forgot_password_submit")}
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
              </>
            )}
          </CardContent>
        </Card>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          &copy; {new Date().getFullYear()} Zsolt Berta
        </p>
      </div>
    </div>
  );
};

export default ForgotPasswordPage;

import React, { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
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
import { useAuth } from "@/context/AuthContext";
import { Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Mail, Lock, LogIn } from "lucide-react";
import ParticleBackground from "@/components/ParticleBackground";

const LoginPage: React.FC = () => {
  const { t } = useTranslation(["auth", "common"]);
  const { login, isAuthenticated } = useAuth();
  const currentYear = new Date().getFullYear();

  const formSchema = z.object({
    identifier: z
      .string()
      .min(1, { message: t("common:required_field") })
      .max(100, { message: t("common:required_field") }),
    password: z
      .string()
      .min(1, { message: t("common:required_field") })
      .max(100, { message: t("common:required_field") }),
  });

  type LoginFormValues = z.infer<typeof formSchema>;

  const form = useForm<LoginFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      identifier: "",
      password: "",
    },
  });

  const onSubmit = async (values: LoginFormValues) => {
    await login({ identifier: values.identifier, password: values.password });
  };

  if (isAuthenticated) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden">
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
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onSubmit)}
                className="space-y-6"
              >
                <FormField
                  control={form.control}
                  name="identifier"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-gray-700 font-medium" required>
                        {t("auth:email")}
                      </FormLabel>
                      <FormControl>
                        <div className="relative">
                          <Mail className="absolute left-3 top-1/2 h-5 w-5 text-gray-400 transform -translate-y-1/2" />
                          <Input
                            placeholder={t("auth:email_placeholder")}
                            {...field}
                            type="text"
                            className="pl-10 h-11"
                          />
                        </div>
                      </FormControl>
                      <FormMessage>
                        {form.formState.errors.identifier?.message &&
                          t(form.formState.errors.identifier.message)}
                      </FormMessage>
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-gray-700 font-medium" required>
                        {t("auth:password")}
                      </FormLabel>
                      <FormControl>
                        <div className="relative">
                          <Lock className="absolute left-3 top-1/2 h-5 w-5 text-gray-400 transform -translate-y-1/2" />
                          <Input
                            placeholder="•••••••"
                            {...field}
                            type="password"
                            className="pl-10 h-11"
                          />
                        </div>
                      </FormControl>
                      <FormMessage>
                        {form.formState.errors.password?.message &&
                          t(form.formState.errors.password.message)}
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
                      {t("auth:signing_in")}
                    </div>
                  ) : (
                    <div className="flex items-center justify-center">
                      <LogIn className="mr-2 h-5 w-5" />
                      {t("auth:sign_in")}
                    </div>
                  )}
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>

        {/* Copyright Notice */}
        <p className="mt-4 text-center text-sm text-muted-foreground">
          &copy; {currentYear} Zsolt Berta
        </p>
      </div>
    </div>
  );
};

export default LoginPage;

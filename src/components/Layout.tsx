import React, { useState, Suspense } from "react";
import { Outlet } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { useTranslation } from "react-i18next";
import { LogOut, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import Sidebar from "./Sidebar";
import LanguageSwitcher from "./LanguageSwitcher";
import Breadcrumbs from "./Breadcrumbs";
import SEO from "./SEO";

const Layout: React.FC = () => {
  const { t } = useTranslation(["common", "seo"]);
  const { logout } = useAuth();
  const [isSheetOpen, setIsSheetOpen] = useState(false);

  const handleLogout = () => {
    setIsSheetOpen(false);
    logout();
  };

  return (
    <>
      <SEO
        fallbackTitle={t("common:app_title")}
        fallbackDescription={t("common:app_description")}
        fallbackKeywords={t("seo:keywords.default")}
      />
      <div className="flex min-h-screen w-full">
        {/* Desktop Sidebar (Column 1) */}
        <div className="hidden border-r bg-sidebar md:block h-[100dvh] sticky top-0 w-[220px] lg:w-[280px] shrink-0">
          <div className="flex h-full flex-col gap-2">
            <div className="relative flex h-14 items-center border-b px-4 lg:h-[60px] lg:px-6">
              <div className="flex items-center space-x-2">
                <img
                  src="/logo.svg"
                  alt={t("common:logo_alt")}
                  className="h-12 object-contain"
                />
                <span className="font-semibold text-2xl text-primary">
                  {t("common:app_name")}
                </span>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              <Sidebar />
            </div>
            <div className="p-4 border-t flex justify-between items-center">
              <LanguageSwitcher />
              <Button
                variant="ghost"
                size="sm"
                onClick={logout}
                className="text-sm text-red-500 hover:text-red-600"
              >
                <LogOut className="w-4 h-4 mr-2" />
                {t("common:logout")}
              </Button>
            </div>
          </div>
        </div>

        {/* Main Content Area (Column 2) */}
        <div className="flex flex-col flex-1 min-w-0">
          {/* Header (Desktop & Mobile) */}
          <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b bg-background px-4 lg:h-[60px] lg:px-6">
            {/* Mobile Menu Trigger */}
            <Sheet open={isSheetOpen} onOpenChange={setIsSheetOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="shrink-0 md:hidden"
                >
                  <Menu className="h-5 w-5" />
                  <span className="sr-only">
                    {t("common:toggle_navigation_menu")}
                  </span>
                </Button>
              </SheetTrigger>
              <SheetContent
                side="left"
                className="flex flex-col w-[280px] sm:w-[320px] p-0 bg-sidebar"
              >
                <div className="relative flex h-14 items-center border-b px-4 lg:h-[60px] lg:px-6">
                  <div className="flex items-center space-x-2">
                    <img
                      src="/logo.svg"
                      alt={t("common:logo_alt")}
                      className="h-12 object-contain"
                    />
                    <span className="font-semibold text-2xl text-primary">
                      {t("common:app_name")}
                    </span>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto">
                  <Sidebar onClose={() => setIsSheetOpen(false)} />
                </div>
                <div className="p-4 border-t flex justify-between items-center">
                  <LanguageSwitcher onClose={() => setIsSheetOpen(false)} />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleLogout}
                    className="text-sm text-red-500 hover:text-red-600"
                  >
                    <LogOut className="w-4 h-4 mr-2" />
                    {t("common:logout")}
                  </Button>
                </div>
              </SheetContent>
            </Sheet>

            <div className="flex-1" />

            {/* Right side actions */}
            <div className="hidden md:flex items-center gap-2">
              <LanguageSwitcher />
              <Button variant="outline" size="icon" onClick={handleLogout}>
                <LogOut className="w-4 h-4" />
              </Button>
            </div>
          </header>

          {/* Content */}
          <main className="flex flex-1 flex-col gap-4 p-4 lg:gap-6 lg:p-6 overflow-x-hidden">
            <Breadcrumbs />
            <Suspense fallback={<div className="flex items-center justify-center p-8"><div className="animate-pulse text-muted-foreground">Loading...</div></div>}>
              <Outlet />
            </Suspense>
          </main>
        </div>
      </div>
    </>
  );
};

export default Layout;

import React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Globe } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface LanguageSwitcherProps {
  onClose?: () => void;
}

const LanguageSwitcher: React.FC<LanguageSwitcherProps> = ({ onClose }) => {
  const { i18n, t } = useTranslation(["common"]);

  const changeLanguage = (lng: string) => {
    i18n.changeLanguage(lng);
    onClose?.();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon">
          <Globe className="h-5 w-5" />
          <span className="sr-only">{t("common:change_language")}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => changeLanguage("en")}>
          {t("common:language_english")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => changeLanguage("hu")}>
          {t("common:language_hungarian")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default LanguageSwitcher;

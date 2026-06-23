import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/context/AuthContext";
import { useTranslation } from "react-i18next";

const DashboardPage = () => {
  const { user } = useAuth();
  const { t } = useTranslation(["dashboard", "common"]);
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("dashboard:welcome")}</CardTitle>
          <CardDescription>
            {user ? `${user.firstName} ${user.lastName} (${user.email})` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">{t("dashboard:placeholder_text")}</p>
        </CardContent>
      </Card>
    </div>
  );
};

export default DashboardPage;

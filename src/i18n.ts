import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import enAuth from "./i18n/en/auth.json";
import enCommon from "./i18n/en/common.json";
import enNavigation from "./i18n/en/navigation.json";
import enDashboard from "./i18n/en/dashboard.json";
import enSeo from "./i18n/en/seo.json";
import enUsers from "./i18n/en/users.json";
import enProjects from "./i18n/en/projects.json";
import enPayments from "./i18n/en/payments.json";
import enWidgets from "./i18n/en/widgets.json";
import enPrivacyPolicy from "./i18n/en/privacy-policy.json";

import huAuth from "./i18n/hu/auth.json";
import huCommon from "./i18n/hu/common.json";
import huNavigation from "./i18n/hu/navigation.json";
import huDashboard from "./i18n/hu/dashboard.json";
import huSeo from "./i18n/hu/seo.json";
import huUsers from "./i18n/hu/users.json";
import huProjects from "./i18n/hu/projects.json";
import huPayments from "./i18n/hu/payments.json";
import huWidgets from "./i18n/hu/widgets.json";
import huPrivacyPolicy from "./i18n/hu/privacy-policy.json";

const resources = {
  en: {
    auth: enAuth,
    common: enCommon,
    navigation: enNavigation,
    dashboard: enDashboard,
    seo: enSeo,
    users: enUsers,
    projects: enProjects,
    payments: enPayments,
    widgets: enWidgets,
    "privacy-policy": enPrivacyPolicy,
  },
  hu: {
    auth: huAuth,
    common: huCommon,
    navigation: huNavigation,
    dashboard: huDashboard,
    seo: huSeo,
    users: huUsers,
    projects: huProjects,
    payments: huPayments,
    widgets: huWidgets,
    "privacy-policy": huPrivacyPolicy,
  },
};

i18n.use(initReactI18next).init({
  resources,
  lng: "hu",
  fallbackLng: "en",
  defaultNS: "common",
  ns: [
    "common",
    "auth",
    "navigation",
    "dashboard",
    "seo",
    "users",
    "projects",
    "payments",
    "widgets",
    "privacy-policy",
  ],
  interpolation: { escapeValue: false },
});

export default i18n;

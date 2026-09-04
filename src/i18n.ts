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
import enForms from "./i18n/en/forms.json";
import enReservations from "./i18n/en/reservations.json";
import enAnalytics from "./i18n/en/analytics.json";
import enEnduser from "./i18n/en/enduser.json";
import enSubmissions from "./i18n/en/submissions.json";
import enBlog from "./i18n/en/blog.json";
import enFaq from "./i18n/en/faq.json";
import enService from "./i18n/en/service.json";
import enAiAssistant from "./i18n/en/ai-assistant.json";
import enImports from "./i18n/en/imports.json";
import enBulkEmail from "./i18n/en/bulk-email.json";
import enNotifications from "./i18n/en/notifications.json";
import enSettings from "./i18n/en/settings.json";

import huAuth from "./i18n/hu/auth.json";
import huCommon from "./i18n/hu/common.json";
import huNavigation from "./i18n/hu/navigation.json";
import huDashboard from "./i18n/hu/dashboard.json";
import huSeo from "./i18n/hu/seo.json";
import huUsers from "./i18n/hu/users.json";
import huProjects from "./i18n/hu/projects.json";
import huPayments from "./i18n/hu/payments.json";
import huForms from "./i18n/hu/forms.json";
import huReservations from "./i18n/hu/reservations.json";
import huAnalytics from "./i18n/hu/analytics.json";
import huEnduser from "./i18n/hu/enduser.json";
import huSubmissions from "./i18n/hu/submissions.json";
import huBlog from "./i18n/hu/blog.json";
import huFaq from "./i18n/hu/faq.json";
import huService from "./i18n/hu/service.json";
import huAiAssistant from "./i18n/hu/ai-assistant.json";
import huImports from "./i18n/hu/imports.json";
import huBulkEmail from "./i18n/hu/bulk-email.json";
import huNotifications from "./i18n/hu/notifications.json";
import huSettings from "./i18n/hu/settings.json";

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
    forms: enForms,
    reservations: enReservations,
    analytics: enAnalytics,
    enduser: enEnduser,
    submissions: enSubmissions,
    blog: enBlog,
    faq: enFaq,
    service: enService,
    "ai-assistant": enAiAssistant,
    imports: enImports,
    "bulk-email": enBulkEmail,
    notifications: enNotifications,
    settings: enSettings,
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
    forms: huForms,
    reservations: huReservations,
    analytics: huAnalytics,
    enduser: huEnduser,
    submissions: huSubmissions,
    blog: huBlog,
    faq: huFaq,
    service: huService,
    "ai-assistant": huAiAssistant,
    imports: huImports,
    "bulk-email": huBulkEmail,
    notifications: huNotifications,
    settings: huSettings,
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
    "imports",
    "projects",
    "payments",
    "forms",
    "reservations",
    "analytics",
    "enduser",
    "submissions",
    "blog",
    "faq",
    "service",
    "ai-assistant",
    "bulk-email",
    "notifications",
    "settings",
  ],
  interpolation: { escapeValue: false },
});

export default i18n;

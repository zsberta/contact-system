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
    "forms",
    "reservations",
    "analytics",
    "enduser",
    "submissions",
    "blog",
    "faq",
  ],
  interpolation: { escapeValue: false },
});

export default i18n;

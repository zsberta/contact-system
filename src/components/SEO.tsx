import React from "react";
import { Helmet } from "react-helmet-async";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";

interface SEOProps {
  title?: string;
  description?: string;
  keywords?: string;
  author?: string;
  image?: string;
  url?: string;
  type?: string;
  noindex?: boolean;
  canonical?: string;
  fallbackTitle?: string;
  fallbackDescription?: string;
  fallbackKeywords?: string;
}

const SEO: React.FC<SEOProps> = ({
  title,
  description,
  keywords,
  author,
  image,
  url,
  type = "website",
  noindex = false,
  canonical,
  fallbackTitle,
  fallbackDescription,
  fallbackKeywords,
}) => {
  const { t, i18n } = useTranslation(["seo", "common"]);
  const location = useLocation();
  const currentLanguage = i18n.language;

  // Default values
  const defaultTitle = t("common:app_title") || "Zsolt's CRM";
  const defaultDescription =
    t("common:app_description") ||
    "Zsolt's CRM - Adminisztrációs Rendszer / Contact Management System";
  const defaultAuthor = "Zsolt Berta";
  const defaultImage = "/logo.svg";
  const siteUrl = "https://crm.zsoltberta.hu";

  // Use provided values or fallbacks
  const finalTitle = String(title || fallbackTitle || defaultTitle);
  const finalDescription = String(
    description || fallbackDescription || defaultDescription,
  );
  const finalKeywords = String(
    keywords || fallbackKeywords || t("seo:keywords.default") || "zsolts-crm, admin, zsoltberta.hu",
  );
  const finalAuthor = String(author || defaultAuthor);
  const finalImage = String(image || defaultImage);
  const finalUrl = String(url ? `${siteUrl}${url}` : siteUrl);
  const finalCanonical = String(
    canonical ? `${siteUrl}${canonical}` : finalUrl,
  );

  return (
    <Helmet
      htmlAttributes={{
        lang: currentLanguage,
      }}
      title={finalTitle}
      meta={[
        {
          name: "description",
          content: finalDescription,
        },
        {
          name: "keywords",
          content: finalKeywords,
        },
        {
          name: "author",
          content: finalAuthor,
        },
        {
          property: "og:type",
          content: type,
        },
        {
          property: "og:url",
          content: finalUrl,
        },
        {
          property: "og:title",
          content: finalTitle,
        },
        {
          property: "og:description",
          content: finalDescription,
        },
        {
          property: "og:image",
          content: finalImage,
        },
        {
          name: "twitter:card",
          content: "summary_large_image",
        },
        {
          name: "twitter:url",
          content: finalUrl,
        },
        {
          name: "twitter:title",
          content: finalTitle,
        },
        {
          name: "twitter:description",
          content: finalDescription,
        },
        {
          name: "twitter:image",
          content: finalImage,
        },
        {
          name: "robots",
          content: noindex ? "noindex, nofollow" : "index, follow",
        },
      ]}
      link={[
        {
          rel: "canonical",
          href: finalCanonical,
        },
        {
          rel: "icon",
          type: "image/svg+xml",
          href: "/logo.svg",
        },
      ]}
    />
  );
};

export default SEO;

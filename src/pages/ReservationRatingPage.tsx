// ReservationRatingPage — public page where guests rate a past visit.
// Link comes from the rating-request email:
//   /embed/reservations/:secretToken/rate/:bookingToken
// Renders outside ProtectedRoute, uses only public rating endpoints.
// The guest's name is shown (comes from the booking) — no name input.
// After submit: 1-2 stars → empathetic message; 3-5 stars (+ project Google
// link) → invitation + button to the Google business page.

import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Star, Loader2, CheckCircle2, AlertCircle, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  publicGetRatingByToken,
  publicSubmitRatingByToken,
} from "@/lib/reservations";
import type { PublicRatingInfo } from "@/types/reservation";

type Status = "loading" | "error" | "form" | "done";

function StarInput({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const [hover, setHover] = useState(0);
  const active = hover || value;
  return (
    <div
      className="flex items-center gap-0 p-1"
      role="radiogroup"
      aria-label="rating"
      onMouseLeave={() => setHover(0)}
    >
      {[1, 2, 3, 4, 5].map((s) => (
        <button
          key={s}
          type="button"
          disabled={disabled}
          onClick={() => onChange(s)}
          onMouseEnter={() => setHover(s)}
          onFocus={() => setHover(s)}
          className="p-1 disabled:cursor-default transition-transform duration-150 ease-out hover:scale-110 active:scale-95"
          aria-label={`${s} / 5`}
        >
          <Star
            className={`h-9 w-9 transition-all duration-300 ease-out ${
              s <= active
                ? "fill-amber-400 text-amber-400 scale-110 drop-shadow-sm"
                : "text-muted-foreground/40 scale-100"
            }`}
          />
        </button>
      ))}
    </div>
  );
}

function formatDateTime(iso: string | null, locale: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale === "hu" ? "hu-HU" : "en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ReservationRatingPage() {
  const { t, i18n } = useTranslation(["reservations", "common"]);
  const { secretToken, bookingToken } = useParams<{
    secretToken: string;
    bookingToken: string;
  }>();

  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState("");
  const [info, setInfo] = useState<PublicRatingInfo | null>(null);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [googleUrl, setGoogleUrl] = useState<string | null>(null);

  const locale = i18n.language?.startsWith("hu") ? "hu" : "en";

  useEffect(() => {
    if (!secretToken || !bookingToken) {
      setError(t("reservations:rating_not_found"));
      setStatus("error");
      return;
    }
    publicGetRatingByToken(secretToken, bookingToken)
      .then((data) => {
        setInfo(data);
        setGoogleUrl(data.googleReviewUrl);
        if (data.alreadyRated || !data.canRate) {
          setStatus("done");
        } else {
          setStatus("form");
        }
      })
      .catch((e: Error) => {
        setError(e.message || t("reservations:rating_not_found"));
        setStatus("error");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secretToken, bookingToken]);

  const displayName = info
    ? [info.lastName, info.firstName].filter(Boolean).join(" ")
    : "";

  const handleSubmit = async () => {
    if (!secretToken || !bookingToken) return;
    if (rating < 1 || rating > 5) {
      setError(t("reservations:rating_required"));
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const res = await publicSubmitRatingByToken(secretToken, bookingToken, {
        rating,
        comment: comment.trim() || undefined,
      });
      setGoogleUrl(res.googleReviewUrl);
      setStatus("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common:error"));
    } finally {
      setSubmitting(false);
    }
  };

  const finalRating = info?.existingRating?.rating ?? rating;
  const showGoogle = finalRating >= 3 && !!googleUrl;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-lg">
        <CardContent className="pt-8 pb-8 px-6 sm:px-8">
          {status === "loading" && (
            <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
              <Loader2 className="h-5 w-5 animate-spin" />
              {t("common:loading")}
            </div>
          )}

          {status === "error" && (
            <div className="text-center space-y-3 py-6">
              <AlertCircle className="h-10 w-10 mx-auto text-destructive" />
              <h1 className="text-xl font-bold">{t("reservations:rating_page_title")}</h1>
              <p className="text-sm text-muted-foreground">{error}</p>
            </div>
          )}

          {status === "form" && info && (
            <div className="space-y-5">
              <div className="text-center space-y-2">
                <h1 className="text-2xl font-bold">{t("reservations:rating_page_title")}</h1>
                {displayName && (
                  <p className="text-lg font-medium">
                    {t("reservations:rating_page_greeting", { name: displayName })}
                  </p>
                )}
                <p className="text-sm text-muted-foreground">
                  {t("reservations:rating_page_intro")}
                </p>
                {(info.serviceName || info.startsAt) && (
                  <p className="text-sm text-muted-foreground">
                    {[info.serviceName, formatDateTime(info.startsAt, locale)]
                      .filter(Boolean)
                      .join(" · ")}
                    {info.projectName ? ` · ${info.projectName}` : ""}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label>{t("reservations:rating_select_label")}</Label>
                <div className="flex justify-center">
                  <StarInput value={rating} onChange={setRating} />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="rating-comment">{t("reservations:rating_comment_label")}</Label>
                <Textarea
                  id="rating-comment"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder={t("reservations:rating_comment_placeholder")}
                  maxLength={2000}
                  rows={4}
                />
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <Button
                type="button"
                className="w-full"
                size="lg"
                disabled={submitting || rating === 0}
                onClick={handleSubmit}
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    {t("reservations:rating_submitting")}
                  </>
                ) : (
                  t("reservations:rating_submit")
                )}
              </Button>
            </div>
          )}

          {status === "done" && (
            <div className="text-center space-y-4 py-4">
              <CheckCircle2 className="h-12 w-12 mx-auto text-green-600" />
              {info?.alreadyRated && !info?.existingRating ? (
                <p className="text-sm text-muted-foreground">{t("reservations:rating_already")}</p>
              ) : finalRating >= 3 ? (
                <>
                  <h1 className="text-2xl font-bold">{t("reservations:rating_thanks_high")}</h1>
                  <p className="text-sm text-muted-foreground">
                    {t("reservations:rating_thanks_high_message")}
                  </p>
                  {showGoogle && (
                    <Button asChild size="lg" className="w-full">
                      <a href={googleUrl!} target="_blank" rel="noopener noreferrer">
                        {t("reservations:rating_google_button")}
                        <ExternalLink className="h-4 w-4 ml-2" />
                      </a>
                    </Button>
                  )}
                </>
              ) : finalRating >= 1 ? (
                <>
                  <h1 className="text-2xl font-bold">{t("reservations:rating_thanks_low")}</h1>
                  <p className="text-sm text-muted-foreground">
                    {t("reservations:rating_thanks_low_message")}
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {info?.canRate === false && !info?.alreadyRated
                    ? t("reservations:rating_cannot")
                    : t("reservations:rating_already")}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      {/* ── Powered-by footer (same as the embedded booking page) ── */}
      <div className="text-center text-xs text-muted-foreground mt-8 pb-2">
        {locale === "hu" ? "Üzemelteti: " : "Powered by "}
        <a
          href="https://zsoltberta.hu/idopontfoglalo-rendszer/"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-foreground"
        >
          Berta Zsolt e.v.
        </a>
      </div>
    </div>
  );
}

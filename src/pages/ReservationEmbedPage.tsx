// ReservationEmbedPage — public iframe widget for reservation booking.
// Four states: Catalog → Details/Scheduling → Contact Form → Confirmation.
// Renders outside ProtectedRoute, uses only public API endpoints.

import { useState, useEffect, useCallback } from "react";
import { useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ArrowLeft, Clock, Users, CheckCircle2, AlertCircle, RotateCcw, Trash2, UserPlus } from "lucide-react";
import { publicSubmitServiceBooking, publicResolveReservationCustomerProfiles } from "@/lib/reservations";
import {
  readReservationProfileTokens,
  addReservationProfileToken,
  removeReservationProfileToken,
  createReservationProfileToken,
} from "@/lib/reservation-profiles";
import type { ReservationCustomerProfileDTO } from "@/types/reservation";

type ViewState = "catalog" | "scheduling" | "contact" | "confirmation";

interface CatalogService {
  id: number;
  name: string;
  description: string | null;
  durationMinutes: number;
  priceAmount: number;
  currency: string;
  capacity: number;
  workerName: string | null;
  imageUrl: string | null;
  fields: Array<{
    fieldKey: string;
    fieldType: string;
    required: boolean;
    label: string;
    placeholder: string | null;
  }>;
}

interface CatalogData {
  reservation: { id: number; title: string; embedTitle?: string; brandColor?: string; iframeWidth?: string; iframeHeight?: string; privacyPolicyUrl?: string | null; cookiePolicyUrl?: string | null; defaultLocale: string; timezone: string };
  services: CatalogService[];
}

interface Slot {
  startsAt: string;
  endsAt: string;
  date: string;
  startTime: string;
  endTime: string;
  capacity: number;
  remainingSeats: number;
}

interface AvailabilityData {
  timezone: string;
  days: Array<{ date: string; available: boolean }>;
  slots: Slot[];
}

/** Format a YYYY-MM-DD date string in Hungarian locale (e.g. "2026. augusztus 18."). */
function formatHungarianDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("hu-HU", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** Convert hex color (e.g. #0A2540) to HSL components (e.g. { h: 212, s: 73, l: 18 }). */
function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const raw = hex.replace("#", "");
  const bigint = parseInt(raw.length === 3 ? raw.split("").map(c => c + c).join("") : raw, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  const rf = r / 255, gf = g / 255, bf = b / 255;
  const max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf);
  const d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return { h: 0, s: 0, l: Math.round(l * 100) };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rf) h = ((gf - bf) / d + (gf < bf ? 6 : 0)) / 6;
  else if (max === gf) h = ((bf - rf) / d + 2) / 6;
  else h = ((rf - gf) / d + 4) / 6;
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/** Mask email for display: "a***@example.com" */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return email;
  return `${email[0]}***${email.slice(at)}`;
}

/** Mask phone for display: last 4 digits visible */
function maskPhone(phone: string): string {
  if (phone.length <= 4) return phone;
  return `${"*".repeat(phone.length - 4)}${phone.slice(-4)}`;
}

// ── profile UI translations ──────────────────────────────────────────────────
const PROFILE_COPY: Record<string, Record<string, string>> = {
  en: {
    savedProfiles: "Saved profiles",
    selectProfile: "Use saved profile",
    newEntry: "Enter new details",
    rememberMe: "Remember my details for this browser",
    rememberHint: "Stored locally in this browser only",
    deleteProfile: "Remove",
    deleteTitle: "Remove saved profile?",
    deleteDescription: "This only removes the saved entry from this browser. Your customer data on the server is not affected.",
    cancel: "Cancel",
    confirm: "Remove",
    storageUnavailable: "Profile saving is unavailable in this browser",
  },
  hu: {
    savedProfiles: "Mentett profilok",
    selectProfile: "Mentett profil használata",
    newEntry: "Új adatok megadása",
    rememberMe: "Adataim megjegyzése ebben a böngészőben",
    rememberHint: "Csak ebben a böngészőben tárolva",
    deleteProfile: "Eltávolítás",
    deleteTitle: "Eltávolítod a mentett profilt?",
    deleteDescription: "Ez csak a böngészőben tárolt bejegyzést távolítja el. A szerveren lévő ügyféladatok nem változnak.",
    cancel: "Mégse",
    confirm: "Eltávolítás",
    storageUnavailable: "A profilmentés nem érhető el ebben a böngészőben",
  },
};

function profileCopy(locale: string, key: string): string {
  const lang = locale?.startsWith("hu") ? "hu" : "en";
  return PROFILE_COPY[lang]?.[key] || PROFILE_COPY.en[key] || key;

}
// ── consent checkbox translations ─────────────────────────────────────────────
const CONSENT_COPY: Record<string, Record<string, string>> = {
  en: {
    privacyOnly: "I accept the ",
    cookieOnly: "I accept the ",
    both: "I accept the ",
    and: " and the ",
    period: ".",
    privacyLinkText: "Privacy Policy",
    cookieLinkText: "Cookie Policy",
  },
  hu: {
    privacyOnly: "Elfogadom az ",
    cookieOnly: "Elfogadom a ",
    both: "Elfogadom az ",
    and: " és a ",
    period: ".",
    privacyLinkText: "Adatvédelmi tájékoztatót",
    cookieLinkText: "Süti tájékoztatót",
  },
};

function consentCopy(locale: string, key: string): string {
  const lang = locale?.startsWith("hu") ? "hu" : "en";
  return CONSENT_COPY[lang]?.[key] || CONSENT_COPY.en[key] || key;
}

// ── error message translations ────────────────────────────────────────────────
const ERROR_TRANSLATIONS: Record<string, Record<string, string>> = {
  en: {
    "Network error": "Network error",
    "Booking failed": "Booking failed",
    "Internal server error": "Something went wrong. Please try again.",
    "Slot already booked": "This time slot is already booked. Please choose another.",
    "firstName is required": "First name is required",
    "lastName is required": "Last name is required",
    "email is required": "Email is required",
    "email is invalid": "Please enter a valid email address",
    "phone is required": "Phone number is required",
    "No active service found": "No active service found",
    "Invalid or inactive service": "Invalid or inactive service",
    "startsAt and endsAt must be ISO 8601 UTC": "Invalid time selection",
    "endsAt must be after startsAt": "End time must be after start time",
    "Erre az időpontra már van foglalásod.": "You already have a booking for this time slot.",
  },
  hu: {
    "Network error": "Hálózati hiba",
    "Booking failed": "Foglalás sikertelen",
    "Internal server error": "Valami hiba történt. Kérlek, próbáld újra.",
    "Slot already booked": "Ez az időpont már foglalt. Kérjük, válassz másikat.",
    "firstName is required": "A keresztnév megadása kötelező",
    "lastName is required": "A vezetéknév megadása kötelező",
    "email is required": "Az e-mail cím megadása kötelező",
    "email is invalid": "Kérjük, adj meg egy érvényes e-mail címet",
    "phone is required": "A telefonszám megadása kötelező",
    "No active service found": "Nem található aktív szolgáltatás",
    "Invalid or inactive service": "Érvénytelen vagy inaktív szolgáltatás",
    "startsAt and endsAt must be ISO 8601 UTC": "Érvénytelen időpont kiválasztás",
    "endsAt must be after startsAt": "A befejezési időnek a kezdési idő után kell lennie",
    "Erre az időpontra már van foglalásod.": "Erre az időpontra már van foglalásod.",
  },
};

function translateError(message: string, locale: string): string {
  const lang = locale?.startsWith("hu") ? "hu" : "en";
  return ERROR_TRANSLATIONS[lang]?.[message] || message;
}

export default function ReservationEmbedPage() {
  const { secretToken } = useParams<{ secretToken: string }>();

  const [view, setView] = useState<ViewState>("catalog");
  const [catalog, setCatalog] = useState<CatalogData | null>(null);
  const [selectedService, setSelectedService] = useState<CatalogService | null>(null);
  const [availability, setAvailability] = useState<AvailabilityData | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [currentMonth, setCurrentMonth] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [contact, setContact] = useState({
    firstName: "", lastName: "", email: "", phone: "", comment: "",
  });
  const [customFields, setCustomFields] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [bookingId, setBookingId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  // ── profile state ──────────────────────────────────────────────────────────
  const [savedProfiles, setSavedProfiles] = useState<ReservationCustomerProfileDTO[]>([]);
  const [selectedProfileToken, setSelectedProfileToken] = useState<string | null>(null);
  const [rememberCustomer, setRememberCustomer] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ReservationCustomerProfileDTO | null>(null);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [consentAccepted, setConsentAccepted] = useState(false);

  // Check localStorage availability once
  useEffect(() => {
    try {
      const testKey = "__nexus_profile_test__";
      localStorage.setItem(testKey, "1");
      localStorage.removeItem(testKey);
      setStorageAvailable(true);
    } catch {
      setStorageAvailable(false);
    }
  }, []);

  // Load catalog
  useEffect(() => {
    if (!secretToken) return;
    fetch(`/api/public/reservations/${secretToken}/catalog`)
      .then((r) => r.json())
      .then((data) => { if (data.services) setCatalog(data); })
      .catch(() => setError(translateError("Network error", "hu")));
  }, [secretToken]);

  // ── load saved profiles on mount ───────────────────────────────────────────
  useEffect(() => {
    if (!secretToken || !storageAvailable) return;
    const tokens = readReservationProfileTokens(secretToken);
    if (tokens.length === 0) return;

    publicResolveReservationCustomerProfiles(secretToken, tokens)
      .then((res) => {
        setSavedProfiles(res.profiles || []);
        // Remove stale tokens that didn't resolve
        const resolvedTokens = (res.profiles || []).map((p) => p.profileToken);
        const staleTokens = tokens.filter((t) => !resolvedTokens.includes(t));
        if (staleTokens.length > 0) {
          for (const t of staleTokens) removeReservationProfileToken(secretToken, t);
        }
      })
      .catch(() => {
        // Profile resolution failure is non-blocking
      });
  }, [secretToken, storageAvailable]);

  // ── select a saved profile ─────────────────────────────────────────────────
  function handleSelectProfile(profile: ReservationCustomerProfileDTO) {
    setSelectedProfileToken(profile.profileToken);
    setRememberCustomer(true);
    setContact({
      firstName: profile.firstName,
      lastName: profile.lastName,
      email: profile.email,
      phone: profile.phone,
      comment: contact.comment,
    });
  }

  // ── switch to manual entry ─────────────────────────────────────────────────
  function handleManualEntry() {
    setSelectedProfileToken(null);
    setRememberCustomer(false);
    setConsentAccepted(false);
    setContact({ firstName: "", lastName: "", email: "", phone: "", comment: "" });
  }

  // ── delete a profile (browser-only) ────────────────────────────────────────
  function confirmDeleteProfile() {
    if (!secretToken || !deleteTarget) return;
    removeReservationProfileToken(secretToken, deleteTarget.profileToken);
    setSavedProfiles((prev) => prev.filter((p) => p.profileToken !== deleteTarget.profileToken));
    if (selectedProfileToken === deleteTarget.profileToken) {
      setSelectedProfileToken(null);
      setRememberCustomer(false);
    }
    setDeleteTarget(null);
  }

  // Load availability when service and month change
  const loadAvailability = useCallback(async () => {
    if (!secretToken || !selectedService) return;
    const from = `${currentMonth.year}-${String(currentMonth.month + 1).padStart(2, "0")}-01`;
    const lastDay = new Date(currentMonth.year, currentMonth.month + 1, 0).getDate();
    const to = `${currentMonth.year}-${String(currentMonth.month + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    try {
      const res = await fetch(
        `/api/public/reservations/${secretToken}/services/${selectedService.id}/availability?from=${from}&to=${to}`,
      );
      const data = await res.json();
      if (data.slots) setAvailability(data);
    } catch { /* ignore */ }
  }, [secretToken, selectedService, currentMonth]);

  useEffect(() => { loadAvailability(); }, [loadAvailability]);

  // Submit booking
  async function handleSubmit() {
    if (!secretToken || !selectedService || !selectedSlot) return;
    setLoading(true);
    setError(null);

    // Generate a profile token if remembering and no existing profile selected
    const profileToken = rememberCustomer && !selectedProfileToken
      ? createReservationProfileToken()
      : selectedProfileToken;

    try {
      const data = await publicSubmitServiceBooking(secretToken, {
        serviceId: selectedService.id,
        startsAt: selectedSlot.startsAt,
        endsAt: selectedSlot.endsAt,
        locale: catalog?.reservation.defaultLocale || "hu",
        firstName: contact.firstName,
        lastName: contact.lastName,
        email: contact.email,
        phone: contact.phone,
        comment: contact.comment || undefined,
        fields: Object.keys(customFields).length > 0 ? customFields : undefined,
        rememberCustomer,
        customerProfileToken: profileToken || undefined,
      });
      if (data.id) {
        setBookingId(data.id);
        // If server returned a profile, persist the token locally
        if (data.customerProfile && storageAvailable) {
          addReservationProfileToken(secretToken, data.customerProfile.profileToken);
          setSavedProfiles((prev) => {
            const exists = prev.find((p) => p.profileToken === data.customerProfile.profileToken);
            if (exists) {
              return prev.map((p) => p.profileToken === data.customerProfile.profileToken ? data.customerProfile : p);
            }
            return [data.customerProfile, ...prev];
          });
          setSelectedProfileToken(data.customerProfile.profileToken);
        }
        setView("confirmation");
      } else {
        setError(translateError("Booking failed", catalog?.reservation.defaultLocale || "hu"));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Booking failed";
      setError(translateError(msg, catalog?.reservation.defaultLocale || "hu"));
    } finally {
      setLoading(false);
    }
  }

  // Calendar grid
  const daysInMonth = new Date(currentMonth.year, currentMonth.month + 1, 0).getDate();
  const firstDayOfWeek = new Date(currentMonth.year, currentMonth.month, 1).getDay();
  const calendarDays = Array.from({ length: daysInMonth }, (_, i) => {
    const day = i + 1;
    const dateStr = `${currentMonth.year}-${String(currentMonth.month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const dayData = availability?.days.find((d) => d.date === dateStr);
    return { day, dateStr, available: dayData?.available ?? false };
  });

  const locale = catalog?.reservation.defaultLocale || "hu";
  const hasConsentLinks = !!(catalog?.reservation.privacyPolicyUrl || catalog?.reservation.cookiePolicyUrl);
  const consentText = catalog ? (() => {
    const hasPrivacy = !!catalog?.reservation.privacyPolicyUrl;
    const hasCookie = !!catalog?.reservation.cookiePolicyUrl;
    if (hasPrivacy && hasCookie) {
      return (
        <>
          {consentCopy(locale, "both")}
          <a href={catalog.reservation.privacyPolicyUrl!} target="_blank" rel="noopener noreferrer" className="underline text-primary hover:text-primary/80">{consentCopy(locale, "privacyLinkText")}</a>
          {consentCopy(locale, "and")}
          <a href={catalog.reservation.cookiePolicyUrl!} target="_blank" rel="noopener noreferrer" className="underline text-primary hover:text-primary/80">{consentCopy(locale, "cookieLinkText")}</a>
          {consentCopy(locale, "period")}
        </>
      );
    } else if (hasPrivacy) {
      return (
        <>
          {consentCopy(locale, "privacyOnly")}
          <a href={catalog.reservation.privacyPolicyUrl!} target="_blank" rel="noopener noreferrer" className="underline text-primary hover:text-primary/80">{consentCopy(locale, "privacyLinkText")}</a>
          {consentCopy(locale, "period")}
        </>
      );
    } else {
      return (
        <>
          {consentCopy(locale, "cookieOnly")}
          <a href={catalog.reservation.cookiePolicyUrl!} target="_blank" rel="noopener noreferrer" className="underline text-primary hover:text-primary/80">{consentCopy(locale, "cookieLinkText")}</a>
          {consentCopy(locale, "period")}
        </>
      );
    }
  })() : null;

  return (
    <div className="min-h-screen p-4 md:p-6">
      {/* Header */}
      {catalog && (
        <div className="max-w-5xl mx-auto mb-6">
          <h1 className="text-2xl font-bold">
            {catalog.reservation.embedTitle || catalog.reservation.title}
          </h1>
        </div>
      )}

      {/* Catalog View */}
      {view === "catalog" && catalog && (
        <div className="max-w-5xl mx-auto grid gap-4 md:grid-cols-2">
          {catalog.services.map((service) => (
            <Card
              key={service.id}
              className="cursor-pointer hover:shadow-md transition-shadow overflow-hidden"
              onClick={() => { setSelectedService(service); setView("scheduling"); setSelectedDate(""); }}
            >
              <div className="flex">
                {service.imageUrl && (
                  <img src={service.imageUrl} alt={service.name} className="w-28 sm:w-32 aspect-[4/5] object-cover shrink-0" />
                )}
                <CardContent className="p-4 space-y-2 flex-1 min-w-0">
                  <h3 className="font-semibold text-base">{service.name}</h3>
                  {service.workerName && (
                    <Badge
                      className="text-xs font-medium w-fit"
                      style={catalog?.reservation.brandColor ? { backgroundColor: catalog.reservation.brandColor, color: "#fff" } : undefined}
                    >
                      {service.workerName}
                    </Badge>
                  )}
                  {service.description && <p className="text-sm text-muted-foreground line-clamp-2">{service.description}</p>}
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary"><Clock className="h-3 w-3 mr-1 inline" />{service.durationMinutes} perc</Badge>
                    <Badge variant="secondary"><Users className="h-3 w-3 mr-1 inline" />{service.capacity} hely</Badge>
                    {service.priceAmount > 0 && (
                      <Badge variant="secondary">{service.priceAmount.toLocaleString("hu-HU")} {service.currency}</Badge>
                    )}
                  </div>
                </CardContent>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Scheduling View */}
      {view === "scheduling" && selectedService && (
        <div className="max-w-5xl mx-auto">
          <Button variant="ghost" onClick={() => { setView("catalog"); setSelectedService(null); setSelectedSlot(null); }} className="mb-2">
            <ArrowLeft className="mr-2 h-4 w-4" />{locale === "en" ? "Back" : "Vissza"}
          </Button>

          <div className="grid gap-6 md:grid-cols-[280px_1fr]">
            {/* Service detail card — left side */}
            <div className="space-y-4">
              <Card className="overflow-hidden">
                {selectedService.imageUrl && (
                  <img src={selectedService.imageUrl} alt={selectedService.name} className="w-full h-36 object-cover" />
                )}
                <CardContent className="p-4 space-y-2">
                  <h3 className="font-semibold">{selectedService.name}</h3>
                  {selectedService.workerName && (
                    <Badge
                      className="text-xs font-medium"
                      style={catalog?.reservation.brandColor ? { backgroundColor: catalog.reservation.brandColor, color: "#fff" } : undefined}
                    >
                      {selectedService.workerName}
                    </Badge>
                  )}
                  {selectedService.description && <p className="text-sm text-muted-foreground whitespace-pre-wrap">{selectedService.description}</p>}
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary"><Clock className="h-3 w-3 mr-1 inline" />{selectedService.durationMinutes} perc</Badge>
                    <Badge variant="secondary"><Users className="h-3 w-3 mr-1 inline" />{selectedService.capacity} hely</Badge>
                    {selectedService.priceAmount > 0 && (
                      <Badge variant="secondary">{selectedService.priceAmount.toLocaleString("hu-HU")} {selectedService.currency}</Badge>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Calendar + slots — right side */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <Button
                  variant="ghost"
                  size="sm"
                  style={catalog?.reservation.brandColor ? { color: catalog.reservation.brandColor } : undefined}
                  onClick={() => setCurrentMonth((m) => {
                    const d = new Date(m.year, m.month - 1);
                    return { year: d.getFullYear(), month: d.getMonth() };
                  })}
                >←</Button>
                <h3 className="font-medium capitalize">
                  {new Date(currentMonth.year, currentMonth.month).toLocaleDateString(locale === "en" ? "en-US" : "hu-HU", { month: "long", year: "numeric" })}
                </h3>
                <Button
                  variant="ghost"
                  size="sm"
                  style={catalog?.reservation.brandColor ? { color: catalog.reservation.brandColor } : undefined}
                  onClick={() => setCurrentMonth((m) => {
                    const d = new Date(m.year, m.month + 1);
                    return { year: d.getFullYear(), month: d.getMonth() };
                  })}
                >→</Button>
              </div>

              <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground">
                {["H", "K", "S", "C", "P", "S", "V"].map((d) => <div key={d} className="py-1">{d}</div>)}
              </div>

              <div className="grid grid-cols-7 gap-1">
                {Array.from({ length: (firstDayOfWeek + 6) % 7 }).map((_, i) => <div key={`empty-${i}`} />)}
                {calendarDays.map(({ day, dateStr, available }) => {
                  const isSelected = selectedDate === dateStr;
                  return (
                    <Button
                      key={day}
                      variant={isSelected ? "default" : "ghost"}
                      size="sm"
                      className={`h-9 ${!available ? "opacity-30 cursor-not-allowed" : ""}`}
                      disabled={!available}
                      style={isSelected && catalog?.reservation.brandColor ? { backgroundColor: catalog.reservation.brandColor, color: "#fff", borderColor: catalog.reservation.brandColor } : undefined}
                      onClick={() => { setSelectedDate(dateStr); setSelectedSlot(null); }}
                    >
                      {day}
                    </Button>
                  );
                })}
              </div>

              {/* Slots below calendar */}
              {selectedDate && availability && (
                <div className="space-y-3 pt-2 border-t">
                  <h3 className="font-medium text-sm">{formatHungarianDate(selectedDate)}</h3>
                  <div className="grid grid-cols-3 gap-2">
                    {availability.slots.filter((s) => s.date === selectedDate).map((slot) => {
                      const isSelected = selectedSlot?.startsAt === slot.startsAt;
                      const hasSeats = slot.remainingSeats > 0;
                      return (
                        <button
                          key={slot.startsAt}
                          className={`rounded-lg border p-3 text-center text-sm transition-colors ${isSelected ? "border-transparent text-white" : "border-border hover:border-primary/50"} ${!hasSeats ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
                          disabled={!hasSeats}
                          style={isSelected && catalog?.reservation.brandColor ? { backgroundColor: catalog.reservation.brandColor, borderColor: catalog.reservation.brandColor } : undefined}
                          onClick={() => { setSelectedSlot(slot); setView("contact"); setSelectedProfileToken(null); setRememberCustomer(false); }}
                        >
                          <p className="font-medium">{slot.startTime}</p>
                          <p className={`text-xs mt-1 ${isSelected ? "text-white/80" : "text-muted-foreground"}`}>
                            {slot.remainingSeats} hely
                          </p>
                        </button>
                      );
                    })}
                  </div>
                  {availability.slots.filter((s) => s.date === selectedDate).length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      {catalog?.reservation.defaultLocale === "en"
                        ? "No available slots on this day."
                        : "Nincs elérhető időpont ezen a napon."}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Contact Form View */}
      {view === "contact" && selectedService && selectedSlot && (
        <div className="max-w-lg mx-auto space-y-6">
          <Button variant="ghost" onClick={() => setView("scheduling")} className="mb-2">
            <ArrowLeft className="mr-2 h-4 w-4" />Vissza
          </Button>

          <Card className="overflow-hidden">
            <div className="flex">
              {selectedService.imageUrl && (
                <img src={selectedService.imageUrl} alt={selectedService.name} className="w-24 sm:w-28 aspect-[4/5] object-cover shrink-0" />
              )}
              <CardContent className="p-4 space-y-1 flex-1 min-w-0">
                <p className="font-medium">{selectedService.name}</p>
                <p className="text-sm text-muted-foreground">
                  {formatHungarianDate(selectedSlot.date)}
                </p>
                <p className="text-sm text-muted-foreground">
                  {selectedSlot.startTime} – {selectedSlot.endTime}
                </p>
                {selectedService.priceAmount > 0 && (
                  <Badge variant="secondary" className="mt-1">{selectedService.priceAmount.toLocaleString("hu-HU")} {selectedService.currency}</Badge>
                )}
              </CardContent>
            </div>
          </Card>

          <div className="space-y-4">
            {/* ── Saved profiles ──────────────────────────────────────────── */}
            {savedProfiles.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground">{profileCopy(locale, "savedProfiles")}</p>
                {savedProfiles.map((profile) => (
                  <div
                    key={profile.profileToken}
                    className={`flex items-center justify-between p-3 rounded-lg border cursor-pointer transition-colors ${
                      selectedProfileToken === profile.profileToken
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-muted/50"
                    }`}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleSelectProfile(profile); } }}
                    onClick={() => handleSelectProfile(profile)}
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-sm">{profile.firstName} {profile.lastName}</p>
                      <p className="text-xs text-muted-foreground truncate">{maskEmail(profile.email)} · {maskPhone(profile.phone)}</p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0 ml-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-destructive hover:text-destructive"
                        onClick={(e) => { e.stopPropagation(); setDeleteTarget(profile); }}
                        title={profileCopy(locale, "deleteProfile")}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full text-sm"
                  onClick={handleManualEntry}
                >
                  <UserPlus className="mr-2 h-3.5 w-3.5" />
                  {profileCopy(locale, "newEntry")}
                </Button>
              </div>
            )}

            {/* ── Contact fields ─────────────────────────────────────────── */}
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Vezetéknév <span className="text-red-500">*</span></Label><Input value={contact.lastName} onChange={(e) => setContact({ ...contact, lastName: e.target.value })} /></div>
              <div><Label>Keresztnév <span className="text-red-500">*</span></Label><Input value={contact.firstName} onChange={(e) => setContact({ ...contact, firstName: e.target.value })} /></div>
            </div>
            <div><Label>E-mail <span className="text-red-500">*</span></Label><Input type="email" value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} /></div>
            <div><Label>Telefonszám <span className="text-red-500">*</span></Label><Input value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} /></div>
            <div><Label>Megjegyzés</Label><Textarea value={contact.comment} onChange={(e) => setContact({ ...contact, comment: e.target.value })} rows={2} /></div>

            {selectedService.fields?.map((f) => (
              <div key={f.fieldKey}>
                <Label>{f.label}{f.required ? <span className="text-red-500"> *</span> : ""}</Label>
                {f.fieldType === "textarea" ? (
                  <Textarea value={String(customFields[f.fieldKey] || "")} onChange={(e) => setCustomFields({ ...customFields, [f.fieldKey]: e.target.value })} />
                ) : f.fieldType === "checkbox" ? (
                  <input type="checkbox" checked={!!customFields[f.fieldKey]} onChange={(e) => setCustomFields({ ...customFields, [f.fieldKey]: e.target.checked })} />
                ) : (
                  <Input value={String(customFields[f.fieldKey] || "")} onChange={(e) => setCustomFields({ ...customFields, [f.fieldKey]: e.target.value })} placeholder={f.placeholder || ""} />
                )}
              </div>
            ))}

            {/* ── Remember me checkbox ────────────────────────────────────── */}
            {storageAvailable && (
              <div className="flex items-center gap-2">
                <Checkbox
                  id="remember-customer"
                  checked={rememberCustomer}
                  onCheckedChange={(checked) => setRememberCustomer(checked === true)}
                  className="mt-0.5"
                />
                <label htmlFor="remember-customer" className="text-sm font-medium cursor-pointer leading-tight">
                  {profileCopy(locale, "rememberMe")}
                  <span className="block text-xs text-muted-foreground font-normal">{profileCopy(locale, "rememberHint")}</span>
                </label>
              </div>
            )}
            {!storageAvailable && (
              <p className="text-xs text-muted-foreground">{profileCopy(locale, "storageUnavailable")}</p>
            )}

            {/* ── Consent checkbox (privacy/cookie policy) ─────────────────── */}
            {hasConsentLinks && (
              <div className="flex items-center gap-2">
                <Checkbox
                  id="consent-accepted"
                  checked={consentAccepted}
                  onCheckedChange={(checked) => setConsentAccepted(checked === true)}
                  className="mt-0.5"
                />
                <label htmlFor="consent-accepted" className="text-sm font-medium cursor-pointer leading-tight">
                  {consentText} <span className="text-red-500">*</span>
                </label>
              </div>
            )}

            {error && (
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />{error}
              </div>
            )}

            <Button
              className="w-full"
              onClick={handleSubmit}
              disabled={loading || !contact.firstName || !contact.lastName || !contact.email || !contact.phone || (hasConsentLinks && !consentAccepted)}
              style={catalog?.reservation.brandColor ? { backgroundColor: catalog.reservation.brandColor, color: "#fff" } : undefined}
            >
              {loading ? "Foglalás..." : "Foglalás megerősítése"}
            </Button>
          </div>
        </div>
      )}

      {/* Confirmation View */}
      {view === "confirmation" && (
        <div className="max-w-lg mx-auto text-center space-y-4 py-12">
          <CheckCircle2 className="h-16 w-16 text-green-500 mx-auto" />
          <h2 className="text-2xl font-bold">Foglalás megerősítve!</h2>
          <p className="text-muted-foreground">
            Foglalás azonosító: <strong>#{bookingId}</strong>
          </p>
          <p className="text-muted-foreground">
            {selectedService?.name} — {selectedSlot ? `${formatHungarianDate(selectedSlot.date)} ${selectedSlot.startTime} – ${selectedSlot.endTime}` : ""}
          </p>
          <p className="text-sm text-muted-foreground">
            Visszaigazoló e-mailt küldtünk a megadott címre.
          </p>
          <Button
            variant="outline"
            onClick={() => {
              setSelectedService(null);
              setSelectedSlot(null);
              setBookingId(null);
              setContact({ firstName: "", lastName: "", email: "", phone: "", comment: "" });
              setCustomFields({});
              setError(null);
              setSelectedProfileToken(null);
              setRememberCustomer(false);
              setConsentAccepted(false);
              setView("catalog");
            }}
            className="mt-4"
          >
            <RotateCcw className="mr-2 h-4 w-4" />Vissza az elejére
          </Button>
        </div>
      )}

      {/* ── Delete profile confirmation dialog ──────────────────────────── */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{profileCopy(locale, "deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {profileCopy(locale, "deleteDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{profileCopy(locale, "cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDeleteProfile} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {profileCopy(locale, "confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

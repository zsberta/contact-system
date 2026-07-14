// ----------------------------------------------------------------------------
// ReservationBookingsPage — bookings list tab, rendered as a standalone page
// with the same tab nav bar as ReservationViewPage.
// ----------------------------------------------------------------------------

import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { NavLink, useParams } from "react-router-dom";
import { Loader2, CalendarDays, List, FileText, FileUp, Ban, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { getReservationById } from "@/lib/reservations";
import { ReservationBookingsList } from "@/components/reservations/ReservationBookingsList";

const TAB_LINK_CLASS =
  "inline-flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground";
const TAB_LINK_ACTIVE =
  "bg-primary text-primary-foreground shadow hover:bg-primary/90 hover:text-primary-foreground";

export default function ReservationBookingsPage() {
  const { t } = useTranslation(["reservations", "common"]);
  const { id } = useParams<{ id: string }>();
  const reservationId = id ? Number.parseInt(id) : null;

  const { data: reservation, isLoading } = useQuery({
    queryKey: ["reservations", reservationId],
    queryFn: () => getReservationById(reservationId!),
    enabled: !!reservationId,
  });

  if (!reservationId) {
    return <div className="text-center p-8">{t("common:invalid_id")}</div>;
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6 w-full">
      {/* Tab navigation */}
      <nav className="flex gap-1 border-b pb-px">
        <NavLink
          to={`/reservations/view/${reservationId}`}
          end
          className={({ isActive: active }) =>
            cn(TAB_LINK_CLASS, active && TAB_LINK_ACTIVE)
          }
        >
          <FileText className="h-4 w-4" />
          {t("reservations:details_tab")}
        </NavLink>
        <NavLink
          to={`/reservations/view/${reservationId}/bookings`}
          end
          className={({ isActive: active }) =>
            cn(TAB_LINK_CLASS, active && TAB_LINK_ACTIVE)
          }
        >
          <List className="h-4 w-4" />
          {t("reservations:bookings_tab")}
        </NavLink>
        <NavLink
          to={`/reservations/view/${reservationId}/bookings/import`}
          className={({ isActive: active }) =>
            cn(TAB_LINK_CLASS, active && TAB_LINK_ACTIVE)
          }
        >
          <FileUp className="h-4 w-4" />
          {t("reservations:import_tab")}
        </NavLink>
        <NavLink
          to={`/reservations/view/${reservationId}/calendar`}
          className={({ isActive: active }) =>
            cn(TAB_LINK_CLASS, active && TAB_LINK_ACTIVE)
          }
        >
          <CalendarDays className="h-4 w-4" />
          {t("reservations:calendar_tab")}
        </NavLink>
        <NavLink
          to={`/reservations/view/${reservationId}/schedules`}
          className={({ isActive: active }) =>
            cn(TAB_LINK_CLASS, active && TAB_LINK_ACTIVE)
          }
        >
          <Clock className="h-4 w-4" />
          {t("reservations:schedules_tab")}
        </NavLink>
        <NavLink
          to={`/reservations/view/${reservationId}/blocked`}
          className={({ isActive: active }) =>
            cn(TAB_LINK_CLASS, active && TAB_LINK_ACTIVE)
          }
        >
          <Ban className="h-4 w-4" />
          {t("reservations:blocked_tab")}
        </NavLink>
      </nav>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
          <Loader2 className="h-5 w-5 animate-spin" />
          {t("common:loading")}
        </div>
      ) : (
        <ReservationBookingsList reservationId={reservationId} />
      )}
    </div>
  );
}

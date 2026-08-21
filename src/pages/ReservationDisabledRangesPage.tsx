// ----------------------------------------------------------------------------
// ReservationDisabledRangesPage — disabled ranges tab, rendered as a
// standalone page with the same tab nav bar as ReservationViewPage.
// ----------------------------------------------------------------------------

import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useModuleResolution } from "@/hooks/useModuleResolution";
import { getReservationById } from "@/lib/reservations";
import { DisabledRangesTab } from "@/components/reservations/DisabledRangesTab";

export default function ReservationDisabledRangesPage() {
  const { t } = useTranslation(["reservations", "common"]);
  const { resourceId: reservationId } = useModuleResolution();

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
      <DisabledRangesTab reservationId={reservationId} />
    </div>
  );
}

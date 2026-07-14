// PortalIndexRedirect — redirects /portal to the first available page
// based on what the selected project has. Priority: analytics > forms
// (submissions) > reservations > submissions (fallback). Analytics is
// the most useful summary view for the enduser so it wins ties.
//
// IMPORTANT: we must wait for ALL three queries to settle before
// deciding. If we fire on the first one to resolve, formsData can win
// the race against analyticsData (forms usually resolve from a warm
// cache; analytics often misses on cold load). isPending=false is the
// "settled" signal — true once the query has either returned data or
// errored out.

import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useProjectContext } from "@/context/ProjectContext";
import { getAllFormsPaged } from "@/lib/forms";
import { getAllReservationsPaged } from "@/lib/reservations";
import { getAllAnalyticsConfigsPaged } from "@/lib/analytics";

export default function PortalIndexRedirect() {
  const navigate = useNavigate();
  const { selectedId: projectId, isLoading: projectsLoading } = useProjectContext();

  const { data: formsData, isPending: formsPending } = useQuery({
    queryKey: ["portal", "sidebar-has-forms", projectId],
    queryFn: () =>
      getAllFormsPaged({
        projectId: projectId!,
        page: 0,
        size: 1,
        sortField: "name",
        sortOrder: "asc",
      }),
    enabled: !!projectId,
  });

  const { data: reservationsData, isPending: reservationsPending } = useQuery({
    queryKey: ["portal", "sidebar-has-reservations", projectId],
    queryFn: () =>
      getAllReservationsPaged({
        projectId: projectId!,
        page: 0,
        size: 1,
        sortField: "name",
        sortOrder: "asc",
      }),
    enabled: !!projectId,
  });

  const { data: analyticsData, isPending: analyticsPending } = useQuery({
    queryKey: ["portal", "sidebar-has-analytics", projectId],
    queryFn: () =>
      getAllAnalyticsConfigsPaged({
        projectId: projectId!,
        page: 0,
        size: 1,
      }),
    enabled: !!projectId,
  });

  useEffect(() => {
    if (projectsLoading || !projectId) return;
    // Wait for every query to settle (success OR error) before deciding.
    // Without this guard, formsData can resolve first and we'd redirect
    // to /portal/submissions even when analytics is enabled.
    if (formsPending || reservationsPending || analyticsPending) return;

    const hasAnalytics = (analyticsData?.totalElements ?? 0) > 0;
    const hasForms = (formsData?.totalElements ?? 0) > 0;
    const hasReservations = (reservationsData?.totalElements ?? 0) > 0;

    if (hasAnalytics) {
      navigate("/portal/analytics", { replace: true });
    } else if (hasForms) {
      navigate("/portal/submissions", { replace: true });
    } else if (hasReservations) {
      navigate("/portal/reservations", { replace: true });
    } else {
      // Nothing configured — still go to submissions (will show empty).
      navigate("/portal/submissions", { replace: true });
    }
  }, [
    projectsLoading,
    projectId,
    formsPending,
    reservationsPending,
    analyticsPending,
    formsData,
    reservationsData,
    analyticsData,
    navigate,
  ]);

  return (
    <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
      <Loader2 className="h-5 w-5 animate-spin" />
    </div>
  );
}
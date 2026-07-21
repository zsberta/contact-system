import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Index from "./pages/Index";
import NotFound from "./pages/NotFound";
import NoPermissionPage from "./pages/NoPermissionPage";
import CrashPage from "./pages/CrashPage";
import LoginPage from "./pages/Login";
import DashboardPage from "./pages/Dashboard";
import UsersPage from "./pages/UsersPage";
import UserCreatePage from "./pages/UserCreatePage";
import UserEditPage from "./pages/UserEditPage";
import UserViewPage from "./pages/UserViewPage";
import ProjectsPage from "./pages/ProjectsPage";
import ProjectCreatePage from "./pages/ProjectCreatePage";
import ProjectEditPage from "./pages/ProjectEditPage";
import ProjectViewPage from "./pages/ProjectViewPage";
import PaymentEditPage from "./pages/PaymentEditPage";
import PaymentViewPage from "./pages/PaymentViewPage";
import FormsPage from "./pages/FormsPage";
import FormCreatePage from "./pages/FormCreatePage";
import FormEditPage from "./pages/FormEditPage";
import FormViewPage from "./pages/FormViewPage";
import BlogPage from "./pages/BlogPage";
import BlogCreatePage from "./pages/BlogCreatePage";
import BlogEditPage from "./pages/BlogEditPage";
import BlogViewPage from "./pages/BlogViewPage";
import PortalBlogPage from "./pages/PortalBlogPage";
import PortalBlogViewPage from "./pages/PortalBlogViewPage";
import FaqPage from "./pages/FaqPage";
import FaqCreatePage from "./pages/FaqCreatePage";
import FaqEditPage from "./pages/FaqEditPage";
import FaqViewPage from "./pages/FaqViewPage";
import PortalFaqPage from "./pages/PortalFaqPage";
import ReservationsPage from "./pages/ReservationsPage";
import ReservationCreatePage from "./pages/ReservationCreatePage";
import ReservationEditPage from "./pages/ReservationEditPage";
import ReservationViewPage from "./pages/ReservationViewPage";
import ReservationBookingsPage from "./pages/ReservationBookingsPage";
import ReservationBookingsImportPage from "./pages/ReservationBookingsImportPage";
import ReservationCalendarPage from "./pages/ReservationCalendarPage";
import ReservationDisabledRangesPage from "./pages/ReservationDisabledRangesPage";
import ReservationAvailabilitySchedulePage from "./pages/ReservationAvailabilitySchedulePage";
import FormSubmissionsPage from "./pages/FormSubmissionsPage";
import SubmissionsPage from "./pages/SubmissionsPage";
import AnalyticsPage from "./pages/AnalyticsPage";
import AnalyticsEditPage from "./pages/AnalyticsEditPage";
import AnalyticsViewPage from "./pages/AnalyticsViewPage";
import SetPasswordPage from "./pages/SetPasswordPage";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import ResetPasswordPage from "./pages/ResetPasswordPage";
import EnduserPortalLayout from "./pages/EnduserPortalLayout";
import PortalSubmissionsPage from "./pages/PortalSubmissionsPage";
import PortalReservationsPage from "./pages/PortalReservationsPage";
import PortalCalendarPage from "./pages/PortalCalendarPage";
import PortalAnalyticsPage from "./pages/PortalAnalyticsPage";
import PortalIndexRedirect from "./pages/PortalIndexRedirect";
import { AuthProvider } from "./context/AuthContext";
import { ProjectProvider } from "./context/ProjectContext";
import ProtectedRoute from "./components/ProtectedRoute";
import Layout from "./components/Layout";
import ErrorBoundary from "./components/ErrorBoundary";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      gcTime: 0,
      refetchOnMount: "always",
      refetchOnWindowFocus: false,
    },
  },
});

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Sonner />
      <BrowserRouter>
        <ErrorBoundary>
          <AuthProvider>
            <ProjectProvider>
            <Routes>
              <Route path="/" element={<Index />} />
              <Route path="/login" element={<LoginPage />} />
              <Route path="/forgot-password" element={<ForgotPasswordPage />} />
              <Route path="/set-password" element={<SetPasswordPage />} />
              <Route path="/reset-password" element={<ResetPasswordPage />} />
              <Route path="/no-permission" element={<NoPermissionPage />} />
              <Route path="/crash" element={<CrashPage />} />

              <Route element={<ProtectedRoute />}>
                <Route element={<Layout />}>
                  {/* Admin-only section. */}
                  <Route
                    element={<ProtectedRoute roles={["admin"]} />}
                  >
                    <Route path="/dashboard" element={<DashboardPage />} />
                    <Route path="/users" element={<UsersPage />} />
                    <Route path="/users/create" element={<UserCreatePage />} />
                    <Route path="/users/view/:id" element={<UserViewPage />} />
                    <Route path="/users/edit/:id" element={<UserEditPage />} />
                    <Route path="/projects" element={<ProjectsPage />} />
                    <Route
                      path="/projects/create"
                      element={<ProjectCreatePage />}
                    />
                    <Route
                      path="/projects/view/:id"
                      element={<ProjectViewPage />}
                    />
                    <Route
                      path="/projects/edit/:id"
                      element={<ProjectEditPage />}
                    />
                    <Route
                      path="/projects/:id/payments/:paymentId/edit"
                      element={<PaymentEditPage />}
                    />
                    <Route
                      path="/projects/:id/payments/:paymentId/view"
                      element={<PaymentViewPage />}
                    />
                    <Route path="/forms" element={<FormsPage />} />
                    <Route
                      path="/forms/create"
                      element={<FormCreatePage />}
                    />
                    <Route
                      path="/forms/view/:id"
                      element={<FormViewPage />}
                    />
                    <Route
                      path="/forms/view/:id/submissions"
                      element={<FormSubmissionsPage />}
                    />
                    <Route
                      path="/forms/edit/:id"
                      element={<FormEditPage />}
                    />
                    <Route path="/blog" element={<BlogPage />} />
                    <Route
                      path="/blog/create"
                      element={<BlogCreatePage />}
                    />
                    <Route
                      path="/blog/view/:id"
                      element={<BlogViewPage />}
                    />
                    <Route
                      path="/blog/edit/:id"
                      element={<BlogEditPage />}
                    />
                    <Route path="/faq" element={<FaqPage />} />
                    <Route path="/faq/create" element={<FaqCreatePage />} />
                    <Route path="/faq/view/:id" element={<FaqViewPage />} />
                    <Route path="/faq/edit/:id" element={<FaqEditPage />} />
                    <Route path="/reservations" element={<ReservationsPage />} />
                    <Route
                      path="/reservations/create"
                      element={<ReservationCreatePage />}
                    />
                    <Route
                      path="/reservations/view/:id"
                      element={<ReservationViewPage />}
                    />
                    <Route
                      path="/reservations/view/:id/bookings"
                      element={<ReservationBookingsPage />}
                    />
                    <Route
                      path="/reservations/view/:id/bookings/import"
                      element={<ReservationBookingsImportPage />}
                    />
                    <Route
                      path="/reservations/view/:id/calendar"
                      element={<ReservationCalendarPage />}
                    />
                    <Route
                      path="/reservations/view/:id/schedules"
                      element={<ReservationAvailabilitySchedulePage />}
                    />
                    <Route
                      path="/reservations/view/:id/blocked"
                      element={<ReservationDisabledRangesPage />}
                    />
                    <Route
                      path="/reservations/edit/:id"
                      element={<ReservationEditPage />}
                    />
                    <Route path="/analytics" element={<AnalyticsPage />} />
                    <Route
                      path="/analytics/view/:id"
                      element={<AnalyticsViewPage />}
                    />
                    <Route
                      path="/analytics/edit/:id"
                      element={<AnalyticsEditPage />}
                    />
                  </Route>

                  {/* Shared routes — accessible by both admins and endusers. */}
                  <Route
                    path="/submissions"
                    element={<SubmissionsPage />}
                  />

                  {/* Enduser portal — project selector + child pages. */}
                  <Route
                    element={<ProtectedRoute roles={["enduser"]} />}
                  >
                    <Route path="/portal" element={<EnduserPortalLayout />}>
                      <Route index element={<PortalIndexRedirect />} />
                      <Route path="analytics" element={<PortalAnalyticsPage />} />
                      <Route path="submissions" element={<PortalSubmissionsPage />} />
                      <Route path="reservations" element={<PortalReservationsPage />} />
                      <Route path="calendar" element={<PortalCalendarPage />} />
                      <Route path="blog" element={<PortalBlogPage />} />
                      <Route path="blog/create" element={<BlogCreatePage />} />
                      <Route path="blog/edit/:id" element={<BlogEditPage />} />
                      <Route path="blog/view/:id" element={<PortalBlogViewPage />} />
                      <Route path="faq" element={<PortalFaqPage />} />
                      <Route path="faq/create" element={<FaqCreatePage />} />
                      <Route path="faq/edit/:id" element={<FaqEditPage />} />
                      <Route path="faq/view/:id" element={<FaqViewPage />} />
                    </Route>
                  </Route>

                  <Route path="*" element={<NotFound />} />
                </Route>
              </Route>
            </Routes>
            </ProjectProvider>
          </AuthProvider>
        </ErrorBoundary>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;

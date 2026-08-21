import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, Outlet } from "react-router-dom";
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
import FormSubmissionsPage from "./pages/FormSubmissionsPage";
import BlogPage from "./pages/BlogPage";
import BlogCreatePage from "./pages/BlogCreatePage";
import BlogEditPage from "./pages/BlogEditPage";
import BlogViewPage from "./pages/BlogViewPage";
import FaqPage from "./pages/FaqPage";
import FaqCreatePage from "./pages/FaqCreatePage";
import FaqEditPage from "./pages/FaqEditPage";
import FaqViewPage from "./pages/FaqViewPage";
import ServicePage from "./pages/ServicePage";
import ServiceCreatePage from "./pages/ServiceCreatePage";
import ServiceEditPage from "./pages/ServiceEditPage";
import ServiceViewPage from "./pages/ServiceViewPage";
import ReservationsPage from "./pages/ReservationsPage";
import ReservationCreatePage from "./pages/ReservationCreatePage";
import ReservationEditPage from "./pages/ReservationEditPage";
import ReservationViewPage from "./pages/ReservationViewPage";
import ReservationBookingsPage from "./pages/ReservationBookingsPage";
import ReservationBookingsImportPage from "./pages/ReservationBookingsImportPage";
import ReservationCalendarPage from "./pages/ReservationCalendarPage";
import ReservationDisabledRangesPage from "./pages/ReservationDisabledRangesPage";
import ReservationServicesPage from "./pages/ReservationServicesPage";
import ReservationServiceCreatePage from "./pages/ReservationServiceCreatePage";
import ReservationServiceEditPage from "./pages/ReservationServiceEditPage";
import ReservationServiceSchedulesPage from "./pages/ReservationServiceSchedulesPage";
import ReservationCustomersPage from "./pages/ReservationCustomersPage";
import ReservationCustomerViewPage from "./pages/ReservationCustomerViewPage";
import ReservationEmbedPage from "./pages/ReservationEmbedPage";
import SubmissionsPage from "./pages/SubmissionsPage";
import AnalyticsPage from "./pages/AnalyticsPage";
import AnalyticsEditPage from "./pages/AnalyticsEditPage";
import AnalyticsViewPage from "./pages/AnalyticsViewPage";
import AnalyticsStatsPage from "./pages/AnalyticsStatsPage";
import AnalyticsSnippetPage from "./pages/AnalyticsSnippetPage";
import AiAssistantPage from "./pages/AiAssistantPage";
import AiAssistantEditPage from "./pages/AiAssistantEditPage";
import AiAssistantViewPage from "./pages/AiAssistantViewPage";
import AiAssistantKnowledgePage from "./pages/AiAssistantKnowledgePage";
import AiAssistantSnippetPage from "./pages/AiAssistantSnippetPage";
import AiAssistantSessionsPage from "./pages/AiAssistantSessionsPage";
import SetPasswordPage from "./pages/SetPasswordPage";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import ResetPasswordPage from "./pages/ResetPasswordPage";
import WorkspaceIndex from "./pages/WorkspaceIndex";
import WorkspaceModuleIndex from "./pages/WorkspaceModuleIndex";
import { AuthProvider } from "./context/AuthContext";
import { ProjectProvider } from "./context/ProjectContext";
import ProtectedRoute from "./components/ProtectedRoute";
import Layout from "./components/Layout";
import ErrorBoundary from "./components/ErrorBoundary";
function ProjectProviderLayout() {
  return (
    <ProjectProvider>
      <Outlet />
    </ProjectProvider>
  );
}

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
            <Routes>
              <Route path="/" element={<Index />} />
              <Route path="/login" element={<LoginPage />} />
              <Route path="/forgot-password" element={<ForgotPasswordPage />} />
              <Route path="/set-password" element={<SetPasswordPage />} />
              <Route path="/reset-password" element={<ResetPasswordPage />} />
              <Route path="/no-permission" element={<NoPermissionPage />} />
              <Route path="/crash" element={<CrashPage />} />

              <Route element={<ProtectedRoute />}>
                <Route element={<ProjectProviderLayout />}>
                <Route element={<Layout />}>
                  {/* ===== Admin-only utility routes ===== */}
                  <Route element={<ProtectedRoute roles={["admin"]} />}>
                    <Route path="/dashboard" element={<DashboardPage />} />
                    <Route path="/users" element={<UsersPage />} />
                    <Route path="/users/create" element={<UserCreatePage />} />
                    <Route path="/users/view/:id" element={<UserViewPage />} />
                    <Route path="/users/edit/:id" element={<UserEditPage />} />
                    <Route path="/projects" element={<ProjectsPage />} />
                    <Route path="/projects/create" element={<ProjectCreatePage />} />
                    <Route path="/projects/view/:id" element={<ProjectViewPage />} />
                    <Route path="/projects/edit/:id" element={<ProjectEditPage />} />
                    <Route path="/projects/:id/payments/:paymentId/edit" element={<PaymentEditPage />} />
                    <Route path="/projects/:id/payments/:paymentId/view" element={<PaymentViewPage />} />
                    <Route path="/forms" element={<FormsPage />} />
                    <Route path="/forms/create" element={<FormCreatePage />} />
                    <Route path="/forms/edit/:id" element={<FormEditPage />} />
                    <Route path="/reservations" element={<ReservationsPage />} />
                    <Route path="/reservations/create" element={<ReservationCreatePage />} />
                    <Route path="/reservations/edit/:id" element={<ReservationEditPage />} />
                    <Route path="/reservations/customers" element={<ReservationCustomersPage />} />
                    <Route path="/reservations/customers/:customerId" element={<ReservationCustomerViewPage />} />
                    <Route path="/blog" element={<BlogPage />} />
                    <Route path="/blog/create" element={<BlogCreatePage />} />
                    <Route path="/blog/edit/:id" element={<BlogEditPage />} />
                    <Route path="/faq" element={<FaqPage />} />
                    <Route path="/faq/create" element={<FaqCreatePage />} />
                    <Route path="/faq/edit/:id" element={<FaqEditPage />} />
                    <Route path="/services" element={<ServicePage />} />
                    <Route path="/services/create" element={<ServiceCreatePage />} />
                    <Route path="/services/edit/:id" element={<ServiceEditPage />} />
                    <Route path="/analytics" element={<AnalyticsPage />} />
                    <Route path="/analytics/edit/:id" element={<AnalyticsEditPage />} />
                    <Route path="/ai-assistant" element={<AiAssistantPage />} />
                    <Route path="/ai-assistant/edit/:id" element={<AiAssistantEditPage />} />
                  </Route>

                  {/* ===== Canonical workspace routes ===== */}
                  <Route path="/workspace" element={<WorkspaceIndex />} />
                  <Route path="/workspace/projects/:projectId" element={<WorkspaceIndex />} />

                  {/* Reservation module */}
                  <Route element={<ProtectedRoute roles={["admin"]} />}>
                    <Route path="/workspace/projects/:projectId/modules/reservation/:moduleId/details" element={<ReservationViewPage />} />
                  </Route>
                  <Route path="/workspace/projects/:projectId/modules/reservation/:moduleId/edit" element={<ReservationEditPage />} />
                  <Route path="/workspace/projects/:projectId/modules/reservation/:moduleId/services/create" element={<ReservationServiceCreatePage />} />
                  <Route path="/workspace/projects/:projectId/modules/reservation/:moduleId/services/edit/:serviceId" element={<ReservationServiceEditPage />} />
                  <Route path="/workspace/projects/:projectId/modules/reservation/:moduleId/services/:serviceId/schedules" element={<ReservationServiceSchedulesPage />} />
                  <Route path="/workspace/projects/:projectId/modules/reservation/:moduleId/services" element={<ReservationServicesPage />} />
                  <Route path="/workspace/projects/:projectId/modules/reservation/:moduleId/bookings" element={<ReservationBookingsPage />} />
                  <Route path="/workspace/projects/:projectId/modules/reservation/:moduleId/bookings/import" element={<ReservationBookingsImportPage />} />
                  <Route path="/workspace/projects/:projectId/modules/reservation/:moduleId/calendar" element={<ReservationCalendarPage />} />
                  <Route path="/workspace/projects/:projectId/modules/reservation/:moduleId/blocked" element={<ReservationDisabledRangesPage />} />
                  <Route path="/workspace/projects/:projectId/modules/reservation/:moduleId/customers" element={<ReservationCustomersPage />} />
                  <Route path="/workspace/projects/:projectId/modules/reservation/:moduleId/customers/:customerId" element={<ReservationCustomerViewPage />} />

                  {/* Form module — one per project */}
                  <Route path="/workspace/projects/:projectId/modules/form/:moduleId/details" element={<FormViewPage />} />
                  <Route path="/workspace/projects/:projectId/modules/form/:moduleId/submissions" element={<FormSubmissionsPage />} />

                  {/* Analytics module */}
                  <Route path="/workspace/projects/:projectId/modules/analytics/:moduleId/details" element={<AnalyticsViewPage />} />
                  <Route path="/workspace/projects/:projectId/modules/analytics/:moduleId/stats" element={<AnalyticsStatsPage />} />
                  <Route path="/workspace/projects/:projectId/modules/analytics/:moduleId/snippet" element={<AnalyticsSnippetPage />} />

                  {/* AI Assistant module */}
                  <Route path="/workspace/projects/:projectId/modules/ai-assistant/:moduleId/details" element={<AiAssistantViewPage />} />
                  <Route path="/workspace/projects/:projectId/modules/ai-assistant/:moduleId/knowledge" element={<AiAssistantKnowledgePage />} />
                  <Route path="/workspace/projects/:projectId/modules/ai-assistant/:moduleId/snippet" element={<AiAssistantSnippetPage />} />
                  <Route path="/workspace/projects/:projectId/modules/ai-assistant/:moduleId/sessions" element={<AiAssistantSessionsPage />} />

                  {/* Blog module */}
                  <Route path="/workspace/projects/:projectId/modules/blog/:moduleId/posts" element={<BlogPage />} />
                  <Route path="/workspace/projects/:projectId/modules/blog/:moduleId/posts/create" element={<BlogCreatePage />} />
                  <Route path="/workspace/projects/:projectId/modules/blog/:moduleId/posts/edit/:id" element={<BlogEditPage />} />
                  <Route path="/workspace/projects/:projectId/modules/blog/:moduleId/posts/view/:id" element={<BlogViewPage />} />

                  {/* FAQ module */}
                  <Route path="/workspace/projects/:projectId/modules/faq/:moduleId/items" element={<FaqPage />} />
                  <Route path="/workspace/projects/:projectId/modules/faq/:moduleId/items/create" element={<FaqCreatePage />} />
                  <Route path="/workspace/projects/:projectId/modules/faq/:moduleId/items/edit/:id" element={<FaqEditPage />} />
                  <Route path="/workspace/projects/:projectId/modules/faq/:moduleId/items/view/:id" element={<FaqViewPage />} />

                  {/* Service module */}
                  <Route path="/workspace/projects/:projectId/modules/service/:moduleId/items" element={<ServicePage />} />
                  <Route path="/workspace/projects/:projectId/modules/service/:moduleId/items/create" element={<ServiceCreatePage />} />
                  <Route path="/workspace/projects/:projectId/modules/service/:moduleId/items/edit/:id" element={<ServiceEditPage />} />
                  <Route path="/workspace/projects/:projectId/modules/service/:moduleId/items/view/:id" element={<ServiceViewPage />} />

                  <Route path="/submissions" element={<SubmissionsPage />} />

                  <Route path="*" element={<NotFound />} />
                </Route>
                </Route>
              </Route>

              {/* Public embed route — outside ProtectedRoute */}
              <Route path="/embed/reservations/:secretToken" element={<ReservationEmbedPage />} />
            </Routes>
          </AuthProvider>
        </ErrorBoundary>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;

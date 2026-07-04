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
import { AuthProvider } from "./context/AuthContext";
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
            <Routes>
              <Route path="/" element={<Index />} />
              <Route path="/login" element={<LoginPage />} />
              <Route path="/no-permission" element={<NoPermissionPage />} />
              <Route path="/crash" element={<CrashPage />} />

              <Route element={<ProtectedRoute />}>
                <Route element={<Layout />}>
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
                    path="/forms/edit/:id"
                    element={<FormEditPage />}
                  />
                  <Route path="*" element={<NotFound />} />
                </Route>
              </Route>
            </Routes>
          </AuthProvider>
        </ErrorBoundary>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;

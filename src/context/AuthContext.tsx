import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  ReactNode,
} from "react";
import {
  SigninRequest,
  UserDetailsDTO,
} from "@/types/auth";
import { signIn, validateSession, logout as logoutApi } from "@/lib/api";
import { showSuccess, showError } from "@/utils/toast";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CsrfTokenService } from "@/services/csrf";

interface AuthState {
  isAuthenticated: boolean;
  user: UserDetailsDTO | null;
  isLoading: boolean;
  passwordChangeRequired: boolean;
}

interface AuthContextType extends AuthState {
  login: (credentials: SigninRequest) => Promise<void>;
  logout: () => Promise<void>;
  updatePasswordChangeRequired: (value: boolean) => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const initialAuthState: AuthState = {
  isAuthenticated: false,
  user: null,
  isLoading: true,
  passwordChangeRequired: false,
};

export const AuthProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [state, setState] = useState<AuthState>(initialAuthState);
  const navigate = useNavigate();
  const { t } = useTranslation(["auth", "common"]);

  // Check if user is authenticated on mount
  useEffect(() => {
    const checkSession = async () => {
      try {
        const response = await validateSession();

        if (response.user) {
          // Initialize CSRF after successful session validation
          // This ensures CSRF tokens are available for already authenticated users (e.g., after page refresh)
          try {
            await CsrfTokenService.initialize();
          } catch (csrfError) {
            console.error(
              "[AuthContext] Failed to initialize CSRF after session validation:",
              csrfError,
            );
            // Continue anyway - the user is authenticated, CSRF errors will be handled by API calls
          }

          setState({
            isAuthenticated: true,
            user: response.user,
            isLoading: false,
            passwordChangeRequired: false,
          });

        } else {
          setState({
            isAuthenticated: false,
            user: null,
            isLoading: false,
            passwordChangeRequired: false,
          });

        }
      } catch (error) {
        console.error("Session validation failed:", error);
        setState({
          isAuthenticated: false,
          user: null,
          isLoading: false,
          passwordChangeRequired: false,
        });

        // Show error message for session validation failure
        if (error instanceof Error) {
          showError(t("auth:session_expired"));
        } else {
          showError(t("auth:session_validation_failed"));
        }
      }
    };

    checkSession();
  }, [t]);

  const login = async (credentials: SigninRequest) => {
    try {
      const response = await signIn(credentials);

      if (response.errorMessage) {
        showError(response.errorMessage);
        return;
      }

      // Check if user is null even with HTTP 200 response
      if (response.user === null) {
        showError(t("auth:login_failed"));
        return;
      }

      // Tokens are now in HttpOnly cookies, we only store user data
      const passwordRequired = response.passwordChangeRequired || false;

      setState({
        isAuthenticated: true,
        user: response.user,
        isLoading: false,
        passwordChangeRequired: passwordRequired,
      });

      // Initialize CSRF after successful login
      // This ensures CSRF tokens are available for authenticated API calls
      // We do this after setting the auth state to avoid race conditions
      try {
        await CsrfTokenService.initialize();
      } catch (csrfError) {
        console.error(
          "[AuthContext] Failed to initialize CSRF after login:",
          csrfError,
        );
        // Continue anyway - the user is logged in, CSRF errors will be handled by API calls
      }

      showSuccess(
        t("auth:welcome_message", { name: response.user?.firstName || "User" }),
      );

      // Redirect to change password if required, otherwise to dashboard
      if (passwordRequired) {
        navigate("/change-password");
      } else {
        navigate("/dashboard");
      }
    } catch (error) {
      console.error("Login failed:", error);
      setState({
        isAuthenticated: false,
        user: null,
        isLoading: false,
        passwordChangeRequired: false,
      });

      // Show more specific error message if available
      showError(t("auth:login_failed"));
    }
  };

  const logout = async () => {
    try {
      // Call backend to invalidate HttpOnly cookies
      await logoutApi();
    } catch (error) {
      console.error("Logout API call failed:", error);
      // Continue with local logout even if API call fails
    }

    // Clean up CSRF service to clear tokens and stop auto-refresh
    // This prevents CSRF tokens from being used after logout
    try {
      CsrfTokenService.destroy();
    } catch (csrfError) {
      console.error(
        "[AuthContext] Failed to destroy CSRF service on logout:",
        csrfError,
      );
      // Continue with logout anyway
    }

    // Clear local state
    setState({ ...initialAuthState, isLoading: false });
    showSuccess(t("auth:logged_out_successfully"));
    navigate("/login");
  };

  const updatePasswordChangeRequired = (value: boolean) => {
    setState((prev) => ({
      ...prev,
      passwordChangeRequired: value,
    }));
  };

  const refreshUser = async () => {
    try {
      const response = await validateSession();
      if (response.user) {
        setState((prev) => ({
          ...prev,
          user: response.user,
        }));
      }
    } catch (error) {
      console.error("Failed to refresh user session:", error);
    }
  };

  const contextValue: AuthContextType = {
    ...state,
    login,
    logout,
    updatePasswordChangeRequired,
    refreshUser,
  };

  return (
    <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};

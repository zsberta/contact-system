import { createRoot } from "react-dom/client";
import { HelmetProvider } from "react-helmet-async";
import App from "./App.tsx";
import "./globals.css";
import "./i18n"; // Import i18n configuration

// CSRF initialization is now deferred until after successful authentication.
// This avoids unnecessary API calls before the user is logged in.
// The service will be initialized in AuthContext.tsx after:
// 1. Successful login, or
// 2. Successful session validation (for already authenticated users on page refresh)

createRoot(document.getElementById("root")!).render(
  <HelmetProvider>
    <App />
  </HelmetProvider>,
);

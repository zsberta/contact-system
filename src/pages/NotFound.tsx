import { useLocation } from "react-router-dom";
import { useEffect } from "react";
import ErrorPage from "@/components/ErrorPage";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error(
      "404 Error: User attempted to access non-existent route:",
      location.pathname,
    );
  }, [location.pathname]);

  return <ErrorPage errorCode={404} />;
};

export default NotFound;

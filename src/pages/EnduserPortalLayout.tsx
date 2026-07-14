// EnduserPortalLayout — thin wrapper for /portal/* routes.
// The project selector lives in the Layout header; this just renders the
// child route.

import { Outlet } from "react-router-dom";

export default function EnduserPortalLayout() {
  return <Outlet />;
}

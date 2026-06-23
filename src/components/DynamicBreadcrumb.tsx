import React from "react";

interface DynamicBreadcrumbProps {
  resourceType: string;
  id: string;
}

const DynamicBreadcrumb: React.FC<DynamicBreadcrumbProps> = ({ id }) => {
  return <span>{id}</span>;
};

export default DynamicBreadcrumb;

export const usePermission = () => ({
  hasPermission: (_p: { name: string; action: string }) => true,
  hasAnyPermission: (_ps: { name: string; action: string }[]) => true,
  hasAllPermissions: (_ps: { name: string; action: string }[]) => true,
  allPermissions: [] as string[],
  permissionNames: [] as string[],
});
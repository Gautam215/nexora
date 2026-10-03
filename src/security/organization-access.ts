export type OrganizationRole = "owner" | "admin" | "member" | "guest";

export interface MembershipForAuthorization {
  userId: string;
  organizationId: string;
  role: string;
  status: string;
}

const roleRank: Readonly<Record<OrganizationRole, number>> = Object.freeze({
  guest: 0,
  member: 1,
  admin: 2,
  owner: 3,
});

export function canAccessOrganization(
  membership: MembershipForAuthorization | null | undefined,
  userId: string,
  organizationId: string,
  minimumRole: OrganizationRole = "guest",
): membership is MembershipForAuthorization {
  if (
    !membership ||
    membership.userId !== userId ||
    membership.organizationId !== organizationId ||
    membership.status !== "active"
  ) {
    return false;
  }

  const actualRank = roleRank[membership.role as OrganizationRole];
  const requiredRank = roleRank[minimumRole];
  return typeof actualRank === "number" && actualRank >= requiredRank;
}

import NotificationCenter from "../../../components/notification-center";

export default async function NotificationsRoute({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  return <NotificationCenter organizationId={organizationId} />;
}

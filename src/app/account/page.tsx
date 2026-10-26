import AccountSettingsPage from "../components/account-settings-page.tsx";
import { oauthErrorMessage } from "../../security/oauth-errors.ts";

export const metadata = {
  title: "Account security | Nexora",
  robots: { index: false, follow: false },
};

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const params = await searchParams;
  const errorParam = Array.isArray(params.error) ? params.error[0] : params.error;
  return (
    <AccountSettingsPage
      oauthEnabled={process.env.OAUTH_GOOGLE_ENABLED === "true"}
      oauthMessage={oauthErrorMessage(errorParam)}
    />
  );
}

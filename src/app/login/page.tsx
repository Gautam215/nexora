import AuthPage from "../components/auth-page";
import { oauthErrorMessage } from "../../security/oauth-errors.ts";
import { safeReturnPath } from "../../security/return-path.ts";

export const metadata = {
  title: "Sign in | Nexora",
  robots: { index: false, follow: false },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; error?: string | string[] }>;
}) {
  const params = await searchParams;
  const errorParam = Array.isArray(params.error) ? params.error[0] : params.error;
  return (
    <AuthPage
      mode="login"
      nextPath={safeReturnPath(params.next)}
      oauthEnabled={process.env.OAUTH_GOOGLE_ENABLED === "true"}
      oauthMessage={oauthErrorMessage(errorParam)}
    />
  );
}

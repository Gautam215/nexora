import AuthPage from "../components/auth-page";
import { safeReturnPath } from "../../security/return-path.ts";

export const metadata = {
  title: "Sign in | Nexora",
  robots: { index: false, follow: false },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const params = await searchParams;
  return <AuthPage mode="login" nextPath={safeReturnPath(params.next)} />;
}

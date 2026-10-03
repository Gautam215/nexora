import AuthPage from "../components/auth-page";
import { safeReturnPath } from "../../security/return-path.ts";

export const metadata = {
  title: "Create account | Nexora",
  robots: { index: false, follow: false },
};

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const params = await searchParams;
  return <AuthPage mode="register" nextPath={safeReturnPath(params.next)} />;
}

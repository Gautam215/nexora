import AuthPage from "../components/auth-page";

export const metadata = {
  title: "Confirm email | Nexora",
  robots: { index: false, follow: false },
};

export default function VerifyEmailPage() {
  return <AuthPage mode="verify-email" />;
}

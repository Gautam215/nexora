import AuthPage from "../components/auth-page";

export const metadata = {
  title: "Choose a new password | Nexora",
  robots: { index: false, follow: false },
};

export default function ResetPasswordPage() {
  return <AuthPage mode="reset-password" />;
}

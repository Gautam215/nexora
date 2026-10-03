import AuthPage from "../components/auth-page";

export const metadata = {
  title: "Reset password | Nexora",
  robots: { index: false, follow: false },
};

export default function ForgotPasswordPage() {
  return <AuthPage mode="forgot-password" />;
}

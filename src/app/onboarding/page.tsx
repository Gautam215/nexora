import WorkspacePage from "../components/workspace-pages";

export const metadata = {
  title: "Create a workspace | Nexora",
  robots: { index: false, follow: false },
};

export default function OnboardingPage() {
  return <WorkspacePage mode="create" />;
}

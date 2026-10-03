import WorkspacePage from "../components/workspace-pages";

export const metadata = {
  title: "Your workspaces | Nexora",
  robots: { index: false, follow: false },
};

export default function WorkspacesPage() {
  return <WorkspacePage mode="list" />;
}

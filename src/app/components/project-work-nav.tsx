type ProjectArea = "overview" | "milestones" | "board" | "list" | "activity";

export default function ProjectWorkNav({
  organizationId,
  projectId,
  current,
}: {
  organizationId: string;
  projectId: string;
  current: ProjectArea;
}) {
  const base = `/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}`;
  const links: Array<{ id: ProjectArea; label: string; href: string }> = [
    { id: "overview", label: "Overview", href: base },
    { id: "milestones", label: "Milestones", href: `${base}/milestones` },
    { id: "board", label: "Board", href: `${base}/tasks?view=board` },
    { id: "list", label: "List", href: `${base}/tasks?view=list` },
    { id: "activity", label: "Activity", href: `${base}/activity` },
  ];

  return (
    <nav className="project-work-nav" aria-label="Project areas">
      {links.map((link) => (
        <a
          aria-current={current === link.id ? "page" : undefined}
          className={current === link.id ? "project-work-link is-current" : "project-work-link"}
          href={link.href}
          key={link.id}
        >
          {link.label}
        </a>
      ))}
      <a className="project-work-link project-notifications-link" href={`/organizations/${encodeURIComponent(organizationId)}/notifications`}>
        Notifications
      </a>
    </nav>
  );
}

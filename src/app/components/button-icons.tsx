import type { ReactElement } from "react";

// Small stroke icons for buttons, one per action. They are decorative: every
// button keeps its visible text label, so the icons are aria-hidden and the
// sizing comes from the shared `.button-icon` class in globals.css. No icon
// library is added for these (repo rule: no new dependency for a few lines).

function Icon({ children }: { children: ReactElement }) {
  return (
    <svg
      className="button-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function SignInIcon() {
  return (
    <Icon>
      <>
        <path d="M15 3h4v4" />
        <path d="M20 3l-7 7" />
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      </>
    </Icon>
  );
}

export function SignOutIcon() {
  return (
    <Icon>
      <>
        <path d="M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4" />
        <path d="M16 17l5-5-5-5" />
        <path d="M21 12H9" />
      </>
    </Icon>
  );
}

export function UserPlusIcon() {
  return (
    <Icon>
      <>
        <circle cx="9" cy="8" r="3.5" />
        <path d="M2.5 19c.8-3 3.2-4.5 6.5-4.5s5.7 1.5 6.5 4.5" />
        <path d="M19 4v6M16 7h6" />
      </>
    </Icon>
  );
}

export function UsersIcon() {
  return (
    <Icon>
      <>
        <circle cx="9" cy="8" r="3.5" />
        <path d="M2.5 19c.8-3 3.2-4.5 6.5-4.5s5.7 1.5 6.5 4.5" />
        <circle cx="17" cy="9" r="2.5" />
        <path d="M15.5 14.5c2.8.3 4.7 1.7 5.5 4.5" />
      </>
    </Icon>
  );
}

export function CheckIcon() {
  return (
    <Icon>
      <path d="M4 12.5l5 5L20 6.5" />
    </Icon>
  );
}

export function KeyIcon() {
  return (
    <Icon>
      <>
        <circle cx="7.5" cy="15.5" r="4.5" />
        <path d="M11 12L20 3" />
        <path d="M15 8l3 3" />
      </>
    </Icon>
  );
}

export function ShieldIcon() {
  return (
    <Icon>
      <>
        <path d="M12 3l7 3v5c0 5-3.5 8-7 9-3.5-1-7-4-7-9V6z" />
        <path d="M9 12l2 2 4-4" />
      </>
    </Icon>
  );
}

export function SearchIcon() {
  return (
    <Icon>
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="M21 21l-4.3-4.3" />
      </>
    </Icon>
  );
}

export function SendIcon() {
  return (
    <Icon>
      <>
        <path d="M22 2L11 13" />
        <path d="M22 2l-7 20-4-9-9-4z" />
      </>
    </Icon>
  );
}

export function MailIcon() {
  return (
    <Icon>
      <>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M3 7l9 6 9-6" />
      </>
    </Icon>
  );
}

export function DownloadIcon() {
  return (
    <Icon>
      <>
        <path d="M12 3v12" />
        <path d="M6 11l6 6 6-6" />
        <path d="M4 21h16" />
      </>
    </Icon>
  );
}

export function TrashIcon() {
  return (
    <Icon>
      <>
        <path d="M3 6h18" />
        <path d="M8 6V4h8v2" />
        <path d="M5 6l1 14h12l1-14" />
        <path d="M10 10v6M14 10v6" />
      </>
    </Icon>
  );
}

export function XIcon() {
  return (
    <Icon>
      <path d="M6 6l12 12M18 6L6 18" />
    </Icon>
  );
}

export function RefreshIcon() {
  return (
    <Icon>
      <>
        <path d="M20 12a8 8 0 1 1-2.3-5.6" />
        <path d="M20 3v4h-4" />
      </>
    </Icon>
  );
}

export function ChevronUpIcon() {
  return (
    <Icon>
      <path d="M6 15l6-6 6 6" />
    </Icon>
  );
}

export function ChevronDownIcon() {
  return (
    <Icon>
      <path d="M6 9l6 6 6-6" />
    </Icon>
  );
}

export function ChevronLeftIcon() {
  return (
    <Icon>
      <path d="M15 6l-6 6 6 6" />
    </Icon>
  );
}

export function ChevronRightIcon() {
  return (
    <Icon>
      <path d="M9 6l6 6-6 6" />
    </Icon>
  );
}

export function ArrowRightIcon() {
  return (
    <Icon>
      <>
        <path d="M4 12h15" />
        <path d="M13 6l6 6-6 6" />
      </>
    </Icon>
  );
}

export function PlusIcon() {
  return (
    <Icon>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function FilterIcon() {
  return (
    <Icon>
      <>
        <path d="M4 6h16" />
        <path d="M7 12h10" />
        <path d="M10 18h4" />
      </>
    </Icon>
  );
}

export function ArchiveIcon() {
  return (
    <Icon>
      <>
        <rect x="3" y="4" width="18" height="5" rx="1" />
        <path d="M5 9v11h14V9" />
        <path d="M10 13h4" />
      </>
    </Icon>
  );
}

export function SlidersIcon() {
  return (
    <Icon>
      <>
        <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
        <circle cx="16" cy="7" r="2" />
        <circle cx="10" cy="17" r="2" />
      </>
    </Icon>
  );
}

export function SparklesIcon() {
  return (
    <Icon>
      <>
        <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
        <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
      </>
    </Icon>
  );
}

export function AtSignIcon() {
  return (
    <Icon>
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M18 8.5A6.5 6.5 0 1 1 12 5.5" />
      </>
    </Icon>
  );
}

"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SearchEntityType } from "../../security/search-schemas.ts";
import { BrandLogo } from "./brand-logo";
import {
  addRecentSearch,
  highlightSegments,
  loadRecentSearches,
} from "./organization-search-helpers";

interface SearchResult {
  entity_type: SearchEntityType;
  id: string;
  title: string;
  context: string;
  preview: string;
  created_at: string;
  href: string;
}

interface SearchResponse {
  data?: {
    results: SearchResult[];
    pagination: { total: number; limit: number; offset: number; hasMore: boolean };
  };
  error?: { message?: string };
}

interface ProjectOption {
  id: string;
  name: string;
}

interface PersonOption {
  id: string;
  name: string;
}

interface ProjectsResponse {
  data?: { projects?: Array<{ id?: unknown; name?: unknown }> };
}

interface MembersResponse {
  data?: { members?: Array<{ user_id?: unknown; display_name?: unknown; status?: unknown }> };
}

const PAGE_SIZE = 20;

const TYPE_CHIPS: Array<{ value: "all" | SearchEntityType; label: string }> = [
  { value: "all", label: "All" },
  { value: "project", label: "Projects" },
  { value: "task", label: "Tasks" },
  { value: "comment", label: "Comments" },
  { value: "member", label: "People" },
  { value: "file", label: "Files" },
];

const STATUS_OPTIONS = [
  { value: "all", label: "Any status" },
  { value: "planned", label: "Planned" },
  { value: "active", label: "Active" },
  { value: "on_hold", label: "On hold" },
  { value: "completed", label: "Completed" },
  { value: "archived", label: "Archived" },
] as const;

const TYPE_INITIALS: Record<SearchEntityType, string> = {
  project: "P",
  task: "T",
  comment: "C",
  member: "M",
  file: "F",
};

// Example words only: clicking one runs a real search for that word.
const SUGGESTED_QUERIES = ["design", "review", "launch"];

export default function OrganizationSearchPage({ organizationId }: { organizationId: string }) {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [type, setType] = useState<"all" | SearchEntityType>("all");
  const [projectId, setProjectId] = useState("all");
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [personId, setPersonId] = useState("all");
  const [people, setPeople] = useState<PersonOption[]>([]);
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_OPTIONS)[number]["value"]>("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [searchNonce, setSearchNonce] = useState(0);
  const [focused, setFocused] = useState(false);
  const [recents, setRecents] = useState<string[]>(() => {
    if (typeof window === "undefined") {
      return [];
    }
    try {
      return loadRecentSearches(window.localStorage.getItem(`nexora-search-recent:${organizationId}`));
    } catch {
      return [];
    }
  });
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    async function loadProjects() {
      try {
        const response = await fetch(
          `/api/organizations/${encodeURIComponent(organizationId)}/projects?limit=100`,
          { cache: "no-store", signal: controller.signal },
        );
        if (response.status === 401) {
          window.location.assign("/login");
          return;
        }
        const payload = (await response.json().catch(() => null)) as ProjectsResponse | null;
        const options = (payload?.data?.projects ?? [])
          .filter((project) => typeof project.id === "string" && typeof project.name === "string")
          .map((project) => ({ id: project.id as string, name: project.name as string }));
        if (!controller.signal.aborted) {
          setProjects(options);
        }
      } catch {
        // The project filter is optional: search still works without it.
        if (!controller.signal.aborted) {
          setProjects([]);
        }
      }
    }
    void loadProjects();
    return () => controller.abort();
  }, [organizationId]);

  useEffect(() => {
    const controller = new AbortController();
    async function loadPeople() {
      try {
        const response = await fetch(
          `/api/organizations/${encodeURIComponent(organizationId)}/members`,
          { cache: "no-store", signal: controller.signal },
        );
        if (response.status === 401) {
          window.location.assign("/login");
          return;
        }
        const payload = (await response.json().catch(() => null)) as MembersResponse | null;
        const options = (payload?.data?.members ?? [])
          .filter((member) => member.status === "active"
            && typeof member.user_id === "string"
            && typeof member.display_name === "string")
          .map((member) => ({ id: member.user_id as string, name: member.display_name as string }));
        if (!controller.signal.aborted) {
          setPeople(options);
        }
      } catch {
        // The person filter is optional: search still works without it.
        if (!controller.signal.aborted) {
          setPeople([]);
        }
      }
    }
    void loadPeople();
    return () => controller.abort();
  }, [organizationId]);

  useEffect(() => {
    if (query.length < 2) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();

    async function runSearch() {
      setLoading(true);
      setError("");
      const params = new URLSearchParams({
        q: query,
        type,
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      });
      if (projectId !== "all") {
        params.set("projectId", projectId);
      }
      if (personId !== "all") {
        params.set("ownerId", personId);
      }
      if (statusFilter !== "all") {
        params.set("status", statusFilter);
      }
      if (fromDate !== "") {
        params.set("from", fromDate);
      }
      if (toDate !== "") {
        params.set("to", toDate);
      }
      try {
        const response = await fetch(
          `/api/organizations/${encodeURIComponent(organizationId)}/search?${params.toString()}`,
          { cache: "no-store", signal: controller.signal },
        );
        const payload = (await response.json().catch(() => null)) as SearchResponse | null;
        if (response.status === 401) {
          window.location.assign("/login");
          return;
        }
        if (!response.ok || !payload?.data) {
          throw new Error(payload?.error?.message ?? "Search could not be completed.");
        }
        setResults(payload.data.results);
        setTotal(payload.data.pagination.total);
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "Search could not be completed.");
          setResults([]);
          setTotal(0);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void runSearch();
    return () => controller.abort();
  }, [organizationId, query, type, projectId, personId, statusFilter, fromDate, toDate, page, searchNonce]);

  function runSearchFor(value: string) {
    const trimmed = value.trim();
    setInput(trimmed);
    setPage(0);
    setSearchNonce((current) => current + 1);
    if (trimmed.length < 2) {
      setQuery("");
      setResults([]);
      setTotal(0);
      setError("Enter at least 2 characters to search.");
      return;
    }
    if (fromDate !== "" && toDate !== "" && fromDate > toDate) {
      setQuery("");
      setResults([]);
      setTotal(0);
      setError("The from date must be on or before the to date.");
      return;
    }
    setQuery(trimmed);
    setError("");
    const next = addRecentSearch(recents, trimmed);
    setRecents(next);
    try {
      window.localStorage.setItem(`nexora-search-recent:${organizationId}`, JSON.stringify(next));
    } catch {
      // Private mode or blocked storage must not break search.
    }
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    runSearchFor(input);
  }

  function clearSearch() {
    setInput("");
    setQuery("");
    setResults([]);
    setTotal(0);
    setPage(0);
    setError("");
    inputRef.current?.focus();
  }

  const showSuggestions = focused && input.trim() === "";

  return (
    <main className="auth-layout workspace-layout search-layout">
      <aside className="auth-story search-story">
        <BrandLogo href="/workspaces" />
        <div className="auth-story-copy">
          <p className="eyebrow">Workspace search</p>
          <h1>Find the detail that moves work forward.</h1>
          <p>Search across the projects, tasks and collaboration records available to you in this workspace.</p>
        </div>
      </aside>

      <section className="auth-main" aria-label="Workspace search">
        <div className="workspace-card organization-dashboard project-dashboard search-dashboard">
          <nav className="search-breadcrumb" aria-label="Breadcrumb">
            <ol>
              <li><a href="/">Nexora</a></li>
              <li><a href={`/organizations/${encodeURIComponent(organizationId)}`}>Workspace</a></li>
              <li aria-current="page">Search</li>
            </ol>
            <span className="search-nav-links">
              <a href="/workspaces">Workspaces</a>
              <a href="/account">Account</a>
            </span>
          </nav>
          <h2 className="sr-only">Search this workspace</h2>
          <p className="search-trust">
            <LockIcon />
            Only results you are allowed to access are returned.
          </p>
          <p className="search-description">Projects, tasks, comments, members and files.</p>

          <form className="search-form" onSubmit={submitSearch} noValidate>
            <div className="search-input-field">
              <label htmlFor="search-terms">Search terms</label>
              <span className="search-input-wrap">
                <input
                  ref={inputRef}
                  id="search-terms"
                  type="text"
                  autoComplete="off"
                  autoFocus
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
                  maxLength={120}
                  placeholder="Try a project, task or phrase"
                />
                {input !== "" && (
                  <button
                    className="search-clear"
                    type="button"
                    aria-label="Clear search terms"
                    onClick={() => {
                      setInput("");
                      inputRef.current?.focus();
                    }}
                  >
                    ×
                  </button>
                )}
              </span>
            </div>

            {showSuggestions && (
              <div className="search-suggest">
                {recents.length > 0 && (
                  <div className="search-suggest-group">
                    <p>Recent searches</p>
                    <ul>
                      {recents.map((recent) => (
                        <li key={recent}>
                          <button
                            type="button"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => runSearchFor(recent)}
                          >
                            {recent}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="search-suggest-group">
                  <p>Try</p>
                  <ul>
                    {SUGGESTED_QUERIES.map((suggestion) => (
                      <li key={suggestion}>
                        <button
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => runSearchFor(suggestion)}
                        >
                          {suggestion}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            <fieldset className="search-type-field">
              <legend>Result type</legend>
              <div className="search-type-chips">
                {TYPE_CHIPS.map((chip) => (
                  <label className="search-chip" key={chip.value}>
                    <input
                      className="sr-only"
                      type="radio"
                      name="search-type"
                      value={chip.value}
                      checked={type === chip.value}
                      onChange={() => {
                        setType(chip.value);
                        setPage(0);
                      }}
                    />
                    <span>{chip.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="search-filters-field">
              <legend>Filters</legend>
              <div className="search-filters-grid">
                {projects.length > 0 && (
                  <div className="search-project-field">
                    <label htmlFor="search-project">Project</label>
                    <select
                      id="search-project"
                      value={projectId}
                      onChange={(event) => {
                        setProjectId(event.target.value);
                        setPage(0);
                      }}
                    >
                      <option value="all">All projects</option>
                      {projects.map((project) => (
                        <option key={project.id} value={project.id}>{project.name}</option>
                      ))}
                    </select>
                  </div>
                )}
                {people.length > 0 && (
                  <div className="search-person-field">
                    <label htmlFor="search-person">Person</label>
                    <select
                      id="search-person"
                      value={personId}
                      onChange={(event) => {
                        setPersonId(event.target.value);
                        setPage(0);
                      }}
                    >
                      <option value="all">All people</option>
                      {people.map((person) => (
                        <option key={person.id} value={person.id}>{person.name}</option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="search-status-field">
                  <label htmlFor="search-status">Project status</label>
                  <select
                    id="search-status"
                    value={statusFilter}
                    onChange={(event) => {
                      setStatusFilter(event.target.value as (typeof STATUS_OPTIONS)[number]["value"]);
                      setPage(0);
                    }}
                  >
                    {STATUS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                <div className="search-date-field">
                  <label htmlFor="search-from">From</label>
                  <input
                    id="search-from"
                    type="date"
                    value={fromDate}
                    onChange={(event) => {
                      setFromDate(event.target.value);
                      setPage(0);
                    }}
                  />
                </div>
                <div className="search-date-field">
                  <label htmlFor="search-to">To</label>
                  <input
                    id="search-to"
                    type="date"
                    value={toDate}
                    onChange={(event) => {
                      setToDate(event.target.value);
                      setPage(0);
                    }}
                  />
                </div>
              </div>
              {(projectId !== "all" || personId !== "all" || statusFilter !== "all"
                || fromDate !== "" || toDate !== "") && (
                <button
                  className="quiet-button search-filters-reset"
                  type="button"
                  onClick={() => {
                    setProjectId("all");
                    setPersonId("all");
                    setStatusFilter("all");
                    setFromDate("");
                    setToDate("");
                    setPage(0);
                  }}
                >
                  Reset filters
                </button>
              )}
            </fieldset>

            <button className="primary-button search-submit" type="submit" disabled={loading}>
              {loading ? "Searching..." : "Search"}
            </button>
            <p className="search-shortcut-hint">Shortcut: ⌘K / Ctrl+K focuses this field.</p>
          </form>

          {error && <p className="form-message form-error" role="alert">{error}</p>}
          {loading && query.length >= 2 && (
            <div className="search-skeleton" role="status" aria-label="Loading search results">
              <div className="search-skeleton-row" />
              <div className="search-skeleton-row" />
              <div className="search-skeleton-row" />
            </div>
          )}
          {!loading && query.length < 2 && !error && (
            <div className="search-empty">
              <SearchEmptyIcon />
              <p>Results will appear here.</p>
              <p>Enter a phrase above to search this workspace.</p>
            </div>
          )}
          {!loading && query.length >= 2 && !error && results.length === 0 && (
            <div className="search-empty">
              <SearchEmptyIcon />
              <p>No accessible matches for {query}.</p>
              <p>Try a shorter phrase, another result type, or another project.</p>
              <button className="quiet-button search-empty-clear" type="button" onClick={clearSearch}>
                Clear search
              </button>
            </div>
          )}
          {!loading && results.length > 0 && (
            <section className="search-results" aria-label="Search results" aria-live="polite">
              <div className="search-results-heading">
                <h3>Matches</h3>
                <span>{total} {total === 1 ? "result" : "results"} · 20 per page</span>
              </div>
              <div className="search-result-list">
                {results.map((result) => (
                  <a
                    className="search-result"
                    href={result.href}
                    key={`${result.entity_type}:${result.id}`}
                    aria-label={`Open ${result.entity_type}: ${result.title}`}
                  >
                    <span className="search-result-icon" aria-hidden="true">
                      {TYPE_INITIALS[result.entity_type]}
                    </span>
                    <span className="search-result-body">
                      <span className="search-result-heading">
                        <span className="search-result-type">{formatEntityType(result.entity_type)}</span>
                        <strong>
                          {highlightSegments(result.title, query).map((segment, index) => (
                            segment.match
                              ? <mark className="search-mark" key={index}>{segment.text}</mark>
                              : <span key={index}>{segment.text}</span>
                          ))}
                        </strong>
                      </span>
                      <span className="search-result-context">{result.context}</span>
                      {result.preview && (
                        <span className="search-result-preview">
                          {highlightSegments(result.preview, query).map((segment, index) => (
                            segment.match
                              ? <mark className="search-mark" key={index}>{segment.text}</mark>
                              : <span key={index}>{segment.text}</span>
                          ))}
                        </span>
                      )}
                    </span>
                  </a>
                ))}
              </div>
              <nav className="search-pagination" aria-label="Search result pages">
                <button
                  className="quiet-button"
                  type="button"
                  onClick={() => setPage((current) => Math.max(0, current - 1))}
                  disabled={page === 0 || loading}
                >
                  Previous
                </button>
                <span>Page {page + 1}</span>
                <button
                  className="quiet-button"
                  type="button"
                  onClick={() => setPage((current) => current + 1)}
                  disabled={(page + 1) * PAGE_SIZE >= total || loading}
                >
                  Next
                </button>
              </nav>
            </section>
          )}

          <footer className="search-footer">
            Didn&apos;t find it? Try a shorter phrase or another result type — or{" "}
            <a href="/workspaces">browse all workspaces</a>.
          </footer>
        </div>
      </section>
    </main>
  );
}

function formatEntityType(value: SearchEntityType): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function LockIcon() {
  return (
    <svg className="search-trust-icon" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function SearchEmptyIcon() {
  return (
    <svg className="search-empty-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M16.5 16.5 21 21" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

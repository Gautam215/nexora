"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { SearchEntityType } from "../../security/search-schemas.ts";

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

const PAGE_SIZE = 20;

export default function OrganizationSearchPage({ organizationId }: { organizationId: string }) {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [type, setType] = useState<"all" | SearchEntityType>("all");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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
  }, [organizationId, query, type, page]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = input.trim();
    setPage(0);
    if (value.length < 2) {
      setQuery("");
      setResults([]);
      setTotal(0);
      setError("Enter at least 2 characters to search.");
      return;
    }
    setQuery(value);
  }

  return (
    <main className="auth-layout workspace-layout">
      <aside className="auth-story">
        <a className="brand" href="/" aria-label="Nexora home">
          <span className="brand-mark" aria-hidden="true">N</span>
          <span>Nexora</span>
        </a>
        <div className="auth-story-copy">
          <p className="eyebrow">Workspace search</p>
          <h1>Find the detail that moves work forward.</h1>
          <p>Search across the projects, tasks and collaboration records available to you in this workspace.</p>
        </div>
        <div className="auth-story-foot">
          <span className="story-rule" aria-hidden="true" />
          <span>Results respect your current project access.</span>
        </div>
      </aside>

      <section className="auth-main" aria-label="Workspace search">
        <div className="workspace-card organization-dashboard project-dashboard search-dashboard">
          <a className="secondary-link" href={`/organizations/${encodeURIComponent(organizationId)}`}>
            Workspace
          </a>
          <p className="eyebrow search-eyebrow">Search this workspace</p>
          <h2 id="search-title">One place to look.</h2>
          <p className="search-description">Projects, tasks, comments, members and active file names. Only results you are allowed to access are returned.</p>

          <form className="search-form" onSubmit={submitSearch}>
            <label className="search-input-field">
              <span>Search terms</span>
              <input
                type="search"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                minLength={2}
                maxLength={120}
                placeholder="Try a project, task or phrase"
                aria-describedby="search-hint"
              />
            </label>
            <label className="search-filter-field">
              <span>Result type</span>
              <select
                value={type}
                onChange={(event) => {
                  setType(event.target.value as "all" | SearchEntityType);
                  setPage(0);
                }}
              >
                <option value="all">Everything</option>
                <option value="project">Projects</option>
                <option value="task">Tasks</option>
                <option value="comment">Comments</option>
                <option value="member">Members</option>
                <option value="file">Files</option>
              </select>
            </label>
            <button className="primary-button search-submit" type="submit" disabled={loading}>
              {loading ? "Searching..." : "Search"}
            </button>
            <p id="search-hint" className="search-hint">Use 2-120 characters. Search is limited to 20 matches per page.</p>
          </form>

          {error && <p className="form-message form-error" role="alert">{error}</p>}
          {loading && <p className="workspace-loading" role="status">Searching accessible workspace content...</p>}
          {!loading && query.length < 2 && !error && (
            <div className="search-empty">
              <span className="search-empty-mark" aria-hidden="true">?</span>
              <p>Search starts when you enter a phrase.</p>
            </div>
          )}
          {!loading && query.length >= 2 && !error && results.length === 0 && (
            <div className="search-empty">
              <span className="search-empty-mark" aria-hidden="true">-</span>
              <p>No accessible matches for {query}. Try a different phrase or result type.</p>
            </div>
          )}
          {results.length > 0 && (
            <section className="search-results" aria-label="Search results" aria-live="polite">
              <div className="search-results-heading">
                <h3>Matches</h3>
                <span>{total} {total === 1 ? "result" : "results"}</span>
              </div>
              <div className="search-result-list">
                {results.map((result) => (
                  <a
                    className="search-result"
                    href={result.href}
                    key={`${result.entity_type}:${result.id}`}
                    aria-label={`Open ${result.entity_type}: ${result.title}`}
                  >
                    <div className="search-result-heading">
                      <span className="search-result-type">{formatEntityType(result.entity_type)}</span>
                      <strong>{result.title}</strong>
                    </div>
                    <p className="search-result-context">{result.context}</p>
                    {result.preview && <p className="search-result-preview">{result.preview}</p>}
                  </a>
                ))}
              </div>
              <div className="search-pagination" aria-label="Search result pages">
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
              </div>
            </section>
          )}
        </div>
      </section>
    </main>
  );
}

function formatEntityType(value: SearchEntityType): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

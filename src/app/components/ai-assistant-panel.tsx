"use client";

import { useState } from "react";
import { SparklesIcon } from "./button-icons";

interface ApiResult<T> {
  data?: T;
  error?: { message?: string };
}

// AI project assistant. Read-only: answers come only from
// this project's data the caller can already access.
export default function AiAssistantPanel({
  organizationId,
  projectId,
}: {
  organizationId: string;
  projectId: string;
}) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function ask() {
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/organizations/${encodeURIComponent(organizationId)}/ai/assistant`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, question }),
      });
      const result = (await response.json().catch(() => null)) as ApiResult<{ answer: string }> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok || !result?.data?.answer) {
        throw new Error(result?.error?.message ?? "The AI answer could not be produced.");
      }
      setAnswer(result.data.answer);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The AI answer could not be produced.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="project-detail-section" aria-labelledby="ai-assistant-title">
      <div className="project-section-heading">
        <div>
          <h3 id="ai-assistant-title">AI project assistant</h3>
        </div>
      </div>
      <p className="project-section-copy">
        Ask about this project. Answers come only from its data you can already access; if the data does not
        answer the question, the assistant says so.
      </p>
      <label className="form-field">
        <span>Question</span>
        <input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          minLength={1}
          maxLength={1000}
          required
        />
      </label>
      <button className="primary-button" type="button" onClick={ask} disabled={pending || question.trim().length === 0}><SparklesIcon />
        {pending ? "Answering…" : "Ask"}
      </button>
      {answer ? <p className="project-section-copy">{answer}</p> : null}
      {error ? (
        <p className="form-message form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

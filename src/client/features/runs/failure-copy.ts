import type { PipelineStepId } from "../../../shared/pipeline.js";

export interface FriendlyFailure {
  readonly title: string;
  readonly explanation: string;
  readonly protection: string;
  readonly action: string;
  readonly latestTry?: string | undefined;
}

const isReview = (step: PipelineStepId) => step.startsWith("review_");

/** Turns safe server errors into plain-language, actionable operator guidance. */
export function friendlyFailure(
  step: PipelineStepId,
  error: string | null,
  stepAttempts: number,
): FriendlyFailure {
  const message = error?.toLowerCase() ?? "";
  const repeated = stepAttempts > 1;
  const latestTry = /after 2 attempts/.test(message)
    ? "During the latest try, the app asked the AI twice before stopping safely."
    : undefined;

  if (step === "internal_link_discovery" && /link discovery blocked/.test(message)) {
    const sourceUnavailable = /sources are unavailable|not configured/.test(message);
    const editorialOnly = /editorial pages only/.test(message);
    const verificationFailed = /direct http 200/.test(message);
    return {
      title: sourceUnavailable
        ? "Link sources need attention"
        : editorialOnly
          ? "No commercial link candidates were found"
          : verificationFailed
            ? "Commercial links could not be verified"
            : "No eligible internal links were found",
      explanation: sourceUnavailable
        ? "The public sitemap is unavailable or not configured, and no valid read-only Search Console fallback was available."
        : editorialOnly
          ? "The sources responded, but every discovered page was editorial rather than commercial."
          : verificationFailed
            ? "Commercial candidates were found, but none returned a direct HTTP 200."
            : "The configured sources returned no candidates for this keyword.",
      protection: "Drafting did not start, so no AI cost was incurred.",
      action:
        "Check the source health and configuration shown below, then select ‘Retry link discovery’. The retry refreshes this same run.",
    };
  }

  if (/draft provider outcome is ambiguous/.test(message))
    return {
      title: "The draft request needs technical review",
      explanation:
        "The app cannot prove whether the AI processed the previous request before the connection or process stopped.",
      protection: "The app will not automatically make another potentially paid request.",
      action:
        "Do not keep selecting Resume. Ask the technical owner to review this reserved draft operation and explicitly authorise a separate recovery operation if another paid request is acceptable.",
    };

  if (/pre-checkpoint draft failure requires explicit operator authorisation/.test(message))
    return {
      title: "This earlier draft attempt needs confirmation",
      explanation:
        "This run failed before durable draft checkpoints were available, so no reusable AI response was stored.",
      protection: "No new AI request is made until you explicitly continue this historical run.",
      action:
        "Selecting ‘Resume safely’ once explicitly authorises one new draft request for this historical run.",
    };

  if (/locked after 2 failed executions/.test(message)) {
    return {
      title: "This revision setup is paused",
      explanation:
        "The same AI provider, model, prompt and planning version has failed twice in the same way.",
      protection: "The app did not call the AI again, and the original article remains unchanged.",
      action:
        "Use a different AI provider or model, or deploy a new prompt or planning contract version, then select ‘Resume safely’ once. Changing only the access key will not unlock this setup.",
    };
  }

  if (/unparseable|structured output|invalid (output|response)/.test(message)) {
    if (step === "revision_pass") {
      return {
        title: "The article could not be safely revised",
        explanation:
          "The AI replied, but the app could not confirm that it changed only the approved parts of the article.",
        protection: "The original article remains unchanged.",
        action: repeated
          ? "Do not keep retrying with the same setup. Choose a more capable AI model, restart the app, then select ‘Resume safely’ once."
          : "This may be temporary. Select ‘Resume safely’ to try once more.",
        latestTry,
      };
    }
    if (isReview(step) || step === "final_coherence_export") {
      return {
        title:
          step === "final_coherence_export"
            ? "The final review could not be completed"
            : "The review could not be completed",
        explanation: "The AI replied, but the app could not safely understand its review results.",
        protection:
          step === "final_coherence_export"
            ? "The article remains safely stored and no incomplete Google Doc was created."
            : "No findings from that response were saved.",
        action: repeated
          ? "Do not keep retrying with the same setup. Choose a more capable AI model, restart the app, then select ‘Resume safely’ once."
          : "This may be temporary. Select ‘Resume safely’ to try once more.",
        latestTry,
      };
    }
    return {
      title: "The AI response could not be safely used",
      explanation:
        "The AI replied, but its answer was incomplete or not in the format this step needs.",
      protection: "Nothing from that response was saved.",
      action: repeated
        ? "Do not keep retrying with the same setup. Choose a more capable AI model, restart the app, then select ‘Resume safely’ once."
        : "This may be temporary. Select ‘Resume safely’ to try once more.",
      latestTry,
    };
  }

  if (/timed out|timeout/.test(message))
    return {
      title: "The AI took too long to respond",
      explanation: "The selected AI did not finish this step in time.",
      protection: "Completed work from earlier steps remains safely stored.",
      action: repeated
        ? "Choose a faster or more capable AI model, restart the app, then select ‘Resume safely’ once."
        : "Wait briefly, then select ‘Resume safely’ once.",
    };

  if (/network|could not connect|failed to fetch/.test(message))
    return {
      title: "The AI service could not be reached",
      explanation:
        "The app could not connect to the selected AI service. It may be temporarily unavailable.",
      protection: "Completed work from earlier steps remains safely stored.",
      action:
        "Check your internet connection and whether the AI service is available, then select ‘Resume safely’ once.",
    };

  if (/\b401\b|credential|access key|token missing/.test(message))
    return {
      title: "The AI connection needs attention",
      explanation: "The selected AI service did not accept the configured access key.",
      protection: "Your article and completed pipeline work remain safely stored.",
      action: "Check the private access key, restart the app, then select ‘Resume safely’ once.",
    };

  if (/\b402\b|billing|credit/.test(message))
    return {
      title: "The AI account cannot process this request",
      explanation: "The selected AI account may not have enough credit or access for this model.",
      protection: "Your article and completed pipeline work remain safely stored.",
      action:
        "Check the account or choose another available model, restart the app, then select ‘Resume safely’ once.",
    };

  if (/\b403\b|forbidden|guardrail|permission/.test(message))
    return {
      title: "The AI service refused the request",
      explanation:
        "The app reached the AI service, but the account may not be allowed to use the selected model.",
      protection: "Your article and completed pipeline work remain safely stored.",
      action:
        "Check the model access and account settings, restart the app if you make a change, then select ‘Resume safely’ once.",
    };

  if (/\b404\b|model not found|model unavailable/.test(message))
    return {
      title: "The selected AI model is unavailable",
      explanation: "The configured AI model could not be found or used.",
      protection: "Your article and completed pipeline work remain safely stored.",
      action:
        "Check the model name or choose another available model, restart the app, then select ‘Resume safely’ once.",
    };

  if (/\b429\b|rate limit/.test(message))
    return {
      title: "The AI service is temporarily busy",
      explanation: "The app has reached the service’s current request limit.",
      protection: "Your article and completed pipeline work remain safely stored.",
      action: "Wait a few minutes, then select ‘Resume safely’ once.",
    };

  if (/http 5\d\d|provider unavailable|service unavailable/.test(message))
    return {
      title: "The AI service is temporarily unavailable",
      explanation: "The selected AI service could not complete the request just now.",
      protection: "Your article and completed pipeline work remain safely stored.",
      action: repeated
        ? "Check the service status or choose another model, restart the app if needed, then select ‘Resume safely’ once."
        : "Wait briefly, then select ‘Resume safely’ once.",
    };

  if (step === "final_coherence_export") {
    if (/stage=coherence_|category=coherence_/.test(message))
      return {
        title: "The final coherence review needs attention",
        explanation:
          "The final review could not be validated against the exact controlled revision changes.",
        protection: "The article remains safely stored and Google Docs was not contacted.",
        action:
          "Do not keep retrying. Ask the technical owner to review the final coherence checkpoint and its safe failure category.",
      };
    if (/category=template_integrity/.test(message))
      return {
        title: "The export templates need attention",
        explanation:
          "The required writer or blog-schema template is missing, invalid, or not authorised for this environment.",
        protection: "The article remains safely stored and Google Docs was not contacted.",
        action:
          "Ask the technical owner to check the configured content-template versions and approval policy, then select ‘Resume safely’ once after it is corrected.",
      };
    if (
      /stage=(reference_snapshot|run_context|deterministic_gate|export_context|export_render)/.test(
        message,
      ) ||
      /category=(reference_integrity|deterministic_gate|schema_validation|internal_preflight|export_integrity)/.test(
        message,
      )
    )
      return {
        title: "The final export preparation needs attention",
        explanation:
          "The app stopped during a final integrity check before contacting Google Docs.",
        protection: "The article remains safely stored and Google Docs was not contacted.",
        action:
          "Do not keep retrying. Ask the technical owner to review the safe Step 1.12 stage and category.",
      };
    if (/category=idempotency_conflict/.test(message))
      return {
        title: "The reserved Google document needs technical review",
        explanation:
          "The app found an existing reserved Google document but could not prove it is the exact expected export.",
        protection:
          "The article remains safely stored; the existing document was not overwritten and no duplicate was created.",
        action:
          "Do not retry or reconnect Google. Ask the technical owner to review the safe Step 1.12 idempotency reason.",
      };
    // Google accepted the write; only the read-back verification failed. The
    // connection is demonstrably fine, so never advise reconnecting it.
    if (/category=google_structure/.test(message))
      return {
        title: "The exported document could not be verified",
        explanation:
          "Google Docs accepted the document, but the app could not confirm it matches the approved article exactly.",
        protection: "The article remains safely stored, and no duplicate document will be created.",
        action:
          "Do not keep retrying. Ask the technical owner to review the safe Step 1.12 structural reason; Google does not need reconnecting.",
      };
    if (/category=(google_api|google_connection)/.test(message))
      return {
        title: "The Google Doc could not be created",
        explanation: "The final document reached Google export but could not be completed.",
        protection: "The article is still safely stored in the app.",
        action:
          "Check that Google is connected and the Docs and Drive APIs are enabled, then select ‘Resume safely’ once.",
      };
    return {
      title: "The final step could not be completed",
      explanation:
        "The app stopped safely, but the available error does not prove that Google Docs was contacted.",
      protection: "The article remains safely stored.",
      action:
        "Do not keep retrying. Ask the technical owner to inspect the safe Step 1.12 diagnostics.",
    };
  }

  if (/export|google doc/.test(message))
    return {
      title: "The Google Doc could not be created",
      explanation: "The final document could not be sent to Google Docs.",
      protection: "The article is still safely stored in the app.",
      action: "Check that Google is connected, then select ‘Resume safely’ once.",
    };

  return {
    title: "This step could not be completed",
    explanation: "The app stopped this step because it could not safely finish the work.",
    protection: "Completed work from earlier steps remains safely stored.",
    action: repeated
      ? "This has happened more than once. Check the app setup or ask the technical owner for help, then select ‘Resume safely’ once."
      : "Select ‘Resume safely’ to continue from this step without repeating completed work.",
  };
}

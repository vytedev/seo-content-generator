# OpenRouter connection diagnostic

The authenticated application UI is the primary way to run this diagnostic. In a run workspace,
open **Export → OpenRouter connection**, acknowledge **“This sends one small paid request”**, then
select **Test OpenRouter connection**. The diagnostic is independent of Step 1.2 and never creates or
advances a content run.

It sends one fixed, five-output-token request to the server-configured pinned OpenRouter model. It
does not accept a prompt, model, endpoint or key from the browser, and it does not retry.

For local API troubleshooting, first sign in and retain the HttpOnly session cookie and CSRF token.
Then use a new client-generated UUID as the operation identity:

```bash
curl --fail-with-body \
  --request POST \
  --header 'Origin: http://127.0.0.1:5173' \
  --header 'Content-Type: application/json' \
  --header 'X-CSRF-Token: <csrf-token-from-authenticated-session>' \
  --header 'Idempotency-Key: 123e4567-e89b-42d3-a456-426614174000' \
  --cookie 'mm03_operator_session=<http-only-session-cookie>' \
  --data '{"explicit_confirmation":true}' \
  http://127.0.0.1:3100/api/integrations/model/diagnostic
```

Reusing an idempotency key returns its saved safe result without another provider request. A pending
operation is treated as ambiguous after interruption and is not automatically retried.

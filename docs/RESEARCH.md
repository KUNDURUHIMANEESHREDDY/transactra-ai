# Research provider and zero-spend guard

## Provider choice

Transactra's first web-search adapter is Tavily Search using Basic Search only. Tavily's current Researcher plan includes 1,000 API credits per month, requires no credit card, and does not charge unless Pay As You Go is enabled. Tavily documents Basic Search at one credit per request and Advanced Search at two credits.

Official references:
- https://www.tavily.com/pricing
- https://help.tavily.com/articles/8298987937-billing-credits-usage-limits
- https://docs.tavily.com/documentation/api-credits
- https://help.tavily.com/articles/4716869118-attribution-third-party-content-rights

## Transactra enforcement

- Search depth is fixed to `basic`; agents cannot request Advanced Search.
- The internal monthly cap defaults to 800 requests and 800 credits, leaving a 200-credit safety buffer against the stated 1,000-credit free allowance.
- PostgreSQL reserves one request and one credit atomically before every network call.
- A failed or timed-out call retains its reservation conservatively.
- When either cap is reached, the provider stops before sending a request.
- The worker refuses to activate Tavily unless `TAVILY_PAYG_DISABLED_CONFIRMED=true`.
- This environment flag is an operator attestation, not a remote verification of the Tavily billing setting. Confirm Pay As You Go is disabled in the Tavily account dashboard.
- No automatic upgrade, paid fallback or card-based overage is implemented.

## Evidence integrity

Search results are registered against the originating task. Opportunity scoring accepts only URLs returned by that task's real search calls. Publisher class, credibility and relevance are derived from source-domain rules and Tavily relevance scores; undated pages are excluded from opportunity scoring. The score is a prioritization signal, not proof of market demand.

Tavily does not grant rights to third-party content returned by Search. Transactra retains source URLs and limited snippets for research traceability; downstream use must respect the publisher's terms and applicable rights.

## Activation

Set `TAVILY_API_KEY`, verify that the account is on the free Researcher plan with Pay As You Go disabled, and then set `TAVILY_PAYG_DISABLED_CONFIRMED=true`. Leave the integration disabled if the account's free entitlement or billing mode cannot be verified.

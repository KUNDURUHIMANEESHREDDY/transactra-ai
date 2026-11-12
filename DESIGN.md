# Transactra Design System

## Product character
A precise, calm payment operations desk: more financial instrument than chatbot. The interface makes intent legible and approval deliberate. Audience: hackathon judges and developers testing a natural-language payment workflow.

## Visual direction
- Canvas cool mist #F4F6FA; white surfaces #FFFFFF.
- Primary ink midnight #17243B; deep shell #111D33.
- Action cobalt #315EE8; hover #244FD2.
- Confirmed emerald #138B69; warning amber #A66D19; error red #A53C37.
- Borders #E5E9F0; muted text #78849A.
- Manrope headings, DM Sans interface copy, DM Mono financial metadata.
- Compact 6–9px radii, fine dividers, low-elevation surfaces.
- Signature: midnight navigation rail and the typographic Payments, understood hero.

## Runtime mapping
apps/web/src/styles.css is the canonical runtime token and component stylesheet. Vite config owns React/Tailwind integration. Do not add competing palettes.

## Interaction principles
- No transaction is created before review and explicit buyer approval.
- Never represent an order as paid until PayPal capture returns COMPLETED.
- Secrets stay server-side; errors are inline; no native browser dialogs.
- PayPal approval UI is owned by the PayPal JavaScript SDK.
- Respect reduced-motion preferences and visible keyboard focus.
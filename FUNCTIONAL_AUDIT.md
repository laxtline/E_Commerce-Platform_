# Functional audit — 10 November 2026

The core API can complete a COD purchase against a MongoDB replica set. The project also has reproducible payment, refund, inventory, and integration defects. It is not verified as production-ready. The previous report's percentages and blanket “working” claims are withdrawn.

## Evidence and limits

| Check actually executed | Result |
|---|---|
| Backend TypeScript | Passed, including the added audit runner |
| Frontend TypeScript | Passed |
| Mobile TypeScript | Passed |
| Next.js production build | Passed; warning about incorrectly inferred monorepo root |
| Frontend auth regression suite | 9 tests passed; mocked session behavior, not real Google sign-in |
| Existing backend smoke test | 20 passed, 14 failed out of 34 |
| Added isolated API/database audit | 52 passed, 10 failed out of 62 |
| Frontend lint script | Did not complete a lint check: prompted to configure ESLint, exited 1 |
| Interactive browser/device verification | Unavailable: browser access host and native UI pipe both unavailable |

The audit runner boots the real Express app with a disposable single-node MongoDB replica set. It creates synthetic customer/admin sessions, performs HTTP requests, and checks stored documents. It never uses the configured application database. External payment, email, and push delivery were not performed. Razorpay keys and signed webhook payloads in the audit are synthetic fixtures. Existing user modifications were preserved; no application behavior was changed.

Individual results and response evidence are in `AUDIT_RESULTS.json`. Reproduce the added audit from `Website/backend` with `rtk npx tsx src/seed/auditVerification.ts`. Exit code 1 is expected while recorded failures remain. The optional `--serve` flag keeps the disposable API alive on loopback port 5000 for further testing.

## Confirmed working at the API/database boundary

| Feature | What was observed |
|---|---|
| Catalog | Public list, search, distinct cursor pages, create/update/delete, and public disappearance after deletion |
| Authorization | Unauthenticated cart rejected; customers rejected from admin endpoints; another customer rejected from order access |
| Sessions | A signed fixture JWT restores the correct user; invalid Google credential rejected; logout endpoint succeeds |
| Cart | Add/update/remove save; quantities exceeding stock rejected; mobile merge saves and retry does not double quantity |
| Wishlist | Add survives a fresh GET; removal succeeds |
| Addresses | Add/update/delete persist in the user's stored document |
| Coupons | Admin create/update and usage endpoint succeed; validation uses actual cart prices rather than caller-supplied totals |
| COD checkout | Twelve units at bulk price ₹42 produce ₹504 subtotal, ₹49 shipping, ₹50.40 coupon discount, ₹502.60 final total; order commits, stock falls from 100 to 88, cart clears |
| Fulfillment | All five valid transitions through CONFIRMED, PACKED, SHIPPED, OUT_FOR_DELIVERY, DELIVERED succeed; illegal direct jump rejected |
| Cancellation | Stock restored once; repeated cancellation does not duplicate inventory |
| Reviews | Review saves and updates product rating; deletion resets review count |
| Branding | Update is returned by a subsequent GET |
| Courier | Name/tracking ID persist and tracking endpoint returns them; history has a separate defect below |
| Image upload | File written and subsequently retrievable by HTTP; assigning it to a product fails separately |
| Return request | An owned delivered order accepts and stores a return request; later workflow has defects below |

These results establish API behavior with fixtures. They do not establish that every associated browser control renders, handles errors, or refreshes correctly.

## Reproduced failures

| Priority | Failure and observed impact | Source / repair direction |
|---|---|---|
| P1 | A signed capture webhook changed a CANCELLED order to PAID after cancellation restored inventory. Payment and stock can contradict each other. | `Website/backend/src/controllers/paymentController.ts:214`; guard final order state and reconcile late captures/refunds atomically. |
| P1 | Correct HMAC over a JSON payload containing whitespace was rejected with HTTP 400. Handler verifies reserialized JSON rather than original bytes. | `paymentController.ts:148`; preserve and verify raw request bytes. |
| P1 | An approved return for a ₹502.60 order accepted a ₹999,999 refund record (HTTP 201). This is an invalid accounting record, not an actual transfer of money. | `Website/backend/src/controllers/orderController.ts:455`; bound finite numeric refund amounts by refundable paid balance. |
| P1 | A REQUESTED return could jump directly to REFUNDED (HTTP 200), with no approval, received goods, or refund transaction. | `orderController.ts:386`; enforce state transitions and tie refunded status to a completed refund record. |
| P1 | Failed online payment increased reported revenue from ₹502.60 to ₹599.60. | `orderController.ts:211` and `:240`; online revenue filter must require PAID, not merely “not PENDING.” |
| P1 | Three-hour-old FAILED online order retained its reservation after cleanup. | `Website/backend/src/services/orderCleanup.ts:47`; cleanup currently only selects PENDING payments. |
| P2 | Courier update added literal `$status` to history instead of DELIVERED. | `orderController.ts:274`; standard updates do not evaluate this string as a field expression. Same pattern appears in refund completion at `:559`. |
| P2 | A one-character webhook signature produces HTTP 500 / RangeError. | `paymentController.ts:154`; validate signature encoding and byte length before constant-time comparison. |
| P2 | Image upload returns a working `/uploads/...png` URL, but saving that URL to a product returns HTTP 400 demanding ImageKit HTTPS URLs. | `Website/backend/src/controllers/productController.ts:153`; align the upload output and accepted image URL policy. Categories have the same policy mismatch. |
| P2 | Delivered COD orders remain payment PENDING. This is deliberate in current code, but no cash collection API/UI completes the intended workflow. | `orderController.ts:160`; implement collection tracking or an explicitly agreed payment policy. |

## Present in code but incomplete or disconnected

The following findings are source-confirmed, not browser reproductions.

| Feature | Current behavior and gap |
|---|---|
| Customer returns | Backend request/status routes exist. Order details have no return request form. |
| Admin returns/refunds | Backend endpoints exist; admin navigation/screens have no approval, pickup, refund initiation/completion controls. |
| Actual refund payout | Refund functions create encrypted database records and mark records completed. No bank, UPI, or Razorpay refund transfer is performed. A manual payout would need a defined operational workflow. |
| Paid cancellation | Cancellation restocks without initiating a refund. Existing refund route requires an approved/received return, but cancelled orders cannot request a return because only delivered orders qualify. |
| Courier editing | API exists; no admin editor calls it. Tracking displays existing information only. |
| Mobile tracking/push | Native screens/hooks call protected endpoints but implement no native sign-in or bearer/session transfer. Signing into the external web checkout does not authenticate the native API client. |
| Mobile-to-web checkout | Web checkout sets its import guard before the authenticated merge call. Guest arrival can fail import once and cannot retry when auth changes. Empty-cart rendering then hides import error/login controls. See `CheckoutView.tsx:73` and `:172`. |
| Older customer orders | Backend pages at 10 orders by default; `ordersSlice.ts:45` discards pagination metadata, and the orders screen provides no next-page control. |
| Older reviews | ProductReviews loads only the first default page (10); no older-page navigation. An older owner review may not be found for prefill/delete. |
| Mobile catalog | Loads only newest 20 with no pagination/search control to reach the rest. See `MobileApp/app/index.tsx:32`. |
| Order timeline | `OrderDetailView.tsx:221` includes only PLACED, CONFIRMED, SHIPPED, DELIVERED. PACKED and OUT_FOR_DELIVERY produce index -1 and all steps appear inactive. |
| Price filter state | `ProductFilters.tsx:31` initializes local inputs once; Back/Forward or changed URL filters can leave displayed values stale relative to results. |
| Invoice export | Invoice link and `window.print()` are wired. “Print / Save as PDF” delegates to the browser dialog; there is no direct generated PDF download. No actual print dialog or saved file was verified. |
| Delivery restrictions | Shared calculation supports serviceable areas, COD restrictions, and pincode rates, but default config has none. Current default permits all valid pincodes at the fixed fee/free-shipping threshold. No admin configuration workflow was found. |

## Configuration and test infrastructure

- Checked-in local configuration uses placeholder Google client IDs. Real Google sign-in cannot be validated with these values. A placeholder JWT secret is insecure but does not inherently stop JWT signing/verification; the earlier claim that it would prevent validation was wrong.
- Razorpay and Resend credentials are empty in the inspected backend `.env`. Actual payment checkout and email delivery are unavailable with that configuration. COD placement does call the email helper; the audit observed its disabled-email log, correcting the earlier claim that COD never triggers email.
- Refund encryption requires a base64 encoding of exactly 32 key bytes; the example environment file does not document the key or push-enable setting. Configuring a key alone does not implement a money transfer.
- Mobile `app.json` points API and storefront at localhost. A physical device needs reachable service URLs; localhost there refers to the device itself.
- The existing smoke test uses `MongoMemoryServer`, a standalone server, while checkout uses transactions. That produces HTTP 500. A deployment using standalone MongoDB would encounter the same transaction requirement; use a replica set/Atlas and document it.
- The existing smoke test also skips PACKED/OUT_FOR_DELIVERY in its expected transitions, expects delivered COD to be automatically paid, and expects coupons to trust submitted `itemsTotal`. These expectations no longer match the implementation. Its 14 failures are not 14 independent application defects.
- Lint is not configured for a noninteractive run. A successful build/typecheck is not proof that lint passed.
- The build inferred a workspace root above this repository because of multiple lockfiles. Set the intended tracing root after checking deployment layout.
- Vercel CLI is not installed. For a separate deployment audit, installing it with `npm i -g vercel` is strongly recommended to enable `vercel env pull`, `vercel deploy`, and `vercel logs`. No CLI installation or deployment was performed for this local audit.

## Remaining verification

Browser host availability is the concrete blocker for verifying every click, form validation message, UI refresh, dark mode, responsive view, and invoice save. A native device/emulator is needed for mobile interaction and push delivery. Real configured sandbox credentials are needed for Google sign-in and Razorpay checkout/capture/retry; verified service configuration is needed for email/push delivery. No live funds were moved or external notifications sent.

The prior claim that mobile had no screens was incorrect: catalogue, product, cart, tracking, layout, branding, social links, and web checkout handoff are implemented. Their existence and passing TypeScript checks do not establish full native feature parity.

Recommended repair order: webhook/payment state consistency; refund validation and transitions; revenue and reservation cleanup; align image uploads; add missing operational UI and COD collection; repair pagination/timeline/mobile authentication; then rerun API regressions and complete browser/device tests.

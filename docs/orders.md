# Order Management System — API Reference

Base paths:
- `/api/orders` — buyer/seller order endpoints
- `/api/payments` — payment webhook (provider → backend)
- `/api/admin/orders` — admin management endpoints

All endpoints require `Authorization: Bearer <JWT>` unless noted. Roles in
parentheses: **buyer**, **seller**, **admin**.

Error shape:

```json
{ "success": false, "message": "...", "code": "MACHINE_CODE", "details": [...] }
```

Success shape: `{ "success": true, "message": "...", "data": ... }`.

---

## Order statuses

`PENDING_PAYMENT → PAID → REQUIREMENTS_NEEDED | IN_PROGRESS → DELIVERED → COMPLETED`

plus side branches: `REVISION_REQUESTED`, `CANCEL_REQUESTED → CANCELLED`,
`DISPUTED` (escalatable from any non-terminal state; admin resolves to
`COMPLETED` or `CANCELLED`).

---

## POST /api/orders/checkout-preview (buyer)

Stateless price/delivery preview — nothing is created.

Body:

```json
{
  "gigId": "507f1f77bcf86cd799439011",
  "packageId": "basic",
  "extraIds": ["extra1", "extra2"]
}
```

Response includes `pricing` (cents + decimals), `delivery.days`,
`delivery.estimatedDueAt`, `requirements` (active gig questions), and the
resolved package/extras.

## POST /api/orders/create-payment (buyer)

Create the Payment intent + Payment record for an order.

Body: `{ "orderId": "...", "paymentMethod": "wallet|card", "idempotencyKey": "..." }`

Returns `clientSecret` (mock: `mockpay_..._secret_...`). The order is NOT
activated until the webhook is processed.

## POST /api/orders (buyer)

Place an order (idempotent).

Body:

```json
{
  "gigId": "507f1f77bcf86cd799439011",
  "packageId": "basic",
  "extraIds": ["extra1"],
  "projectDescription": "I need a landing page.",
  "requirements": [{ "questionId": "...", "answer": "...", "files": [] }],
  "attachments": [{ "name": "brief.pdf", "url": "https://...", "publicId": "blockefy/order-files/...", "mimeType": "application/pdf", "extension": ".pdf", "size": 1234 }],
  "idempotencyKey": "client-generated-uuid",
  "paymentMethod": "wallet"
}
```

Notes:
- `idempotencyKey` is required and stored on `payment.idempotencyKey`; reusing
  it returns the existing order (`duplicate: true`).
- `projectDescription` is required and capped at
  `projectDescriptionMaxLength` (config).
- Requirement answers are validated against the **gig's** requirement
  definitions; unknown question IDs are rejected.
- Amounts are computed server-side from the gig database records.

## GET /api/orders (buyer | seller)

Query params: `filter`, `sort`, `page`, `limit` (max `maxPageLimit`).

- Buyer filters: `active`, `delivered`, `completed`, `cancelled`, `revision_requested`
- Seller filters: `new`, `active`, `delivered`, `revision_requested`, `completed`, `cancelled`
- Sorts: `createdAt`, `updatedAt`, `dueAt` (prefix `-` for descending)

## GET /api/orders/:orderId (buyer | seller)

Full order detail. Access control: buyer or seller on that order (or admin).

## GET /api/orders/number/:orderNumber (buyer | seller)

Lookup by human-readable order number (e.g. `BLK-2026-000001`).

## GET /api/orders/:orderId/files (buyer | seller)

List uploaded files for the order (requirements attachments, deliveries,
revision attachments, dispute evidence).

## GET /api/orders/:orderId/timeline (buyer | seller)

Order event timeline (created, paid, requirements submitted, delivered,
revision requested, completed, cancelled, dispute opened/resolved…).

## POST /api/orders/:orderId/requirements (buyer)

Submit requirements while order is `PAID` or `REQUIREMENTS_NEEDED`. Transitions
to `IN_PROGRESS` and starts the delivery clock.

Body: `{ "projectDescription": "...", "requirements": [...], "attachments": [...] }`

## POST /api/orders/:orderId/delivery (seller)

Submit a delivery while `IN_PROGRESS` or `REVISION_REQUESTED`.

Multipart/form-data: `message`, `files` (up to `maxDeliveryFiles`),
`notes`, `links` (JSON array `[{ label, url }]`).

Transitions to `DELIVERED`; a review window of `orderReviewPeriodHours` begins
(until `delivery.reviewPeriodEndsAt`).

## POST /api/orders/:orderId/revision (buyer)

Request a revision on a `DELIVERED` order. Body: `{ "message": "...", "attachments": [...] }`.

- Enforced against the package's `revisions` allowance (`-1` = unlimited).
- The counter increment is atomic (`$expr` guard) — a concurrent
  double-request cannot exceed the limit.
- Transitions to `REVISION_REQUESTED`.

## POST /api/orders/:orderId/accept (buyer)

Accept a `DELIVERED` order → `COMPLETED`. Releases seller earnings (escrow →
seller, platform fee withheld).

## POST /api/orders/:orderId/cancel-request (buyer | seller)

Request cancellation from `PAID` / `REQUIREMENTS_NEEDED` / `IN_PROGRESS` /
`DELIVERED` / `REVISION_REQUESTED`. Body: `{ "reason": "..." }`. Transitions to
`CANCEL_REQUESTED` and notifies the other party. Resolution is admin-only.

## POST /api/orders/:orderId/dispute (buyer | seller)

Open a dispute from any non-terminal status. Body: `{ "reason": "..." }`.
Transitions to `DISPUTED` and freezes all normal flows.

---

## Payment webhook (no auth)

### POST /api/payments/webhook

Provider → backend. Body is `payment.succeeded` JSON signed with the provider's
HMAC secret.

Request headers:
- `x-webhook-signature` (or `x-mock-signature` for the dev provider)
- `Content-Type: application/json`

Payload:

```json
{
  "eventId": "evt_...",
  "type": "payment.succeeded",
  "intentId": "mockpay_...",
  "orderRef": "BLK-2026-000001",
  "amount": 5500,
  "currency": "USD",
  "timestamp": "2026-08-08T00:00:00.000Z"
}
```

Verification pipeline (in order):
1. Signature (constant-time compare)
2. Event idempotency (duplicate `eventId` ignored)
3. Intent exists
4. Amount matches `order.pricing.totalCents`
5. Currency matches
6. `orderRef` matches `order.orderNumber`
7. Payment state is `pending`
8. Atomic `pending → confirmed`
9. Escrow funded (wallet) + order activated

Non-`payment.succeeded` events are acknowledged and ignored.

### POST /api/payments/webhook/dev-verify (non-production)

Signs/verifies a mock payload — returns `{ "verified": true }` on success.
Useful for frontend debugging before a real provider is wired in.

---

## Admin endpoints (admin)

### GET /api/admin/orders

Same filters as buyer plus `disputed` and `pending_payment`. Search supported
via query params (`search`, `filter`, `sort`, `page`, `limit`).

### GET /api/admin/orders/:orderId

Full order detail.

### POST /api/admin/orders/:orderId/cancellation/resolve

Body: `{ "approve": true, "resolution": "cancelled" }`

- Approve → `CANCELLED`, escrow refunded to buyer.
- Reject → resumes from the pre-request status.

### POST /api/admin/orders/:orderId/dispute/resolve

Body: `{ "resolution": "refund_buyer|cancelled|release_seller", "notes": "..." }`

- `refund_buyer` / `cancelled` → `CANCELLED`, escrow refunded.
- `release_seller` → `COMPLETED`, earnings released.

### POST /api/admin/orders/:orderId/earnings/release

Manually trigger escrow → seller release (fallback).

### POST /api/admin/orders/jobs/auto-complete

Runs the auto-complete job (delivered orders past their review window →
`COMPLETED` + earnings released). Returns `{ "completed": n }`.

### POST /api/admin/orders/jobs/reconcile-payments

Runs payment reconciliation (stale `PENDING_PAYMENT` orders past TTL →
`CANCELLED`). Returns `{ "cancelled": n }`.

---

## Background jobs

In-process scheduler runs both jobs periodically when `index.js` is the
entrypoint in non-production. On serverless, trigger the admin job endpoints
via cron instead. Both jobs use atomic conditional updates, so running
concurrently (or overlapping runs) is safe.

## Money & fees

- All money math uses integer cents; pricing is always recomputed server-side
  from database records (`orderPricing.service.js`).
- `platformFeePercent` (default 10) and `taxPercent` (default 0) live in
  `src/config/orderConfig.js` and can be overridden by admins per-order.
- Totals: `total = subtotal + platformFee + tax − discount` (never negative).

## Configuration (`src/config/orderConfig.js`)

`currency`, `platformFeePercent`, `taxPercent`, `projectDescriptionMaxLength`,
`maxExtrasPerOrder`, `maxRequirementsAnswers`, `maxAttachments`,
`maxFileSizeBytes`, `maxDeliveryFiles`, `maxDeliveryMessageLength`,
`maxRevisionMessageLength`, `maxCancellationReasonLength`,
`minimumDeliveryDays`, `maximumDeliveryDays`, `unlimitedRevisions`,
`orderReviewPeriodHours`, `pendingPaymentTtlMinutes`, `paymentProvider`,
`mockAutoConfirm`, `webhookSecret`, `supportedPaymentMethods`,
`maxPageLimit`, `defaultPageLimit`.

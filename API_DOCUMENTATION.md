# Blockefy Dashboard API Documentation

## Overview
This document outlines all Dashboard API endpoints for the Blockefy platform. The API uses MongoDB for data storage and requires JWT authentication for all dashboard endpoints.

## Base URL
```
http://localhost:7980/dashboard
```

## Authentication
All dashboard endpoints require a valid JWT token in the Authorization header:
```
Authorization: Bearer <token>
```

---

# Models & Database Schema

## New Models Created

### 1. Order Model
```javascript
{
  _id: ObjectId,
  orderNumber: String (unique, e.g., "ORD-XXXXXXXXX-00001"),
  buyerId: ObjectId (ref: User),
  sellerId: ObjectId (ref: User),
  gigId: ObjectId (ref: Gig),
  packageType: "basic" | "standard" | "premium",
  status: "pending" | "active" | "in_progress" | "review" | "completed" | "cancelled" | "disputed",
  requirements: String,
  startDate: Date,
  dueDate: Date (required),
  deliveryDate: Date,
  amount: Number (required, min: 0),
  platformFee: Number,
  sellerEarnings: Number,
  currency: String (default: "USD"),
  paymentStatus: "unpaid" | "paid" | "refunded" | "partial",
  escrowId: ObjectId,
  projectTitle: String (required),
  projectDescription: String,
  deliverableUrl: String,
  deliverableFiles: [{ name, url, publicId }],
  revisionsUsed: Number,
  revisionsAllowed: Number,
  isLate: Boolean,
  lateReason: String,
  cancelReason: String,
  cancelledBy: ObjectId,
  createdAt: Date,
  updatedAt: Date
}
```

### 2. Project Model
```javascript
{
  _id: ObjectId,
  projectNumber: String (unique, e.g., "PRJ-XXXXXXXXX-00001"),
  buyerId: ObjectId (ref: User),
  title: String (required, max: 200),
  description: String (required, max: 5000),
  category: String (required),
  subcategory: String,
  skills: [String],
  experienceLevel: "entry" | "intermediate" | "expert",
  projectType: "fixed" | "hourly",
  budget: { min: Number, max: Number, currency: String },
  duration: String,
  status: "draft" | "open" | "in_progress" | "completed" | "cancelled" | "paused",
  visibility: "public" | "private" | "invite_only",
  hiredSellerId: ObjectId,
  hiredAt: Date,
  attachments: [{ name, url, publicId, type }],
  milestones: [{ title, description, amount, dueDate, status }],
  deadline: Date,
  proposalCount: Number,
  selectedProposalId: ObjectId,
  completedAt: Date,
  cancelReason: String,
  createdAt: Date,
  updatedAt: Date
}
```

### 3. Proposal Model
```javascript
{
  _id: ObjectId,
  proposalNumber: String (unique, e.g., "PRP-XXXXXXXXX-00001"),
  projectId: ObjectId (ref: Project),
  sellerId: ObjectId (ref: User),
  buyerId: ObjectId (ref: User),
  coverLetter: String (required, max: 5000),
  bidAmount: Number (required, min: 0),
  estimatedDuration: String (required),
  milestones: [{ title, description, amount, dueDate }],
  startDate: Date,
  deliveryDays: Number (required),
  status: "pending" | "submitted" | "viewed" | "shortlisted" | "accepted" | "rejected" | "withdrawn" | "expired",
  submittedAt: Date,
  viewedAt: Date,
  rejectionReason: String,
  gigId: ObjectId,
  attachments: [{ name, url, publicId }],
  termsAccepted: Boolean,
  termsAcceptedAt: Date,
  createdAt: Date,
  updatedAt: Date
}
```

### 4. Milestone Model
```javascript
{
  _id: ObjectId,
  milestoneNumber: String (unique, e.g., "MSN-XXXXXXXXX-00001"),
  orderId: ObjectId (ref: Order),
  projectId: ObjectId (ref: Project),
  buyerId: ObjectId (ref: User),
  sellerId: ObjectId (ref: User),
  title: String (required, max: 200),
  description: String (max: 2000),
  amount: Number (required, min: 0),
  dueDate: Date (required),
  status: "pending" | "funded" | "in_progress" | "submitted" | "revision_requested" | "completed" | "cancelled" | "disputed",
  paymentStatus: "unpaid" | "paid" | "released" | "refunded" | "disputed",
  escrowTxId: ObjectId,
  releaseTxId: ObjectId,
  submission: { url, description, files: [{ name, url, publicId }], submittedAt },
  revisionRequests: [{ reason, requestedAt, resolved }],
  revisionsUsed: Number,
  revisionsAllowed: Number,
  completedAt: Date,
  cancelReason: String,
  cancelledBy: ObjectId,
  createdAt: Date,
  updatedAt: Date
}
```

### 5. Review Model
```javascript
{
  _id: ObjectId,
  reviewNumber: String (unique, e.g., "REV-XXXXXXXXX-00001"),
  orderId: ObjectId (ref: Order),
  gigId: ObjectId (ref: Gig),
  reviewerId: ObjectId (ref: User),
  reviewerRole: "buyer" | "seller",
  revieweeId: ObjectId (ref: User),
  revieweeRole: "buyer" | "seller",
  overallRating: Number (required, 1-5),
  ratingBreakdown: { communication, quality, professionalism, timeliness },
  comment: String (max: 2000),
  tags: [String],
  wouldRecommend: Boolean,
  isPublic: Boolean,
  status: "pending" | "published" | "flagged" | "removed",
  flagReason: String,
  removedAt: Date,
  response: { content, respondedAt },
  createdAt: Date,
  updatedAt: Date
}
```

### 6. Transaction Model
```javascript
{
  _id: ObjectId,
  transactionNumber: String (unique, e.g., "TXN-XXXXXXXXX-00001"),
  userId: ObjectId (ref: User),
  type: "deposit" | "withdrawal" | "escrow_funded" | "escrow_released" | "escrow_refunded" | "payment" | "refund" | "platform_fee" | "earning" | "withdrawal_fee",
  amount: Number (required),
  currency: String (default: "USD"),
  cryptoAmount: Number,
  cryptoCurrency: String,
  status: "pending" | "processing" | "completed" | "failed" | "cancelled",
  orderId: ObjectId,
  milestoneId: ObjectId,
  projectId: ObjectId,
  paymentMethod: "card" | "bank_transfer" | "crypto" | "wallet",
  blockchain: String,
  txHash: String,
  fromAddress: String,
  toAddress: String,
  isEscrow: Boolean,
  escrowStatus: "held" | "released" | "refunded" | "disputed",
  balanceAfter: Number,
  fee: Number,
  feePercentage: Number,
  description: String,
  metadata: Mixed,
  externalRef: String,
  completedAt: Date,
  failureReason: String,
  createdAt: Date,
  updatedAt: Date
}
```

### 7. Notification Model
```javascript
{
  _id: ObjectId,
  userId: ObjectId (ref: User),
  type: "order_created" | "order_started" | "order_submitted" | ... | "system",
  priority: "low" | "normal" | "high" | "urgent",
  title: String (required, max: 200),
  message: String (required, max: 1000),
  actionUrl: String,
  relatedEntity: { type, id },
  data: Mixed,
  isRead: Boolean,
  readAt: Date,
  isDismissed: Boolean,
  dismissedAt: Date,
  emailSent: Boolean,
  emailSentAt: Date,
  pushSent: Boolean,
  pushSentAt: Date,
  createdAt: Date,
  updatedAt: Date
}
```

### 8. Activity Model
```javascript
{
  _id: ObjectId,
  userId: ObjectId (ref: User),
  type: "user_registered" | "order_created" | "payment_received" | ...,
  priority: "low" | "normal" | "high",
  description: String (required, max: 500),
  shortDescription: String (max: 100),
  relatedEntity: { type, id, name },
  metadata: Mixed,
  ipAddress: String,
  userAgent: String,
  isVisible: Boolean,
  isImportant: Boolean,
  category: "account" | "gig" | "order" | "project" | "proposal" | "payment" | "review" | "system",
  createdAt: Date,
  updatedAt: Date
}
```

---

# API Endpoints

## SELLER DASHBOARD

### 1. GET /dashboard/seller/stats
**Description:** Get seller statistics for dashboard

**Auth Required:** Yes

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| - | - | - | No parameters |

**Response (200):**
```json
{
  "success": true,
  "data": {
    "activeOrders": 12,
    "completedOrdersThisMonth": 8,
    "monthlyEarnings": 4820,
    "totalEarnings": 24500,
    "gigsCount": 5,
    "gigViews": 3492,
    "profileStrength": 85,
    "walletBalance": 2450.00,
    "responseTime": 2,
    "deliveryRate": 95,
    "averageRating": 4.8,
    "totalReviews": 42
  }
}
```

**Error Response (500):**
```json
{
  "success": false,
  "message": "Failed to fetch seller stats"
}
```

---

### 2. GET /dashboard/seller/orders
**Description:** Get seller's active orders

**Auth Required:** Yes

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| status | string | all active | Filter by order status |
| limit | number | 10 | Number of results |
| page | number | 1 | Page number |

**Status Values:** `pending`, `active`, `in_progress`, `review`, `completed`, `cancelled`, `disputed`

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "_id": "order_id",
      "orderNumber": "ORD-XXXXXXXXX-00001",
      "buyerId": {
        "_id": "buyer_id",
        "fullName": "John Doe",
        "username": "johndoe",
        "profileImage": { "url": "https://..." }
      },
      "gigId": { "_id": "gig_id", "title": "Web Design", "images": [] },
      "packageType": "standard",
      "status": "in_progress",
      "dueDate": "2024-12-01T00:00:00.000Z",
      "amount": 500,
      "sellerEarnings": 425,
      "isLate": false,
      "createdAt": "2024-11-15T00:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 25,
    "pages": 3
  }
}
```

---

### 3. GET /dashboard/seller/gigs
**Description:** Get seller's gigs with performance data

**Auth Required:** Yes

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| limit | number | 10 | Number of results |
| page | number | 1 | Page number |

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "_id": "gig_id",
      "title": "Web Design Service",
      "description": "I will design...",
      "category": "Web Design",
      "pricing": { "basic": 100, "standard": 200, "premium": 350 },
      "deliveryTime": 7,
      "images": [],
      "views": 342,
      "orders": 12,
      "conversionRate": 4,
      "createdAt": "2024-01-01T00:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 5,
    "pages": 1
  }
}
```

---

### 4. GET /dashboard/seller/earnings
**Description:** Get seller's earnings data for chart

**Auth Required:** Yes

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| period | string | 30d | Time period: 7d, 30d, 90d, 1y |

**Response (200):**
```json
{
  "success": true,
  "data": {
    "chart": [
      { "date": "2024-11-01", "amount": 150 },
      { "date": "2024-11-02", "amount": 0 },
      { "date": "2024-11-03", "amount": 300 },
      { "date": "2024-11-04", "amount": 200 },
      { "date": "2024-11-05", "amount": 0 }
    ],
    "summary": {
      "totalEarnings": 650,
      "avgDaily": 130,
      "periodDays": 5
    }
  }
}
```

---

### 5. GET /dashboard/seller/reviews
**Description:** Get seller's reviews

**Auth Required:** Yes

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| limit | number | 10 | Number of results |
| page | number | 1 | Page number |

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "_id": "review_id",
      "reviewNumber": "REV-XXXXXXXXX-00001",
      "reviewerId": {
        "_id": "buyer_id",
        "fullName": "Jane Smith",
        "username": "janesmith",
        "profileImage": { "url": "https://..." }
      },
      "overallRating": 5,
      "ratingBreakdown": {
        "communication": 5,
        "quality": 5,
        "professionalism": 4,
        "timeliness": 5
      },
      "comment": "Great work! Very professional and timely.",
      "wouldRecommend": true,
      "status": "published",
      "createdAt": "2024-11-10T00:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 42,
    "pages": 5
  }
}
```

---

## BUYER DASHBOARD

### 6. GET /dashboard/buyer/stats
**Description:** Get buyer statistics for dashboard

**Auth Required:** Yes

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| - | - | - | No parameters |

**Response (200):**
```json
{
  "success": true,
  "data": {
    "activeProjects": 12,
    "activeOrders": 5,
    "openProposals": 45,
    "hiredFreelancers": 8,
    "monthlySpending": 2450,
    "totalSpending": 24500,
    "walletBalance": 5000,
    "unreadNotifications": 3,
    "profileCompletion": 80
  }
}
```

---

### 7. GET /dashboard/buyer/projects
**Description:** Get buyer's projects

**Auth Required:** Yes

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| status | string | all | Filter by project status |
| limit | number | 10 | Number of results |
| page | number | 1 | Page number |

**Status Values:** `draft`, `open`, `in_progress`, `completed`, `cancelled`, `paused`

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "_id": "project_id",
      "projectNumber": "PRJ-XXXXXXXXX-00001",
      "title": "E-commerce Website",
      "description": "Build a full e-commerce website",
      "category": "Web Development",
      "skills": ["React", "Node.js", "MongoDB"],
      "experienceLevel": "expert",
      "budget": { "min": 1000, "max": 5000, "currency": "USD" },
      "status": "open",
      "proposalCount": 15,
      "createdAt": "2024-11-01T00:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 12,
    "pages": 2
  }
}
```

---

### 8. GET /dashboard/buyer/orders
**Description:** Get buyer's orders

**Auth Required:** Yes

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| status | string | all active | Filter by order status |
| limit | number | 10 | Number of results |
| page | number | 1 | Page number |

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "_id": "order_id",
      "orderNumber": "ORD-XXXXXXXXX-00001",
      "sellerId": {
        "_id": "seller_id",
        "fullName": "Alex Developer",
        "username": "alexdev",
        "profileImage": { "url": "https://..." },
        "sellerProfile": { "skills": ["React", "Node.js"] }
      },
      "gigId": { "_id": "gig_id", "title": "Full Stack Developer" },
      "packageType": "premium",
      "status": "in_progress",
      "dueDate": "2024-12-15T00:00:00.000Z",
      "amount": 1500,
      "createdAt": "2024-11-01T00:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 5,
    "pages": 1
  }
}
```

---

### 9. GET /dashboard/buyer/proposals
**Description:** Get proposals for buyer's projects

**Auth Required:** Yes

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| status | string | all | Filter by proposal status |
| limit | number | 10 | Number of results |
| page | number | 1 | Page number |

**Status Values:** `pending`, `submitted`, `viewed`, `shortlisted`, `accepted`, `rejected`, `withdrawn`

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "_id": "proposal_id",
      "proposalNumber": "PRP-XXXXXXXXX-00001",
      "projectId": {
        "_id": "project_id",
        "title": "E-commerce Website",
        "budget": { "min": 1000, "max": 5000 }
      },
      "sellerId": {
        "_id": "seller_id",
        "fullName": "John Developer",
        "username": "johndev",
        "profileImage": { "url": "https://..." },
        "sellerProfile": { "skills": ["React", "Node.js"], "bio": "Full stack dev" }
      },
      "coverLetter": "I am interested in this project...",
      "bidAmount": 3500,
      "estimatedDuration": "4 weeks",
      "deliveryDays": 30,
      "status": "submitted",
      "submittedAt": "2024-11-10T00:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 45,
    "pages": 5
  }
}
```

---

### 10. GET /dashboard/buyer/talent
**Description:** Get recommended talent for buyer

**Auth Required:** Yes

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| limit | number | 10 | Number of results |

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "_id": "seller_id",
      "name": "Sarah Developer",
      "username": "sarahdev",
      "avatar": "https://...",
      "headline": "Full stack web developer with 5+ years experience",
      "skills": ["React", "Node.js", "Python", "AWS"],
      "rating": 4.9,
      "reviewCount": 42,
      "completedProjects": 35,
      "hourlyRate": 75
    }
  ]
}
```

---

## SHARED APIs

### 11. GET /dashboard/recent-activity
**Description:** Get recent activity for user

**Auth Required:** Yes

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| limit | number | 20 | Number of results |
| category | string | all | Filter by category |

**Category Values:** `account`, `gig`, `order`, `project`, `proposal`, `payment`, `review`, `system`

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "_id": "activity_id",
      "type": "order_completed",
      "description": "Order #ORD-XXXXXXXXX-00001 completed by John Doe",
      "shortDescription": "Order completed",
      "category": "order",
      "isImportant": true,
      "createdAt": "2024-11-15T10:30:00.000Z"
    }
  ]
}
```

---

### 12. GET /dashboard/notifications
**Description:** Get user notifications

**Auth Required:** Yes

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| unreadOnly | boolean | false | Show only unread |
| limit | number | 20 | Number of results |
| page | number | 1 | Page number |

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "_id": "notification_id",
      "type": "order_submitted",
      "priority": "high",
      "title": "Order Submitted",
      "message": "Your order #123 has been submitted for review",
      "actionUrl": "/dashboard/orders/123",
      "relatedEntity": { "type": "order", "id": "order_id" },
      "isRead": false,
      "createdAt": "2024-11-15T10:00:00.000Z"
    }
  ],
  "unreadCount": 3,
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 15,
    "pages": 1
  }
}
```

---

### 13. PATCH /dashboard/notifications/:id/read
**Description:** Mark notification as read

**Auth Required:** Yes

**URL Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| id | string | Notification ID |

**Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "notification_id",
    "isRead": true,
    "readAt": "2024-11-15T11:00:00.000Z"
  }
}
```

**Error Response (404):**
```json
{
  "success": false,
  "message": "Notification not found"
}
```

---

### 14. PATCH /dashboard/notifications/read-all
**Description:** Mark all notifications as read

**Auth Required:** Yes

**Response (200):**
```json
{
  "success": true,
  "message": "All notifications marked as read"
}
```

---

### 15. GET /dashboard/wallet
**Description:** Get wallet info

**Auth Required:** Yes

**Query Parameters:** None

**Response (200):**
```json
{
  "success": true,
  "data": {
    "balance": 5000,
    "recentTransactions": [
      {
        "_id": "txn_id",
        "type": "escrow_released",
        "amount": 450,
        "status": "completed",
        "description": "Payment for Order #123",
        "completedAt": "2024-11-14T10:00:00.000Z"
      }
    ],
    "totals": {
      "deposit": 10000,
      "earning": 5000,
      "escrow_released": 5000
    }
  }
}
```

---

# Edge Cases & Error Handling

## Common Error Responses

### 401 Unauthorized
```json
{
  "success": false,
  "message": "Not authorized to access this route"
}
```

### 403 Forbidden
```json
{
  "success": false,
  "message": "You do not have permission to perform this action"
}
```

### 404 Not Found
```json
{
  "success": false,
  "message": "Resource not found"
}
```

### 500 Internal Server Error
```json
{
  "success": false,
  "message": "Server error - please try again later"
}
```

## Edge Cases to Handle

### 1. Empty Data
- **Scenario:** User has no orders/gigs/projects
- **Response:** Return empty array with pagination info
```json
{
  "success": true,
  "data": [],
  "pagination": { "page": 1, "limit": 10, "total": 0, "pages": 0 }
}
```

### 2. Invalid Status Filter
- **Scenario:** Invalid status value passed
- **Response:** Return 400 error
```json
{
  "success": false,
  "message": "Invalid status value. Valid values: pending, active, in_progress, review, completed, cancelled, disputed"
}
```

### 3. Missing Authentication
- **Scenario:** No token provided
- **Response:** Return 401 error
```json
{
  "success": false,
  "message": "Please provide authentication token"
}
```

### 4. Expired Token
- **Scenario:** Token expired
- **Response:** Return 401 error
```json
{
  "success": false,
  "message": "Token expired, please login again"
}
```

### 5. User Role Mismatch
- **Scenario:** Buyer accessing seller endpoints or vice versa
- **Response:** Return 403 error
```json
{
  "success": false,
  "message": "This endpoint is only available for sellers"
}
```

### 6. Pagination Overflow
- **Scenario:** Page number exceeds available pages
- **Response:** Return empty data
```json
{
  "success": true,
  "data": [],
  "pagination": { "page": 100, "limit": 10, "total": 50, "pages": 5 }
}
```

### 7. Invalid Date Range
- **Scenario:** Invalid period parameter
- **Response:** Default to 30d
```json
{
  "success": true,
  "data": { "chart": [], "summary": { "totalEarnings": 0 } }
}
```

---

# Testing with Postman/cURL

## Authentication Setup
1. First, login to get a token:
```bash
curl -X POST http://localhost:7980/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com", "password": "password123"}'
```

2. Use the token for subsequent requests:
```bash
curl -X GET http://localhost:7980/dashboard/seller/stats \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

## Test Scenarios

### Test 1: Get Seller Stats
```bash
curl -X GET http://localhost:7980/dashboard/seller/stats \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Test 2: Get Seller Orders (filtered)
```bash
curl -X GET "http://localhost:7980/dashboard/seller/orders?status=in_progress&limit=5" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Test 3: Get Buyer Stats
```bash
curl -X GET http://localhost:7980/dashboard/buyer/stats \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Test 4: Get Recommended Talent
```bash
curl -X GET "http://localhost:7980/dashboard/buyer/talent?limit=5" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Test 5: Get Notifications
```bash
curl -X GET "http://localhost:7980/dashboard/notifications?unreadOnly=true" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Test 6: Mark Notification Read
```bash
curl -X PATCH http://localhost:7980/dashboard/notifications/NOTIFICATION_ID/read \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Test 7: Get Wallet Info
```bash
curl -X GET http://localhost:7980/dashboard/wallet \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

# Implementation Notes

## Indexes Created (Performance)
```javascript
// Order indexes
orderSchema.index({ buyerId: 1, status: 1 });
orderSchema.index({ sellerId: 1, status: 1 });
orderSchema.index({ gigId: 1 });
orderSchema.index({ orderNumber: 1 });

// Project indexes
projectSchema.index({ buyerId: 1, status: 1 });
projectSchema.index({ status: 1, visibility: 1 });

// Proposal indexes
proposalSchema.index({ projectId: 1, sellerId: 1 }, { unique: true });

// Milestone indexes
milestoneSchema.index({ orderId: 1 });

// Review indexes
reviewSchema.index({ orderId: 1 }, { unique: true });
reviewSchema.index({ revieweeId: 1, status: 1 });

// Transaction indexes
transactionSchema.index({ userId: 1, status: 1 });
transactionSchema.index({ orderId: 1 });
transactionSchema.index({ txHash: 1 });

// Notification indexes
notificationSchema.index({ userId: 1, isRead: 1 });

// Activity indexes
activitySchema.index({ userId: 1, createdAt: -1 });
activitySchema.index({ createdAt: -1 }); // TTL: auto-delete after 90 days
```

## Environment Variables Required
```
MONGODB_URI=your_mongodb_connection_string
JWT_SECRET=your_jwt_secret_key
JWT_EXPIRE=30d
PORT=7980
```

## Dependencies Added
- mongoose (already in use)
- All models use existing MongoDB connection
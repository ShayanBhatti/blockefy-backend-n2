# Gig Draft API Implementation Guide

This document describes the API payloads and expected responses for the Gig Draft functionality. Use this guide when integrating with the frontend.

---

## Table of Contents

1. [Gig Status](#gig-status)
2. [Create Gig (Draft or Posted)](#create-gig-draft-or-posted)
3. [Save/Update Draft Gig](#saveupdate-draft-gig)
4. [Publish Draft Gig](#publish-draft-gig)
5. [Unpublish Posted Gig](#unpublish-posted-gig)
6. [Update Gig](#update-gig)
7. [Delete Gig](#delete-gig)
8. [Get My Gigs](#get-my-gigs)
9. [Get Draft Gigs Only](#get-draft-gigs-only)
10. [Get Posted Gigs Only](#get-posted-gigs-only)
11. [Error Responses](#error-responses)
12. [Frontend UI Recommendations](#frontend-ui-recommendations)

---

## Gig Status

Every gig has a `status` field with two possible values:

| Status | Description | Visible to Buyers |
|--------|-------------|------------------|
| `draft` | Saved as draft, not visible to buyers | No |
| `posted` | Published and visible to buyers | Yes |

---

## Create Gig (Draft or Posted)

Create a new gig either as a draft or post directly.

### Endpoint

```
POST /api/gigs/create
```

### Headers

```
Authorization: Bearer <token>
```

### Payload

```javascript
{
  // Required for POST (not required for DRAFT)
  title: "I will design a professional logo",        // Required to post
  description: "I will create a unique logo...",    // Required to post
  category: "Logo Design",                           // Required to post
  pricing: {
    basic: 50,           // Required to post (basic pricing)
    standard: 100,       // Optional
    premium: 200         // Optional
  },

  // Optional for both
  tags: ["logo", "branding", "design"],
  deliveryTime: 3,       // in days
  gigImage: "base64string or url",

  // KEY FLAG
  saveAsDraft: true     // true = save as draft, false/undefined = post directly
}
```

### Response (Success - Draft)

```javascript
{
  "message": "Gig saved as draft",
  "gig": {
    "_id": "gig_id_here",
    "userId": "user_id_here",
    "title": null,
    "description": null,
    "category": null,
    "tags": [],
    "pricing": {},
    "deliveryTime": null,
    "gigImage": null,
    "status": "draft",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  }
}
```

### Response (Success - Posted)

```javascript
{
  "message": "Gig posted successfully",
  "gig": {
    "_id": "gig_id_here",
    "userId": "user_id_here",
    "title": "I will design a professional logo",
    "description": "I will create a unique logo...",
    "category": "Logo Design",
    "tags": ["logo", "branding", "design"],
    "pricing": {
      "basic": 50,
      "standard": 100,
      "premium": 200
    },
    "deliveryTime": 3,
    "gigImage": "base64string",
    "status": "posted",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  }
}
```

---

## Save/Update Draft Gig

Create a new draft or update an existing one with partial data.

### Endpoint

```
POST /api/gigs/draft
```

### Headers

```
Authorization: Bearer <token>
```

### Payload (New Draft)

```javascript
{
  // All fields optional for drafts
  title: "Partial title...",
  description: "Partial description...",
  category: "Web Development",
  tags: ["react", "node"],
  pricing: { basic: 50 },
  deliveryTime: 5,
  gigImage: "base64string"
}
```

### Payload (Update Existing Draft)

```javascript
{
  gigId: "existing_gig_id",   // Required to update existing draft
  title: "Updated title",
  description: "Updated description",
  // other fields...
}
```

### Response

```javascript
{
  "message": "Draft saved successfully",
  "gig": {
    "_id": "gig_id_here",
    "status": "draft",
    "title": "Updated title",
    // ...other fields
  }
}
```

---

## Publish Draft Gig

Convert a draft gig to posted. Validates that all required fields are present.

### Endpoint

```
PUT /api/gigs/:gigId/publish
```

### Headers

```
Authorization: Bearer <token>
```

### URL Parameters

```
gigId: The ID of the draft gig to publish
```

### Payload

```javascript
// No payload required - gigId is in URL
```

### Response (Success)

```javascript
{
  "message": "Gig published successfully",
  "gig": {
    "_id": "gig_id_here",
    "status": "posted",
    "title": "I will design a professional logo",
    // ...full gig object
  }
}
```

### Response (Validation Failed)

```javascript
{
  "error": "Cannot publish - missing required fields",
  "details": [
    "Title is required",
    "Description is required",
    "Category is required",
    "Basic pricing is required"
  ],
  "gig": {
    // Returns the gig so frontend knows what fields are missing
  }
}
```

---

## Unpublish Posted Gig

Convert a posted gig back to draft (visibility hidden from buyers).

### Endpoint

```
PUT /api/gigs/:gigId/unpublish
```

### Headers

```
Authorization: Bearer <token>
```

### URL Parameters

```
gigId: The ID of the posted gig to unpublish
```

### Response

```javascript
{
  "message": "Gig unpublished - saved as draft",
  "gig": {
    "_id": "gig_id_here",
    "status": "draft",
    // ...gig object
  }
}
```

---

## Update Gig

Update an existing gig (either draft or posted).

### Endpoint

```
PUT /api/gigs/:gigId
```

### Headers

```
Authorization: Bearer <token>
```

### URL Parameters

```
gigId: The ID of the gig to update
```

### Payload

```javascript
{
  title: "Updated title",
  description: "Updated description",
  category: "Updated category",
  tags: ["new", "tags"],
  pricing: { basic: 75, standard: 150 },
  deliveryTime: 7,
  gigImage: "new_base64string",

  // Optional flag to save as draft instead of posting
  saveAsDraft: true
}
```

### Response

```javascript
{
  "message": "Gig updated successfully",
  // OR if saveAsDraft: true
  "message": "Gig saved as draft",
  "gig": {
    // Updated gig object
  }
}
```

---

## Delete Gig

Delete a gig (works for both draft and posted).

### Endpoint

```
DELETE /api/gigs/:gigId
```

### Headers

```
Authorization: Bearer <token>
```

### URL Parameters

```
gigId: The ID of the gig to delete
```

### Response

```javascript
{
  "message": "Gig deleted successfully"
}
```

---

## Get My Gigs

Get all gigs for the logged-in user (both drafts and posted).

### Endpoint

```
GET /api/gigs/my-gigs
```

### Headers

```
Authorization: Bearer <token>
```

### Response

```javascript
{
  "message": "Gigs retrieved successfully",
  "totalGigs": 10,
  "gigs": [
    {
      "_id": "gig_id",
      "status": "posted",
      "title": "Gig 1",
      // ...full gig object
    },
    {
      "_id": "gig_id",
      "status": "draft",
      "title": "Draft Gig",
      // ...full gig object
    }
  ]
}
```

---

## Get Draft Gigs Only

Get only draft gigs for the logged-in user.

### Endpoint

```
GET /api/gigs/my-gigs/drafts
```

### Headers

```
Authorization: Bearer <token>
```

### Response

```javascript
{
  "message": "Draft gigs retrieved successfully",
  "totalDrafts": 3,
  "gigs": [
    // Array of draft gigs only
  ]
}
```

---

## Get Posted Gigs Only

Get only posted gigs for the logged-in user.

### Endpoint

```
GET /api/gigs/my-gigs/posted
```

### Headers

```
Authorization: Bearer <token>
```

### Response

```javascript
{
  "message": "Posted gigs retrieved successfully",
  "totalPosted": 7,
  "gigs": [
    // Array of posted gigs only
  ]
}
```

---

## Error Responses

### 400 - Validation Failed

```javascript
{
  "error": "Validation failed",
  "details": [
    "Title is required",
    "Description is required"
  ]
}
```

### 403 - Not a Seller

```javascript
{
  "error": "Only sellers can create gigs",
  "role": "buyer"
}
```

### 403 - Profile Incomplete

```javascript
{
  "error": "Complete your seller profile (Step 4) before posting gigs",
  "currentStep": 2,
  "requiredStep": 4
}
```

### 404 - Gig Not Found

```javascript
{
  "error": "Gig not found"
}
```

### 404 - Draft Not Found (for publish)

```javascript
{
  "error": "Draft gig not found or already published"
}
```

---

## Frontend UI Recommendations

### 1. Gig Creation Flow

1. **Initial State**: Show empty form with all fields optional
2. **Save as Draft Button**: Calls `POST /create` with `saveAsDraft: true`
3. **Post Gig Button**: Calls `POST /create` with `saveAsDraft: false` or omitted

### 2. Draft Management

- Display drafts in a separate section/tab labeled "Drafts"
- Show draft indicator icon next to draft gigs
- Allow inline editing of drafts

### 3. Publish Flow

1. User clicks "Publish" on a draft
2. Call `PUT /:gigId/publish`
3. If error with details, highlight missing fields
4. If success, move gig to "Posted" section

### 4. Unpublish Flow (Optional)

- Allow users to unpublish a gig (revert to draft)
- Show confirmation dialog before unpublishing
- Call `PUT /:gigId/unpublish`

### 5. Visual Status Indicators

```javascript
// Display status in UI
const statusLabels = {
  draft: { label: "Draft", color: "#gray" },
  posted: { label: "Active", color: "#green" }
};
```

### 6. Browse Gigs (Public)

- Only fetch gigs with `status: "posted"` for public browse
- The browse endpoint (`GET /api/gigs/browse/all`) automatically filters to posted only

---

## Summary of Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/gigs/create` | Create gig (draft or posted) |
| POST | `/gigs/draft` | Save/update draft |
| PUT | `/gigs/:gigId` | Update gig |
| DELETE | `/gigs/:gigId` | Delete gig |
| PUT | `/gigs/:gigId/publish` | Publish draft |
| PUT | `/gigs/:gigId/unpublish` | Unpublish posted |
| GET | `/gigs/my-gigs` | Get all user's gigs |
| GET | `/gigs/my-gigs/drafts` | Get only drafts |
| GET | `/gigs/my-gigs/posted` | Get only posted |
| GET | `/gigs/browse/all` | Get all posted (public) |
| GET | `/gigs/:gigId` | Get single gig details |
# Blockefy Backend

## Setup

```bash
npm install
```

Copy `.env.example` to `.env` and configure MongoDB, JWT, and LiveKit:

```env
MONGODB_URI=
JWT_SECRET=
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
LIVEKIT_URL=wss://your-project.livekit.cloud
FRONTEND_URL=http://localhost:5173
```

Create a LiveKit Cloud project, obtain the API key, API secret, and project
WebSocket URL, then place them in the backend environment. The API secret is
server-only and is never returned to the frontend.

## Run

```bash
npm run dev
```

The default server is `http://localhost:7980`. The communication API is under
`/api/conversations` and `/api/calls`; the signed LiveKit webhook is
`POST /api/webhooks/livekit`.

## Communication test

1. Start the backend and frontend.
2. Log in as User A and User B in separate browsers.
3. Open a profile, send messages, and start a voice/video call.
4. Accept, reject, cancel, and end calls from the two browsers.
5. Refresh or log back in and verify messages and `/calls` history persist.

## Verification

```bash
npm test
npm run lint
```

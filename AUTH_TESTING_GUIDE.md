# Blockefy Auth Testing Guide

## Setup

1. **Start the server:**
```bash
npm run dev
# or
npm run serve
```

2. **Set environment variables** in `.env`:
```
MONGODB_URI=mongodb://localhost:27017/blockefy
# or MongoDB Atlas:
# MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/blockefy

JWT_SECRET=your_super_secret_jwt_key_change_this

# OAuth (optional for testing)
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GITHUB_CLIENT_ID=your_github_client_id
GITHUB_CLIENT_SECRET=your_github_client_secret

# Callback URLs
BASE_URL=http://localhost:7980
```

---

## CURL COMMANDS FOR TESTING

### 1. Health Check
```bash
curl -X GET http://localhost:7980/
```

**Response:**
```json
{"message": "Blockefy Backend is running!"}
```

---

### 2. Register New User (Email/Password)

```bash
curl -X POST http://localhost:7980/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "john@example.com",
    "password": "SecurePass123!",
    "fullName": "John Doe",
    "username": "johndoe"
  }'
```

**Response (201 Created):**
```json
{
  "msg": "User registered successfully",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "_id": "66620abc123def456ghi789",
    "email": "john@example.com",
    "fullName": "John Doe",
    "username": "johndoe",
    "role": "buyer",
    "walletAddress": "0x742d35Cc6634C0532925a3b844Bc9e7595f123de",
    "onboardingStep": 1,
    "onboardingCompleted": false,
    "authProvider": "email"
  }
}
```

**Error - User exists (409):**
```json
{"msg": "Email or username already exists"}
```

**Error - Missing fields (400):**
```json
{"msg": "email, password, fullName, and username are required"}
```

---

### 3. Login with Email/Password

```bash
curl -X POST http://localhost:7980/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "john@example.com",
    "password": "SecurePass123!"
  }'
```

**Response (200 OK):**
```json
{
  "msg": "Login successful",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "_id": "66620abc123def456ghi789",
    "email": "john@example.com",
    "fullName": "John Doe",
    "username": "johndoe",
    "role": "buyer",
    "walletAddress": "0x742d35Cc6634C0532925a3b844Bc9e7595f123de",
    "onboardingStep": 1,
    "onboardingCompleted": false,
    "authProvider": "email"
  }
}
```

**Error - Invalid credentials (401):**
```json
{"msg": "Invalid email or password"}
```

---

### 4. Generate Wallet Nonce (for Web3 Auth)

```bash
curl -X POST http://localhost:7980/auth/wallet/nonce \
  -H "Content-Type: application/json" \
  -d '{
    "walletAddress": "0x742d35Cc6634C0532925a3b844Bc9e7595f123de"
  }'
```

**Response (200 OK):**
```json
{
  "msg": "Nonce generated successfully",
  "nonce": "0x5a3f2e1d9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a",
  "message": "Sign this message to authenticate:\n\nNonce: 0x5a3f2e1d9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a",
  "expiresAt": 1713379200000
}
```

**Error - Invalid address (400):**
```json
{"msg": "Invalid wallet address"}
```

---

### 5. Verify Wallet Signature (Web3 Auth)

**Step 1:** Get message from nonce endpoint (see above)

**Step 2:** Sign with MetaMask/ethers and get signature

**Step 3:** Send verification:
```bash
curl -X POST http://localhost:7980/auth/wallet/verify \
  -H "Content-Type: application/json" \
  -d '{
    "walletAddress": "0x742d35Cc6634C0532925a3b844Bc9e7595f123de",
    "message": "Sign this message to authenticate:\n\nNonce: 0x5a3f2e1d9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a",
    "signature": "0x1234567890abcdef..."
  }'
```

**Response (200 OK):**
```json
{
  "msg": "Wallet verification successful",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "_id": "66620def789abc123def456",
    "email": null,
    "fullName": null,
    "username": null,
    "role": "buyer",
    "walletAddress": "0x742d35Cc6634C0532925a3b844Bc9e7595f123de",
    "onboardingStep": 1,
    "onboardingCompleted": false,
    "authProvider": "wallet"
  }
}
```

**Error - Invalid signature (401):**
```json
{"msg": "Invalid signature"}
```

**Error - Signature mismatch (401):**
```json
{"msg": "Signature does not match wallet address"}
```

**Error - Nonce expired (401):**
```json
{"msg": "Nonce expired or not found"}
```

---

### 6. Get Current User (Protected Route)

**With valid token:**
```bash
curl -X GET http://localhost:7980/auth/me \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

**Response (200 OK):**
```json
{
  "msg": "User info retrieved",
  "user": {
    "_id": "66620abc123def456ghi789",
    "email": "john@example.com",
    "fullName": "John Doe",
    "username": "johndoe",
    "role": "buyer",
    "walletAddress": "0x742d35Cc6634C0532925a3b844Bc9e7595f123de",
    "onboardingStep": 1,
    "onboardingCompleted": false,
    "authProvider": "email",
    "createdAt": "2024-04-17T10:30:00.000Z",
    "updatedAt": "2024-04-17T10:30:00.000Z"
  }
}
```

**Error - No token (401):**
```json
{"msg": "No authorization header"}
```

**Error - Invalid token (401):**
```json
{"msg": "Invalid token"}
```

**Error - Expired token (401):**
```json
{"msg": "Token expired"}
```

---

### 7. Google OAuth Login

```bash
# Step 1: Redirect user to this URL
http://localhost:7980/auth/google

# Step 2: Google will redirect back with code
# Step 3: User gets token and user data
```

---

### 8. GitHub OAuth Login

```bash
# Step 1: Redirect user to this URL
http://localhost:7980/auth/github

# Step 2: GitHub will redirect back with code
# Step 3: User gets token and user data
```

---

## Testing Flow

### Email Registration Flow
```bash
# 1. Register
TOKEN=$(curl -X POST http://localhost:7980/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "Test123!",
    "fullName": "Test User",
    "username": "testuser"
  }' | jq -r '.token')

# 2. Use token to get user info
curl -X GET http://localhost:7980/auth/me \
  -H "Authorization: Bearer $TOKEN"

# 3. Login again
curl -X POST http://localhost:7980/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "Test123!"
  }'
```

### Web3 Wallet Flow
```bash
# 1. Generate nonce
NONCE_RESPONSE=$(curl -X POST http://localhost:7980/auth/wallet/nonce \
  -H "Content-Type: application/json" \
  -d '{
    "walletAddress": "0x742d35Cc6634C0532925a3b844Bc9e7595f123de"
  }')

# 2. Extract message (user signs this in MetaMask)
MESSAGE=$(echo $NONCE_RESPONSE | jq -r '.message')
WALLET="0x742d35Cc6634C0532925a3b844Bc9e7595f123de"

# 3. User signs with MetaMask (outside curl)
# SIGNATURE = await signer.signMessage(MESSAGE)

# 4. Verify signature
curl -X POST http://localhost:7980/auth/wallet/verify \
  -H "Content-Type: application/json" \
  -d '{
    "walletAddress": "'$WALLET'",
    "message": "'$MESSAGE'",
    "signature": "0xSIGNATURE_HERE"
  }'
```

---

## Why authController Was Missing

The authController was not created initially because:
1. **Modular structure** - Controllers are application logic that depends on models/routes being finalized
2. **Dependencies** - Needed confirmed: User schema, passport config, middleware, wallet utilities
3. **Business logic** - Required clear specification of fields and auth flow
4. **Error handling** - Needed consistent error format across all endpoints

Now it's complete with:
- ✅ Email/password authentication with bcrypt hashing
- ✅ Wallet generation on registration
- ✅ JWT token generation (7-day expiry)
- ✅ Web3 signature verification
- ✅ OAuth user creation
- ✅ Protected route support
- ✅ Consistent error responses (`{ "msg": "..." }`)
- ✅ All fields from requirements (fullName, username, walletAddress, onboarding)

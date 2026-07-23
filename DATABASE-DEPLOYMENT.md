# PostgreSQL Permit Database Deployment

## What this release adds

- PostgreSQL as the source of truth for vehicles and current permits.
- Editable permit dates, permit numbers, operators, callsigns and notes.
- Immutable audit logs for every create/update action.
- Full HTTP/system logs with request IDs, status codes and response durations.
- Automatic email alerts at 30, 14, 7, 1 and 0 days before expiry.
- Notification delivery history and failure logging.
- API keys with `permit:read` and `permit:write` scopes.
- Public limited lookup and private authenticated API endpoints.
- Automatic one-time migration of the existing JSON register when the database is empty.
- JSON fallback if `DATABASE_REQUIRED=false` and PostgreSQL is unavailable.

## Local PostgreSQL test

```bash
docker compose -f docker-compose.local.yml up -d
```

Add to `.env`:

```env
DATABASE_URL=postgresql://permit_manager:permit_manager_local@localhost:5433/permit_manager
DATABASE_SSL=false
DATABASE_REQUIRED=true
PUBLIC_URL=http://localhost:4000
PERMIT_ALERT_EMAIL=office@needacab247.com
PERMIT_ALERT_DAYS=30,14,7,1,0
PERMIT_ALERT_HOUR=8
PERMIT_ALERT_TIMEZONE=Europe/London
```

Then:

```bash
npm install
npm start
```

Open `/database` after signing in.

## Coolify

Create a PostgreSQL resource in the same Coolify project. Copy its internal connection string into the application as `DATABASE_URL`. Use `DATABASE_REQUIRED=true` after the first successful database test.

Required application variables:

```env
DATABASE_URL=<Coolify internal PostgreSQL URL>
DATABASE_SSL=false
DATABASE_REQUIRED=true
DATABASE_POOL_MAX=10
PUBLIC_URL=https://your-live-domain
PERMIT_ALERT_EMAIL=office@needacab247.com
PERMIT_ALERT_DAYS=30,14,7,1,0
PERMIT_ALERT_HOUR=8
PERMIT_ALERT_TIMEZONE=Europe/London
```

Keep all existing Autocab, SMTP2GO and Plate Recognizer variables.

## API

Create a key in `/database` → **API Access**.

Private read:

```http
GET /api/v1/permits/SF59JVZ
Authorization: Bearer ppm_xxxxxxxxx
```

Private list:

```http
GET /api/v1/permits?status=due&search=SF59
Authorization: Bearer ppm_xxxxxxxxx
```

Private update with `permit:write`:

```http
PUT /api/v1/permits/SF59JVZ
Authorization: Bearer ppm_xxxxxxxxx
Content-Type: application/json

{"expiresOn":"2027-08-31","permitNumber":"854","plateNumber":"854"}
```

Limited public lookup:

```http
GET /api/public/v1/permits/SF59JVZ
```

## Logs

- **Audit log** records who changed what, before/after JSON, registration, IP, user-agent and request ID.
- **System log** records every HTTP request, response status, duration, path, IP and request ID.
- **Permit notifications** record each alert attempt, recipient, success/failure and error message.

Normal users cannot edit audit records through the application.

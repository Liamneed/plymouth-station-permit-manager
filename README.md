# Plymouth Station Permit Manager

A standalone Node.js application for Plymouth Station Hackney operations.

It combines:

- A public, link-free **Station Rank** screen at `/`
- A public, link-free **mobile permit lookup** at `/permits`
- A password-protected **administration dashboard** at `/dashboard`
- Individual permit creation and renewal
- Printable Plymouth Train Station GWR display permits with driver photographs
- Excel/CSV bulk permit updates
- Current permit, review, completion and audit Excel exports
- Autocab webhook handling and live rank status

## Application routes

| Route | Purpose | Access |
|---|---|---|
| `/` | Station Rank display | Public, no navigation links |
| `/permits` | Mobile permit lookup | Public, no navigation links |
| `/dashboard` | Permit management dashboard | Password protected |
| `/permit-updater` | Bulk spreadsheet tool | Password protected |
| `/healthz` | Hosting health check | Public |

The dashboard contains clearly separated launch cards for the Rank and Permit Lookup screens. The two operational display screens intentionally do not link back to the dashboard.

## Local setup

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env`.
3. Add the Autocab subscription key and a strong dashboard password.
4. Install dependencies:

```bash
npm install
```

5. Start the application:

```bash
npm run dev
```

6. Open:

```text
http://localhost:4000/dashboard
```

## Required environment variables

```env
AUTOCAB_KEY=your_current_autocab_subscription_key
ADMIN_PASSWORD=use_a_long_unique_password
H_CAPABILITY_IDS=14
```

`H_CAPABILITY_IDS` controls which Autocab capability identifies vehicles shown on the rank and permit screens. Multiple IDs can be comma separated.

## Data that must persist in production

The following files and directory hold operational data:

- `status.json`
- `permit-audit.jsonl`
- `gwr-permits.json`
- `permit-photos/`

When hosting on Render, use the included `render.yaml`. It mounts a persistent disk at `/var/data` and points these records there.

## Push as a new GitHub repository

From Terminal, change into the unzipped project folder and run:

```bash
git init
git add .
git commit -m "Initial Plymouth Station permit manager"
git branch -M main
git remote add origin https://github.com/YOUR-GITHUB-USERNAME/plymouth-station-permit-manager.git
git push -u origin main
```

Create the empty repository on GitHub before running the final two commands. Do not initialise it with another README because this project already contains one.

Never commit `.env`. It is excluded by `.gitignore`.

## Render deployment

1. Push the project to GitHub.
2. In Render, create a new Blueprint and select the repository.
3. Render reads `render.yaml` automatically.
4. Enter the secret values for:
   - `AUTOCAB_KEY`
   - `ADMIN_PASSWORD`
5. Deploy.

The included persistent disk requires a paid Render instance. Without persistent storage, photographs, audit records and saved GWR permit details can be lost during a redeploy or restart.

## Security notes

- The Autocab key remains server-side.
- Administration uses an HttpOnly session cookie and CSRF protection.
- Production cookies use the `Secure` flag.
- Security headers are set by the server.
- The public permit lookup is read-only.
- Rotate any Autocab key that has previously been exposed in screenshots, chat messages or a committed file.

## Permit date mapping

The user-facing field is called **Permit expiry date**. Autocab stores it in:

```text
motExpiryDate
```

Updates fetch the latest complete vehicle object, change only `motExpiryDate`, submit the full object, then fetch it again to verify the saved value.

## Plymouth citywide permit register

The secure dashboard now includes a **Plymouth register** tab. Upload an Excel or CSV file with these columns:

- `Vehicle Registration`
- `Plate Number`

The live register is stored at `${DATA_DIR}/plymouth-permits.json`; the previous copy is retained as `plymouth-permits-backup.json`. The bundled `Plymouth Plate Report.xlsx` and `plymouth-permits-seed.json` provide the initial 42 records.

Public routes:

- `/rank` — compact Need-A-Cab station rank with live status, Need-A-Cab permit state and Plymouth register match.
- `/permits` — citywide Plymouth register lookup, with Need-A-Cab vehicles clearly identified.

For Coolify, mount persistent storage at `/app/data` and set `DATA_DIR=/app/data`.

## Rank and citywide checker update

- `/rank` now uses `/api/rank-vehicles` and only shows active Need-A-Cab Hackneys with the H capability and callsigns 900-999.
- The rank screen keeps the live Need-A-Cab permit state and shows the Plymouth register result separately on one compact line.
- `/permits` is a citywide Plymouth register table with mobile filters for all records, Need-A-Cab vehicles, other operators and exceptions.

## Mobile evidence capture (test build)

Open `/evidence` to take or choose a taxi photograph, confirm the registration, check the Plymouth permit register, capture GPS, generate a stamped copy and save the evidence bundle.

Evidence is stored under `DATA_DIR/evidence/YYYY-MM-DD/` as:

- original photograph
- stamped JPEG
- JSON metadata including permit result, coordinates and SHA-256 hashes

Email is optional. Configure `EVIDENCE_EMAIL`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` and `SMTP_FROM`. Without SMTP, submissions are still saved locally for testing.

Camera and GPS on a physical phone require HTTPS. Desktop localhost can be used to test image selection and the remaining workflow.

### Test email button

The `/evidence` page includes **Send test email**. It verifies the SMTP connection and sends a simple message to the server-side `EVIDENCE_EMAIL` recipient without saving an evidence record. The recipient cannot be changed from the public page, preventing the application from becoming an open email relay.

## Enhanced angled-plate recognition test

The evidence page now includes multi-pass OCR voting, UK-format-aware character corrections and an Angle / Crop Assist tool. For difficult photographs, mark the four number-plate corners in this order: top-left, top-right, bottom-right, bottom-left. The app rectifies the selected quadrilateral and scans multiple enhanced versions before checking candidates against the permit register. A person must still confirm the registration before evidence is submitted.

## Reliable number-plate recognition update

The evidence page now scans the untouched original photograph before any evidence overlay is drawn. It automatically finds bright UK plate-shaped regions, crops and enlarges them, runs several OCR preprocessing passes, corrects common letter/number confusions, validates UK registration formats and ranks matches against the Plymouth permit register. Difficult photographs can still use the four-corner Angle / Crop Assist. A human must confirm the registration before evidence is submitted.

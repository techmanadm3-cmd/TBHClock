# TBH HR Web App - VPS2 MVP

Google Sheets remains the primary database. VPS2 hosts only the web/API layer.

## Current scope
- Login using existing `Staff[Username]` + `Staff[Password]` for migration compatibility
- Role-aware daily attendance (TOP sees all; STAFF sees own row)
- Reads `Staff`, `Clock`, `DateDim`, `HR_ScheduleRules`, `HR_StaffSchedule`
- Effective-dated staff schedule matching
- Legacy fallback to `Clock[Late Time]` when a staff schedule has not yet been assigned
- Clock In / Lunch Out / Lunch In / Clock Out writes directly to existing `Clock`
- Missing In / Missing Out / Late / Absent calculations
- Asia/Kuala_Lumpur application timezone

## Google Sheet setup already added
- `HR_ScheduleRules`
- `HR_StaffSchedule`
- `HR_Settings`

Existing AppSheet tabs were not renamed or deleted.

## VPS2 deployment
1. Create a Google Cloud service account with Sheets API access.
2. Share the Staff workbook with the service account email as Editor.
3. Put the JSON credential at `./secrets/google-service-account.json`.
4. Copy `.env.example` to `.env` and change `APP_SECRET`.
5. Run `docker compose up -d --build`.
6. Reverse proxy your HTTPS domain to `127.0.0.1:18080` using the supplied nginx example.

## Security migration note
The current Staff sheet stores plaintext passwords. This MVP reads them only for compatibility. A later phase should replace this with password hashes or Google/SSO authentication while preserving Staff as the business database.

## Performance note
Clock is cached in VPS2 memory for 120 seconds. The current MVP reads the existing Clock sheet as a bounded range, then filters by date. If Clock growth makes this slow, add a Google-Sheets monthly/index helper tab rather than moving the primary database to SQL.

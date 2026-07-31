# Jotform → Watermark → Google Drive

Receives a Jotform submission webhook, watermarks the uploaded photo
(diagonal, semi-transparent text + optional logo, real alpha transparency),
and files it into Google Drive under:

```
Root Folder / Doctor Name / Patient Name / July 2026 / patient_casetype_TIMESTAMP.jpg
```

(Type of Case is no longer a separate folder — it's now baked into the filename itself, e.g. `John_Doe_CompleteDenture_1732982331000.jpg`.)

---

## 1. Google Drive setup (service account)

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → create/select a project.
2. Enable the **Google Drive API** (APIs & Services → Library → search "Drive API" → Enable).
3. Create a **Service Account**: IAM & Admin → Service Accounts → Create Service Account (any name is fine, no roles needed).
4. Open the service account → Keys tab → Add Key → Create new key → JSON. This downloads a `.json` file.
5. Open that JSON file, copy its *entire* contents as one line, and paste it as the value of `GOOGLE_SERVICE_ACCOUNT_JSON` in your `.env`.
6. In Google Drive, create a folder (e.g. "Case Photos") that will act as the root. Right-click → Share → paste the service account's `client_email` (found in the JSON) → give it **Editor** access.
7. Copy the folder's ID from its URL (`drive.google.com/drive/folders/THIS_ID`) into `GDRIVE_ROOT_FOLDER_ID` in `.env`.

## 2. Configure `.env`

```
cp .env.example .env
```

Fill in every value — see comments in `.env.example` for what each one means.
Make sure `FIELD_PATIENT_NAME`, `FIELD_DOCTOR_NAME`, `FIELD_CASE_TYPE`, and `FIELD_PHOTO_UPLOAD`
exactly match the question titles on your Jotform form.

## 3. Install and run locally (to test)

```
npm install
npm start
```

The server listens on `http://localhost:3000/webhook`. To test it before deploying,
use a tunnel tool like `ngrok http 3000` to get a temporary public URL.

## 4. Deploy somewhere public

Any Node host works. Easiest free/cheap options:
- **Render.com** — New → Web Service → connect this folder/repo → build command `npm install`, start command `npm start` → add the `.env` values under Environment.
- **Railway.app** — similar flow, very quick.
- Your own VPS — `pm2 start server.js` to keep it running.

Once deployed you'll have a public URL like `https://your-app.onrender.com/webhook`.

## 5. Point Jotform at it

1. Open your form in Jotform → **Settings** → **Integrations** → search "Webhooks" → Add.
2. Paste your server's URL with the secret param:
   `https://your-app.onrender.com/webhook?secret=WHATEVER_YOU_SET_IN_ENV`
3. Save. Every new submission will now POST to your server automatically.

## 6. Test end-to-end

Submit a real test entry on the form with a photo attached. Check:
- Your server logs (should show "Processed 1 photo(s) for ...")
- Your Drive root folder — a Doctor Name folder → Case Type folder → Month folder → watermarked photo should appear.

## Notes / things you may want to tweak

- **Watermark look**: adjust `WATERMARK_TEXT`, `WATERMARK_OPACITY` (0–1), `WATERMARK_ROTATION_DEGREES` in `.env`. Leave `WATERMARK_LOGO_URL` blank to skip the logo entirely.
- **Multiple photos per submission**: handled automatically — each gets watermarked and filed separately.
- **Folder naming collisions**: two folders with the same doctor name will reuse the same folder (case-sensitive exact match), so keep doctor/case-type spelling consistent on the form (e.g. use a dropdown for Type of Case rather than free text, to avoid "RPD" vs "R.P.D." creating separate folders).
- **Large photos / slow networks**: this processes synchronously; if a request ever times out on your host, let me know and I can switch it to acknowledge Jotform immediately and process in the background.

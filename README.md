# Chuck's Daybook on Render

The same dashboard as the Claude artifact: the next 14 days of Google Calendar and your unread Gmail from the last 7 days. This version runs on its own server, so any browser can open it, Fire TV included, with no Claude sign-in.

When you're done, the dashboard lives at:

```
https://daybook.dreamachievedsp2025.net/d/<your access token>/
```

Add `?tv` to the end on the TV. It enlarges the text and asks the browser to keep the screen on.

**What it can see:** your calendar events, read-only. From Gmail it gets only the sender, subject, date and labels (the `gmail.metadata` permission). It cannot read message bodies or attachments, send mail or change anything. Nothing is stored on disk. The server reuses each Google answer for up to a minute, then asks again.

**Who can open it:** only someone with the full link. Every other address on the site returns "Not found". Treat the link like a password.

---

## The order of setup

Do these in order. Each step needs something from the step before it.

1. Make an access token
2. Put the code on GitHub
3. Create the Render service
4. Point `daybook.dreamachievedsp2025.net` at Render
5. Create the Google Cloud app
6. Give Render the Google client ID and secret
7. Authorize, and save the refresh token
8. Open it on the TV

Allow about 45 minutes. Most of it is waiting for DNS and clicking through Google Cloud.

---

## 1. Make an access token

This long random string is the secret part of your dashboard link. In Windows PowerShell:

```powershell
[guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
```

That prints 64 letters and digits. Save it in your password manager as "Daybook access token".

## 2. Put the code on GitHub

1. Go to github.com/new. Name the repository `chucks-daybook` and set it to **Private**. Create it.
2. On the empty repository page, click **uploading an existing file**.
3. Unzip `chucks-daybook.zip` on your PC. Drag everything inside the folder into the upload area: `server.js`, `package.json`, `render.yaml`, `README.md`, `.gitignore`, `.env.example` and the `public` folder.
4. Click **Commit changes**.

Windows Explorer hides files that start with a dot. If `.gitignore` and `.env.example` don't upload, the server still works without them.

## 3. Create the Render service

**Option A: let Claude do it.** Tell Claude in this conversation that the repository is up. Claude can create the service with your Render connector. Render also needs to be able to read your private GitHub repo: on render.com, go to Account Settings → Git and connect GitHub if it isn't already.

**Option B: do it yourself.**

1. In the Render dashboard: **New → Blueprint**. Pick the `chucks-daybook` repository. Render reads `render.yaml`.
2. Render asks for the secret values:
   - `ACCESS_TOKEN`: the 64-character string from step 1.
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`: you don't have these yet. Type `pending` in each one; the server treats that as "not set".
3. Click **Apply**. When the deploy finishes, `https://chucks-daybook.onrender.com/healthz` shows `ok`. If Render added a suffix to the name, use the address it shows you.

The blueprint uses Render's **free** plan. A free service goes to sleep after a while with no visitors, and the next visit takes up to a minute to wake it. While the dashboard is open on the TV, it checks in every 5 minutes, which keeps the service awake. To stop it ever sleeping, change the plan to a paid one in the service's settings.

## 4. Point the subdomain at Render

The dashboard uses the subdomain `daybook.`, so whatever is on `dreamachievedsp2025.net` itself is left alone.

1. In Render: your service → **Settings → Custom Domains → Add Custom Domain** → `daybook.dreamachievedsp2025.net`.
2. Render shows the DNS record to create. It is normally a **CNAME** with name `daybook`, pointing to `chucks-daybook.onrender.com`.
3. At the company where the domain's DNS is managed (your registrar, or Cloudflare if you use it), add that record exactly as Render shows it. On Cloudflare, set the record to **DNS only** (grey cloud) until Render shows the domain as verified.
4. Back in Render, wait until the domain shows **Verified** and the certificate is issued. This usually takes a few minutes and can take up to an hour.

If you'd rather use a different name than `daybook`, change `PUBLIC_URL` in Render to match, and use the same name in step 5.6.

## 5. Create the Google Cloud app

This is the part that lets your server read your calendar and email headers. Google's console changes its menu names now and then, so the wording may differ slightly.

1. Go to console.cloud.google.com, signed in as ckelle1635@gmail.com. Create a new project named `Daybook` and make sure it's selected.
2. **APIs & Services → Library.** Search for and **Enable** both **Google Calendar API** and **Gmail API**.
3. **Google Auth Platform** (older layout: **OAuth consent screen**) → **Get started**.
   - App name: `Chuck's Daybook`. Support email: your Gmail.
   - Audience: **External**.
   - Contact email: your Gmail. Agree and create.
4. **Data Access → Add or remove scopes.** Paste these two into "Manually add scopes", add them, then save:
   ```
   https://www.googleapis.com/auth/calendar.events.readonly
   https://www.googleapis.com/auth/gmail.metadata
   ```
5. **Audience → Publish app**, and confirm. The status should read **In production**.
   This step matters. While the app is in "Testing", Google expires the authorization after 7 days and the dashboard goes blank. You do not need Google's verification for an app only you use. You'll see an "unverified app" warning in step 7.
6. **Clients → Create client.**
   - Application type: **Web application**. Name: `Daybook server`.
   - Authorized redirect URIs → Add URI:
     ```
     https://daybook.dreamachievedsp2025.net/oauth/callback
     ```
   - Create. Copy the **Client ID** and **Client secret**. Keep the secret private.

## 6. Give Render the client ID and secret

Render → your service → **Environment**. Set:

- `GOOGLE_CLIENT_ID` to the Client ID
- `GOOGLE_CLIENT_SECRET` to the Client secret

Save. Render redeploys, which takes a minute or two.

## 7. Authorize and save the refresh token

1. On your PC, open your setup link:
   ```
   https://daybook.dreamachievedsp2025.net/d/<your access token>/setup
   ```
2. Choose ckelle1635@gmail.com.
3. Google warns "Google hasn't verified this app". That's expected for your own app. Click **Advanced → Go to Chuck's Daybook (unsafe)**.
4. **Tick both boxes**, calendar and Gmail, then **Continue**.
5. The page shows a long value. Copy it into Render as `GOOGLE_REFRESH_TOKEN` and save. Render redeploys.
6. Close that page. The value isn't saved anywhere else; if you lose it, run the setup link again.

If the page says a permission wasn't granted, open the setup link again and tick both boxes.

## 8. Open it

Open `https://daybook.dreamachievedsp2025.net/d/<your access token>/` on your PC. The calendar and inbox should load within a few seconds.

**On the Fire TV:**

1. Open the **Silk** browser.
2. Enter the address with `?tv` on the end:
   ```
   https://daybook.dreamachievedsp2025.net/d/<your access token>/?tv
   ```
   Typing 64 characters with the remote is tedious. The **Amazon Fire TV** phone app has a keyboard button: copy the link on your phone from your password manager, then paste it into that keyboard.
3. Bookmark it in Silk.

If the Fire TV screensaver still covers the page, Silk didn't honor the keep-screen-on request. Raise the screensaver timeout under Settings → Display & Sounds → Screensaver.

---

## Day-to-day

- **Add calendars:** set `CALENDAR_IDS` in Render to a comma-separated list, such as `primary,family06611349984331854872@group.calendar.google.com`. Find each ID in Google Calendar → the calendar's Settings → Integrate calendar → Calendar ID.
- **Change the link:** set a new `ACCESS_TOKEN` in Render. The old link stops working as soon as the redeploy finishes.
- **Cut off Google access:** myaccount.google.com/permissions → Chuck's Daybook → Remove access. The dashboard shows an authorization message until you redo step 7.
- **Logs:** Render keeps request logs, and they include the page address with your access token. Only you can see them, but don't share screenshots of them.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| "Google isn't authorized yet" | Finish step 7, and make sure `GOOGLE_REFRESH_TOKEN` was saved in Render. |
| "authorization expired or was revoked" | The app may still be in Testing (step 5.5). Publish it, then redo step 7. |
| "Gmail refused access" or "Google Calendar refused access" | The API isn't enabled (step 5.2), or its box wasn't ticked in step 7. |
| Google says `redirect_uri_mismatch` | The redirect URI in step 5.6 must match `PUBLIC_URL` plus `/oauth/callback` exactly, `https` included. |
| "Setup isn't ready" | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` or `PUBLIC_URL` is missing in Render. |
| "Not found" | The access token in the link doesn't match `ACCESS_TOKEN` in Render. |
| "Can't reach the dashboard server" | The free service is waking up. The page retries every 30 seconds. |

## Files

- `server.js`: the server. No dependencies; Node 20 or newer.
- `public/dashboard.html`, `public/app.js`: the page.
- `render.yaml`: Render blueprint.
- `.env.example`: the settings, for running it on your own PC.

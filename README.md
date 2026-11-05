# Sign Cards

Offline flashcards for learning sign language from your own videos. It runs on iPhone as a home-screen web app, so you don't need the App Store or an Apple developer account.

- **Your videos become cards.** The file name is the sign name (`thank_you.mp4` → "Thank you").
- **Two card types per sign:** *Sign → Word* (watch, recall the meaning) and *Word → Sign* (read, perform the sign, check with the video).
- **Spaced repetition** (Anki-style Again / Hard / Good / Easy).
- **One deck per collection.**
- **Fully offline.** Videos and progress are stored on the phone and never uploaded anywhere.

## 1. Put the app online (once, free)

The app is a set of static files. It has to be served over HTTPS so iPhone can install it and run it offline. GitHub Pages is the simplest free option:

1. Create a free account at <https://github.com> and click **New repository** (e.g. `sign-cards`, Public).
2. On the repository page click **Add file → Upload files**, then drag in **everything in this folder** (`index.html`, `manifest.webmanifest`, `sw.js`, and the `css`, `js`, `icons` folders). Commit.
3. Go to **Settings → Pages**. Under *Branch*, choose `main` and `/ (root)`, then click **Save**.
4. After a minute your app is at `https://<your-username>.github.io/sign-cards/`.

Only the app code goes on GitHub. Your videos stay on your phone.

(Alternative: drag the folder onto <https://app.netlify.com/drop>.)

## 2. Install on iPhone

1. Open the URL in **Safari**. Other browsers can't install web apps on iOS.
2. Tap **Share → Add to Home Screen → Add**.
3. Open **Sign Cards** from the home screen. Import your videos *from the home-screen app*, because it has its own storage, separate from Safari.

## 3. Import your videos from Google Drive

1. Install the **Google Drive** app and sign in. Drive then appears in the iOS Files picker. (Or download the folder to *On My iPhone* first.)
2. In Sign Cards tap **Import videos**, choose **+ New deck…** and type the collection name.
3. Tap **Choose videos… → Choose Files / Browse → Google Drive**, open the collection folder, tap **Select**, select all, then **Open**.
4. Check the sign names (you can edit them) and tap **Import**. The videos are copied onto the phone, so Drive isn't needed afterwards.

Avoid importing from the Photo Library: iOS renames those videos to `IMG_1234`.

Supported formats: `.mp4`, `.mov`, `.m4v` (best on iPhone); `.webm` only on recent iOS versions.

## Studying

- The numbers are **new** (blue), **learning** (orange) and **to review** (green) cards.
- Choose **Both / Sign → Word / Word → Sign** on the home or deck screen.
- Each deck introduces **10 new signs per day** by default (change it in the deck settings). The two cards of a sign are shown on different days so one doesn't give away the other.
- Videos loop. Use **Speed** for slow motion (0.75× / 0.5×) and tap the video to pause.
- ↶ undoes the last answer. On a computer: Space = show/Good, 1–4 = rate, Z = undo.

## Backups

Settings → **Export progress** saves a small JSON file with your decks and progress (not the videos). Keep it in Files or Drive. After a reinstall: **Import progress**, then re-import the videos. Progress is matched by deck name and sign name.

⚠️ Deleting the home-screen app deletes its videos and progress.

## Updating the app

Upload the changed files to the GitHub repository again. The app updates in the background and the new version shows the *next* time you open it. If you change the list of files, also update `ASSETS` in `sw.js`.

## Development

```sh
python3 -m http.server 8000   # then open http://localhost:8000
node tests/srs.test.mjs       # scheduling tests
```

No build step and no dependencies. The code is in `js/`: `app.js` (screens), `db.js` (IndexedDB storage), `srs.js` (scheduling), `study.js` (session queue), `importer.js`, `backup.js`.

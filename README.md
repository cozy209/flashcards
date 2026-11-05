# Flashcards

Offline flashcards for learning sign language from your own videos. It runs on iPhone as a home-screen web app, so you don't need the App Store or an Apple developer account.

- **Your videos become cards.** The file name is the sign name (`thank_you.mp4` → "Thank you").
- **Two card types per sign:** *Sign → Word* (watch, recall the meaning) and *Word → Sign* (read, perform the sign, check with the video).
- **Weighted random sessions** with three answers: **À revoir** (wrong), **Difficile** (hard), **Je sais** (right). Signs you get wrong come up more often.
- **One deck per collection.**
- **Fully offline.** Videos and progress are stored on the phone and never uploaded anywhere.

## 1. Put the app online (once, free)

The app is a set of static files. It has to be served over HTTPS so iPhone can install it and run it offline. GitHub Pages is the simplest free option:

1. Create a free account at <https://github.com> and click **New repository** (e.g. `sign-cards`, Public).
2. On the repository page click **Add file → Upload files**, then drag in **everything in this folder** (`index.html`, `manifest.webmanifest`, `sw.js`, and the `css`, `js`, `icons` folders). Commit.
3. Go to **Settings → Pages**. Under *Branch*, choose `main` and `/ (root)`, then click **Save**.
4. After a minute your app is at [https://cozy209.github.io/sign-cards/](https://cozy209.github.io/flashcards/).

Only the app code goes on GitHub. Your videos stay on your phone.

(Alternative: drag the folder onto <https://app.netlify.com/drop>.)

## 2. Install on iPhone

1. Open the URL in **Safari**. Other browsers can't install web apps on iOS.
2. Tap **Share → Add to Home Screen → Add**.
3. Open **Flashcards** from the home screen. Import your videos *from the home-screen app*, because it has its own storage, separate from Safari.

## 3. Import your videos from Google Drive

1. Install the **Google Drive** app and sign in. Drive then appears in the iOS Files picker. (Or download the folder to *On My iPhone* first.)
2. In Flashcards tap **Importer des vidéos**, choose **+ Nouveau deck…** and type the collection name.
3. Tap **Choose videos… → Choose Files / Browse → Google Drive**, open the collection folder, tap **Select**, select all, then **Open**.
4. Check the sign names (you can edit them) and tap **Import**. The videos are copied onto the phone, so Drive isn't needed afterwards.

**Or import a whole collection as a .zip.** Tap **Importer des vidéos → Import collection from .zip…** and pick the zip. The deck is named after the zip file (`Alphabet.zip` → "Alphabet"). If a deck with that name already exists, the videos are added to it. Google Drive's *Download* on a folder makes a zip like `Alphabet-20261105T101500Z-001.zip`, and the date part is dropped from the name. Videos in subfolders are included.

Avoid importing from the Photo Library: iOS renames those videos to `IMG_1234`.

Supported formats: `.mp4`, `.mov`, `.m4v` (best on iPhone); `.webm` only on recent iOS versions.

## Studying

- When you tap **Étudier**, the app draws **20 signs** at random (change it in Réglages → Étude → *Signes par session*). Each sign is shown **once** per session, even if you get it wrong.
- Each sign has a weight, based on your last answer. A sign with weight 4 is twice as likely to be drawn as one with weight 2:

  | Sign | Weight |
  |---|---|
  | Known (**Je sais** more than 5 times in a row) | 1 |
  | Never shown, or last answer **Je sais** | 2 |
  | Last answer **Difficile** | 3 |
  | Last answer **À revoir** | 4 |

  A **Difficile** or **À revoir** resets the Je sais count. Known signs still come back now and then.
- Each deck shows how many signs you know, e.g. **10/24 connus**.
- Choose **Les deux / Signe → Mot / Mot → Signe** on the home or deck screen. A sign has one weight for both directions; with *Les deux* the direction is picked at random.
- Videos loop. Use **Speed** for slow motion (0.75× / 0.5×) and tap the video to pause.
- ↶ undoes the last answer. On a computer: Space = show answer / Je sais, 1–3 = answer, Z = undo.

## Backups

Settings → **Export progress** saves a small JSON file with your decks and progress (not the videos). Keep it in Files or Drive. After a reinstall: **Import progress**, then re-import the videos. Progress is matched by deck name and sign name.

⚠️ Deleting the home-screen app deletes its videos and progress.

## Updating the app

Upload the changed files to the GitHub repository again. The app updates in the background and the new version shows the *next* time you open it. If you change the list of files, also update `ASSETS` in `sw.js`.

## Development

```sh
python3 -m http.server 8000   # then open http://localhost:8000
node tests/progress.test.mjs  # weights, draw and session tests
node tests/zip.test.mjs       # zip import tests
```

No build step and no dependencies. The code is in `js/`: `app.js` (screens), `db.js` (IndexedDB storage), `progress.js` (weights and weighted draw), `study.js` (session), `importer.js`, `zip.js` (zip reader), `backup.js`.

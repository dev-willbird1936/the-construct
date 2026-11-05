# The Construct

**A video is a solid.** The Construct turns a short clip into a ghost trail: every moment of a moving subject, frozen in place along its path. You then walk through that trail inside a tesseract.

**Live:** https://www.thefourthtesseract.com

## How it uses Meta AI

| Step | Meta AI model | What it does |
|---|---|---|
| Find the subject | **Muse Spark** | Checks the uploaded clip and proposes the concepts worth tracking (for example "black cat"). |
| Sweep and select | **SAM 3.1** (image) | Runs a concept sweep over sampled frames, returns candidate masks and boxes, and lets you pick the subject. |
| Track through time | **SAM 3.1** (video) | Tracks the selected subject across the whole clip, so every frame gets a clean mask. |

The masks become the ghost trail. The backend calls the Meta Model API through `backend/lib/meta.js`.

## Repository layout

- `index.html`, `site.js`, `styles.css`, `tesseract-*.js`: the site and the tesseract walk-through.
- `view-lite.*`, `view-basic.*`, `stable.*`: viewers for the three build tiers.
- `backend/app/`: Node/Express server (upload, jobs, sign-in gate, static files).
- `backend/lib/`: Meta AI calls (detect, track, concept proposals) and video handling.
- `backend/pipeline/basic/`: the Basic tier pipeline (Node + Python).
- `assets/gallery-seed/`, `assets/corpus/`: the four licensed example builds shown by default.
- `tests/`: Node and Python tests.

Some older research pages (`wolves.html`, `bear.html`, `lab.html`, `compare.html` and similar) refer to clips that are not in this repository, because that footage is not ours to publish. The default site does not load them.

## Running it locally

Needs Node.js 20+, ffmpeg on `PATH`, and Python 3.10+ for the Basic tier.

```bash
cd backend && npm install && cd ..
node backend/pipeline/basic/fetch-models.mjs                       # optional: Basic tier models
python -m pip install -r backend/pipeline/basic/requirements.txt   # optional: Basic tier
node backend/app/index.js                                          # http://localhost:8000
```

Configuration comes from environment variables. Set them in your shell; never commit values.

| Variable | Purpose |
|---|---|
| `META_API_KEY` | Meta Model API key (required for real builds). |
| `META_BASE_URL` | Meta API base URL. In development it defaults to a local proxy (`node backend/tools/meta-proxy.mjs`, which reads `META_API_KEY`). |
| `PORT`, `DATA_DIR`, `NODE_ENV` | Server port (default 8000), data folder (default `./data`), environment. |
| `SESSION_SECRET` | Cookie signing secret, 32+ characters (required in production). |
| `BASE_URL` | Public site URL used in sign-in links. |
| `GEO_MODE` | Country gate: `uk` (default) or `off`, which opens the site to every country. |
| `OWNER_EMAILS`, `ALLOWED_EMAILS` | Owner accounts and optional sign-up allow list. |
| `RESEND_API_KEY`, `MAIL_FROM`, `MAIL_MODE` | Sign-in email delivery. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `FB_APP_ID`, `FB_APP_SECRET` | Optional social sign-in. |
| `BASIC_PYTHON`, `FFMPEG_PATH`, `FFPROBE_PATH` | Tool paths, if not on `PATH`. |

Run the Node tests with `node --test tests/`. Some browser and pipeline tests need local tools (Playwright, Python packages, scratch folders) and are skipped or fail without them.

## Example footage credits

The default construct shows four licensed examples, each built by this site's own pipeline from the credited clip:

- **Black cat**: *Black Cat walking* by Dzkouslavia, CC0. [Source](https://commons.wikimedia.org/wiki/File:Black_Cat_walking.webm)
- **Muntjac**: *Muntjac Deer Barking* by Mvolz, CC BY 3.0 (Wikimedia Commons). [Source](https://commons.wikimedia.org/wiki/File:Muntjac_Deer_Barking.webm)
- **Grey squirrel**: *Squirrel eating nut* by Anton Porsche, CC BY 4.0 (Wikimedia Commons). [Source](https://commons.wikimedia.org/wiki/File:Squirrel_eating_nut.webmhd.webm)
- **Roe deer**: *European roe deer (Capreolus capreolus) in Slovakia* by The Nature Box, CC BY 3.0 (Wikimedia Commons). [Source](https://commons.wikimedia.org/wiki/File:European_roe_deer_(Capreolus_capreolus)_in_Slovakia.webm)

Full credits and licence links are in `terms.html`. Vendored libraries keep their own licence files under `vendor/`.

Built for the Meta AI Developer Hackathon.

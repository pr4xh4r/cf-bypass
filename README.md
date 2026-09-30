# 🛡️ CF Bypass — Cloudflare Turnstile Solver

> **What this does in one line:** A tool that disguises itself as a real human browser to automatically pass Cloudflare's security checks (CAPTCHA). 🤖 → 👤

---

## 🤔 What Problem Does This Solve?

When you visit certain websites, **Cloudflare** acts as a security guard. It blocks bots (automated programs) using a challenge called **Turnstile** — that "I am human" checkbox you've probably seen.

This project **fools Cloudflare** into thinking it's a real person, not a bot.

---

## 🧩 How It Works — 3 Core Tricks

### 🔴 Trick 1: Hide the "Bot Handshake" (CDP Leak Fix)

Normal browser-automation tools accidentally send a secret signal (`Runtime.enable`) that Cloudflare instantly detects as a bot.

**Fix:** Uses a patched browser library called `rebrowser-puppeteer-core` that hides this signal completely.

---

### 🔴 Trick 2: Fake a Real Browser Identity (Fingerprinting)

Cloudflare checks 20+ things about your browser to see if it looks real:

| What CF checks | What we do |
|---|---|
| `navigator.webdriver` | Delete it (bots forget to!) |
| Browser plugins | Spoof them to look like a real user's |
| Canvas & Audio fingerprint | Randomize them |
| GPU / Graphics card | Fake a real-looking one |
| RAM & CPU cores | Spoof realistic values (e.g., 8GB, 4 cores) |
| Screen size & language | Set believable values |

**Fix:** The `fingerprint.js` file **randomly generates a realistic browser identity** every time.

---

### 🔴 Trick 3: Move the Mouse Like a Human (Bezier Curves)

Cloudflare watches *how* your mouse moves to the checkbox. Bots move in a straight line — humans don't.

**Fix:** Uses **Bezier curves** (smooth, curved paths with variable speed) to simulate natural human mouse movement.

---

## 🔄 Step-by-Step Flow (What Happens When You Run It)

```
Step 1 → Generate a fake but realistic browser identity
Step 2 → Launch a disguised Chrome browser with that identity
Step 3 → Visit the target website
Step 4 → Wait and watch for a Cloudflare challenge (CAPTCHA)
Step 5 → Move mouse like a human and click the checkbox
Step 6 → Extract the security cookies (proof that you passed!)
Step 7 → ✅ Done! Website is now accessible
```

---

## 📁 Project Files Explained

```
cf-bypass/
├── index.js           ← 🚀 Main runner — start here
├── src/
│   ├── fingerprint.js ← 🎭 Creates fake browser identity
│   ├── browser.js     ← 🌐 Launches disguised Chrome
│   └── solver.js      ← 🧠 Finds & solves CF challenge
├── .env               ← ⚙️  Your config (set your URL here)
├── .env.example       ← 📋 Example config to copy from
├── test.js            ← 🧪 Interactive tester
└── package.json       ← 📦 Project dependencies list
```

---

## ⚙️ Setup (First Time Only)

**Step 1 — Install dependencies:**
```bash
npm install
```

**Step 2 — Create your config file:**
```bash
cp .env.example .env
```
Then open `.env` and set your target URL:
```
TARGET_URL=https://your-target-site.com
```

**Step 3 — Download Chrome (one-time only):**
```bash
npx rebrowser-puppeteer-core browsers install chrome
```

---

## 🚀 How to Use It

### Option A — Quick Test (Interactive)
```bash
npm test
# It will ask you: "Enter URL to bypass:"
# Type a URL and press Enter — watch it work!
```

### Option B — Run with a URL directly
```bash
node index.js https://some-cloudflare-site.com/
```

### Option C — Use it inside your own code (as a library)
```javascript
const { bypass } = require('./index');

const { page, cookies, bypassed } = await bypass({
    targetUrl:  'https://some-cloudflare-site.com/',
    timeoutSec: 120,       // wait up to 120 seconds
    keepOpen:   true,      // keep browser open after bypass
});

if (bypassed) {
    // 🎉 You're in! Use the cookies to make requests
    console.log('Got clearance cookie:', cookies.cf_clearance);
}
```

---

## 🍪 What You Get After a Successful Bypass

These are **Cloudflare security cookies** — proof that you passed the human check:

| Cookie | What it means |
|---|---|
| `cf_clearance` | Main "you passed" cookie — most important |
| `__cf_bm` | Bot management cookie |
| `_cfuvid` | Cloudflare user session tracking |

---

## 🧠 Smart Solver — 5 Fallback Strategies

The solver (`solver.js`) tries 5 different ways to find and click the Cloudflare checkbox, from most reliable to last resort:

1. **Walk the full frame tree** — searches all iframes for CF challenges *(most reliable)*
2. **Shadow DOM traversal** — for newer Turnstile 2024+ versions
3. **Match iframe by size** — Turnstile is always ~300×65px
4. **Click known wrapper selectors** — looks for known CF HTML patterns
5. **Detect challenge text** — clicks any iframe mentioning "challenge" *(last resort)*

---

## 🖥️ Requirements

| Requirement | Details |
|---|---|
| Node.js | Version 18 or higher |
| Chrome | Auto-downloaded by `rebrowser` |
| Linux only | Needs `xvfb` for virtual display: `sudo apt install xvfb` |

---

## ✅ Tested & Working Example

```
Target  : https://prmovies.exchnage
Result  : ✅ BYPASS SUCCESSFUL (solved in 0 seconds!)
Cookies : __cf_bm ✓  |  _cfuvid ✓
```

---

## ⚠️ Disclaimer

This project is for **educational and research purposes only**. Using it to scrape or access websites without permission may violate those sites' Terms of Service. Use responsibly.

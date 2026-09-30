/**
 * solver.js — Cloudflare Turnstile / Challenge Solver
 * ─────────────────────────────────────────────────────
 *
 * EXACT logic from portable/scripts/cf_bypass.js (stripped of proxy/account code).
 *
 * How CF challenges work:
 *   - Non-interactive: CF runs background JS proofs and auto-resolves in 2-45s.
 *     DO NOT click during this — it disrupts verification.
 *   - Interactive: A visible Turnstile checkbox iframe appears. Must be clicked
 *     with realistic human mouse movement (Bezier curve path).
 *
 * solveTurnstile() tries 5 strategies to find and click the checkbox:
 *   1. Walk full frame tree for CF iframes (most reliable — nested iframe fix)
 *   2. Shadow DOM traversal (Turnstile 2024+)
 *   3. Match iframe by Turnstile dimensions (~300x65px)
 *   4. Known wrapper div selectors on main page
 *   5. Detect challenge text + click any sizeable iframe (last resort)
 *
 * waitForCFBypass() orchestrates the full wait/click flow with 3 phases:
 *   Phase 0 (loading): page hasn't rendered yet — wait, never click
 *   Phase 1 (0-45s):  non-interactive — let CF auto-resolve, don't click
 *   Phase 2 (interactive or >45s): click the Turnstile checkbox
 */

'use strict';

const path = require('path');

// ── Timing constants (same as portable) ──────────────────────────────────────
const POLL_MS               = 500;  // how often we check page state (fast = less dead time)
const NO_CLICK_WINDOW_SEC   = 45;   // wait this long for CF auto-resolve before clicking
const INTERACTIVE_GRACE_SEC = 6;    // brief wait even after interactive checkbox detected
const MAX_TURNSTILE_ATTEMPTS = 15;  // max click attempts before giving up

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep       = (ms) => new Promise(r => setTimeout(r, ms));
const humanDelay  = (min, max) => new Promise(r =>
    setTimeout(r, Math.floor(Math.random() * (max - min + 1)) + min)
);

// ─────────────────────────────────────────────────────────────────────────────
// MOUSE MOVEMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a cubic Bezier curve between two points.
 * Produces a smooth, human-like arc instead of a straight line.
 * Straight-line movement is a strong bot signal to CF.
 *
 * Formula: B(t) = (1-t)³P0 + 3(1-t)²tP1 + 3(1-t)t²P2 + t³P3
 */
function generateBezierPath(startX, startY, endX, endY, steps = 25) {
    const points = [];

    // Random control points — creates a natural-looking arc
    const cp1x = startX + (endX - startX) * (0.2 + Math.random() * 0.3);
    const cp1y = startY + (Math.random() - 0.5) * 100;
    const cp2x = startX + (endX - startX) * (0.5 + Math.random() * 0.3);
    const cp2y = endY   + (Math.random() - 0.5) * 80;

    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const u = 1 - t;

        const x = u*u*u*startX + 3*u*u*t*cp1x + 3*u*t*t*cp2x + t*t*t*endX;
        const y = u*u*u*startY + 3*u*u*t*cp1y + 3*u*t*t*cp2y + t*t*t*endY;
        points.push({ x: Math.round(x), y: Math.round(y) });
    }

    return points;
}

/**
 * Move the mouse along a Bezier curve path, then click.
 *
 * Mimics real human behaviour:
 *   - Starts from a random screen position (not 0,0)
 *   - Variable speed (5-20ms per step)
 *   - Hesitation before click (50-200ms)
 *   - Click slightly off-center (±3px)
 *   - Second mouse.down/up for cross-origin iframe compatibility
 */
async function humanMouseClick(page, targetX, targetY) {
    // Start from a random screen position (simulates prior mouse activity)
    const startX = Math.floor(Math.random() * 200) + 100;
    const startY = Math.floor(Math.random() * 200) + 100;

    const movePath = generateBezierPath(startX, startY, targetX, targetY);

    for (const point of movePath) {
        await page.mouse.move(point.x, point.y);
        // Variable speed — faster in middle, slower at start/end
        await sleep(Math.floor(Math.random() * 15) + 5);
    }

    // Human hesitation before clicking (50-200ms)
    await humanDelay(50, 200);

    // Click with slight random offset — humans don't click exact center
    const offsetX = (Math.random() - 0.5) * 6;
    const offsetY = (Math.random() - 0.5) * 6;
    await page.mouse.click(targetX + offsetX, targetY + offsetY);

    // Small pause after click
    await humanDelay(100, 300);

    // Second click via mouse.down/up — sometimes reaches cross-origin iframes
    // when page.mouse.click() doesn't propagate the event correctly
    await page.mouse.move(targetX + offsetX + 1, targetY + offsetY + 1);
    await humanDelay(50, 150);
    await page.mouse.down();
    await humanDelay(30, 80);
    await page.mouse.up();
}

// ─────────────────────────────────────────────────────────────────────────────
// TURNSTILE SOLVER — 5 strategies
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find and click the Cloudflare Turnstile checkbox.
 *
 * Tries 5 strategies in order, retrying until timeout.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {number} [timeout=15000] — max ms to search before giving up
 * @returns {boolean} true if a click was made
 */
async function solveTurnstile(page, timeout = 15000) {
    const startTime = Date.now();
    let cfFrameLoggedOnce = false;

    while (Date.now() - startTime < timeout) {
        try {

            // ── Strategy 1: Walk full frame tree for CF challenge iframes ────
            //
            // KEY INSIGHT: The Turnstile checkbox iframe is NESTED inside an outer
            // CF frame. page.$$('iframe') only searches the MAIN document, so it
            // never finds the nested iframe. page.frames() returns the FULL tree.
            //
            // Step A: try clicking elements INSIDE the frame (works if same-origin)
            // Step B: click the IFRAME BOUNDING BOX from the parent viewport
            //         — we click at ~28px from left where the checkbox always sits
            const frames = page.frames();
            let cfFrameFound = false;

            for (const frame of frames) {
                const url = frame.url();
                if (!url.includes('challenges.cloudflare.com') && !url.includes('turnstile')) {
                    continue;
                }

                cfFrameFound = true;
                if (!cfFrameLoggedOnce) {
                    console.log(`     [CF] Found CF challenge iframe: ${url.substring(0, 80)}...`);
                    cfFrameLoggedOnce = true;
                }

                // Step A: click checkbox INSIDE the frame
                try {
                    const selectors = [
                        'input[type="checkbox"]',
                        '#challenge-stage input',
                        '.ctp-checkbox-label',
                        'label.ctp-checkbox-label',
                        '.mark',
                        '.spacer + label',
                        '[class*="checkbox"]',
                        'div[class*="checkbox"]',
                        '#cf-stage',
                    ];

                    for (const sel of selectors) {
                        const el  = await frame.$(sel).catch(() => null);
                        if (!el) continue;

                        const box = await el.boundingBox().catch(() => null);
                        if (!box || box.width < 1 || box.height < 1) continue;

                        const clickX = box.x + box.width  / 2 + (Math.random() - 0.5) * 4;
                        const clickY = box.y + box.height / 2 + (Math.random() - 0.5) * 4;

                        console.log(`     [CF] Clicking "${sel}" inside frame at (${Math.round(clickX)}, ${Math.round(clickY)}) [${Math.round(box.width)}x${Math.round(box.height)}]`);
                        await humanMouseClick(page, clickX, clickY);
                        return true;
                    }
                } catch (frameErr) {
                    // Cross-origin access blocked — fall through to Step B
                }

                // Step B: click the iframe's bounding box from the parent page
                // frameElement() returns the <iframe> DOM node even when cross-origin
                try {
                    const frameEl = await frame.frameElement();
                    if (frameEl) {
                        const box = await frameEl.boundingBox();
                        if (box && box.width > 20 && box.height > 20) {
                            // Turnstile checkbox is always at the LEFT side of the widget
                            const clickX = box.x + 28 + Math.random() * 6;
                            const clickY = box.y + (box.height / 2) + (Math.random() - 0.5) * 6;
                            console.log(`     [CF] Clicking CF iframe bounding box at (${Math.round(clickX)}, ${Math.round(clickY)}) [${Math.round(box.width)}x${Math.round(box.height)}]`);
                            await humanMouseClick(page, clickX, clickY);
                            return true;
                        }
                    }
                } catch (feErr) {
                    console.log(`     [CF] frameElement() fallback error: ${feErr.message?.substring(0, 60)}`);
                }
            }

            // CF frames found but couldn't click — wait and retry (don't fall through)
            if (cfFrameFound) {
                await sleep(1000);
                continue;
            }

            // ── Strategy 2: Shadow DOM traversal ────────────────────────────
            // Turnstile 2024+ wraps the checkbox in a shadow root.
            // document.querySelector() can't pierce shadow roots — we walk manually.
            try {
                const shadowTarget = await page.evaluate(() => {
                    const candidates = document.querySelectorAll(
                        '[id*="turnstile"], [class*="turnstile"], [id*="challenge"], #cf-turnstile-container'
                    );
                    for (const el of candidates) {
                        if (!el.shadowRoot) continue;
                        const checkbox = el.shadowRoot.querySelector(
                            'input[type="checkbox"], [class*="checkbox"], .mark'
                        );
                        if (!checkbox) continue;
                        const rect = checkbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, found: true };
                        }
                    }
                    return { found: false };
                });

                if (shadowTarget && shadowTarget.found) {
                    console.log(`     [CF] Found Turnstile in shadow DOM at (${Math.round(shadowTarget.x)}, ${Math.round(shadowTarget.y)})`);
                    await humanMouseClick(page, shadowTarget.x, shadowTarget.y);
                    return true;
                }
            } catch (e) { /* continue */ }

            // ── Strategy 3: Match iframe by Turnstile dimensions (~300x65px) ─
            try {
                const iframes = await page.$$('iframe');
                for (const iframe of iframes) {
                    const info = await iframe.evaluate(el => ({
                        src:    el.src || el.getAttribute('src') || '',
                        width:  el.offsetWidth  || el.clientWidth  || 0,
                        height: el.offsetHeight || el.clientHeight || 0,
                    })).catch(() => ({ src: '', width: 0, height: 0 }));

                    const isCFUrl = info.src.includes('cloudflare') ||
                                    info.src.includes('challenge')   ||
                                    info.src.includes('turnstile');

                    // Classic Turnstile widget: 280-320 wide, 55-80 tall
                    const isTurnstileSize = info.width  >= 280 && info.width  <= 320 &&
                                           info.height >= 55  && info.height <= 80;

                    if (!isCFUrl && !isTurnstileSize) continue;

                    const box = await iframe.boundingBox().catch(() => null);
                    if (!box || box.width < 10 || box.height < 10) continue;

                    const clickX = box.x + 26 + Math.random() * 8;
                    const clickY = box.y + (box.height / 2) + (Math.random() - 0.5) * 6;
                    console.log(`     [CF] Clicking sized iframe (${Math.round(box.width)}x${Math.round(box.height)}) at (${Math.round(clickX)}, ${Math.round(clickY)})`);
                    await humanMouseClick(page, clickX, clickY);
                    return true;
                }
            } catch (e) { /* continue */ }

            // ── Strategy 4: Known wrapper div selectors ──────────────────────
            const wrapperSelectors = [
                '#cf-turnstile-container',
                'div[class*="turnstile"]',
                '.cf-turnstile',
                '#turnstile-wrapper',
                '#challenge-stage',
                '#challenge-form',
                '.main-wrapper .spacer',
                '#challenge-body-text',
                '.challenge-platform',
            ];

            for (const sel of wrapperSelectors) {
                try {
                    const wrapper = await page.$(sel);
                    if (!wrapper) continue;
                    const box = await wrapper.boundingBox();
                    if (!box || box.width < 15 || box.height < 15) continue;

                    const clickX = box.x + Math.min(28, box.width * 0.15) + Math.random() * 6;
                    const clickY = box.y + box.height / 2 + (Math.random() - 0.5) * 6;
                    console.log(`     [CF] Found wrapper "${sel}" at (${Math.round(box.x)}, ${Math.round(box.y)}, ${Math.round(box.width)}x${Math.round(box.height)})`);
                    await humanMouseClick(page, clickX, clickY);
                    return true;
                } catch (e) { /* continue */ }
            }

            // ── Strategy 5: Detect challenge by page text, click any iframe ──
            try {
                const challengeInfo = await page.evaluate(() => {
                    const body = document.body;
                    if (!body) return null;
                    const text = body.innerText || '';
                    const isChallenge = text.includes('Verify you are human') ||
                                       text.includes('Checking your browser') ||
                                       text.includes('Just a moment');
                    if (!isChallenge) return null;

                    for (const iframe of document.querySelectorAll('iframe')) {
                        const rect = iframe.getBoundingClientRect();
                        if (rect.width > 50 && rect.height > 30) {
                            return { x: rect.x + 28, y: rect.y + rect.height / 2 };
                        }
                    }
                    return null;
                });

                if (challengeInfo) {
                    console.log(`     [CF] Challenge page detected, clicking at (${Math.round(challengeInfo.x)}, ${Math.round(challengeInfo.y)})`);
                    await humanMouseClick(page, challengeInfo.x + Math.random() * 6, challengeInfo.y + (Math.random() - 0.5) * 4);
                    return true;
                }
            } catch (e) { /* continue */ }

        } catch (err) {
            // Page might be navigating — retry
        }

        await sleep(1500); // wait before next strategy scan
    }

    return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN BYPASS LOOP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wait for Cloudflare to be bypassed, actively solving Turnstile when needed.
 *
 * Phase logic (same as portable):
 *   Phase 0 — 'loading':         page blank/loading → wait, never click
 *   Phase 1 — 'non-interactive': CF running BG JS checks → wait (don't click!)
 *   Phase 1 — 'interactive':     clickable checkbox visible → short grace, then click
 *   Phase 2 — after 45s:         try clicking even if type unclear
 *   Phase 3 — reload at 50-55s:  if still stuck, reload the page once
 *
 * @param {import('puppeteer-core').Page} page
 * @param {number}  [timeoutSec=120]
 * @param {Object}  [options]
 * @param {boolean} [options.verbose=true]
 * @returns {boolean}
 */
async function waitForCFBypass(page, timeoutSec = 120, options = {}) {
    const { verbose = true } = options;
    const startTime     = Date.now();
    const timeoutMs     = timeoutSec * 1000;
    let turnstileAttempts = 0;
    let screenshotTaken   = false;
    let reloadAttempted   = false;
    let lastLogSec        = -1;

    if (verbose) {
        console.log('     [CF] Waiting for Cloudflare bypass...');
    }

    while (Date.now() - startTime < timeoutMs) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);

        try {
            // ── Check if already bypassed ────────────────────────────────────
            const title    = await page.title().catch(() => '');
            const url      = page.url();
            const titleLow = title.toLowerCase().trim();

            const isCFTitle = titleLow === '' ||
                titleLow.includes('just a moment')      ||
                titleLow.includes('cloudflare')         ||
                titleLow.includes('attention required') ||
                titleLow.includes('checking your browser') ||
                titleLow.includes('challenge')          ||
                titleLow.includes('verify');

            const isCFUrl = url.includes('/cdn-cgi/') ||
                url.includes('challenge') ||
                url === '' || url === 'about:blank';

            const isDefinitelyBypassed = !isCFTitle && !isCFUrl && title.length > 0;

            if (isDefinitelyBypassed) {
                if (verbose) {
                    console.log(`     [CF] ✅ Cloudflare bypassed! (${elapsed}s) title="${title.substring(0, 50)}" url=${url.substring(0, 60)}`);
                }
                return true;
            }

            // ── Detect challenge type ─────────────────────────────────────────
            //
            // CRITICAL: Check for interactive (clickable) Turnstile FIRST via the
            // full frame tree. If we check page text first, a page showing "Verifying
            // you are human" with a visible checkbox would be wrongly classified as
            // 'non-interactive' and we'd wait 45s before clicking.
            let challengeType = null;

            try {
                for (const frame of page.frames()) {
                    const furl = frame.url() || '';
                    if (!furl.includes('challenges.cloudflare.com') && !furl.includes('turnstile')) continue;

                    const frameEl = await frame.frameElement().catch(() => null);
                    if (!frameEl) continue;
                    const box = await frameEl.boundingBox().catch(() => null);

                    // Turnstile widget dimensions: 250-600 wide, 50-150 tall
                    // (avoids matching a full-page managed-challenge shell)
                    if (box && box.width >= 250 && box.width <= 600 &&
                               box.height >= 50 && box.height <= 150) {
                        challengeType = 'interactive';
                        break;
                    }
                }
            } catch (e) {
                // Frame tree churns during navigation
            }

            // Fall back to page text / DOM if frame walk gave no answer
            if (challengeType === null) {
                challengeType = await page.evaluate(() => {
                    const body = document.body;
                    if (!body) return 'loading';

                    let hasCFIframe = false;
                    for (const iframe of document.querySelectorAll('iframe')) {
                        const src = iframe.src || '';
                        if (src.includes('turnstile') || src.includes('challenge')) hasCFIframe = true;
                    }

                    const text = body.innerText || '';
                    if (text.includes('Verifying you are human') ||
                        text.includes('Verifying...')            ||
                        text.includes('Performing security verification')) return 'non-interactive';
                    if (text.includes('Just a moment'))                    return 'managed';
                    if (hasCFIframe)                                        return 'non-interactive';
                    if (text.trim().length === 0)                           return 'loading';

                    return 'unknown';
                }).catch(() => 'loading');
            }

            // ── Phase 0: page still loading — never click ─────────────────────
            if (challengeType === 'loading') {
                if (verbose && elapsed % 10 === 0 && elapsed !== lastLogSec && elapsed > 0) {
                    lastLogSec = elapsed;
                    console.log(`     [CF] ⏳ Page still loading — not clicking (${elapsed}s)`);
                }
                await sleep(POLL_MS);
                continue;
            }

            // ── Phase 1a: interactive but within grace period — wait briefly ──
            if (challengeType === 'interactive' && elapsed < INTERACTIVE_GRACE_SEC) {
                await sleep(POLL_MS);
                continue;
            }

            // ── Phase 1b: non-interactive within no-click window — let CF run ─
            if (elapsed < NO_CLICK_WINDOW_SEC && (challengeType === 'non-interactive' || challengeType === 'managed')) {
                if (verbose && elapsed % 10 === 0 && elapsed !== lastLogSec && elapsed > 0) {
                    lastLogSec = elapsed;
                    console.log(`     [CF] ⏳ Non-interactive challenge running... (${elapsed}s) type=${challengeType}`);
                }
                await sleep(POLL_MS);
                continue;
            }

            // ── Phase 2: reload if stuck for 50-55s without interactive ──────
            if (elapsed >= 50 && elapsed < 55 && !reloadAttempted && challengeType !== 'interactive') {
                reloadAttempted = true;
                if (verbose) console.log('     [CF] 🔄 Non-interactive challenge stuck. Reloading page...');
                try {
                    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
                    await sleep(3000);
                } catch (e) {
                    if (verbose) console.log(`     [CF] Reload error: ${e.message?.substring(0, 50)}`);
                }
                continue;
            }

            // ── Phase 3: click the Turnstile checkbox ────────────────────────
            if (turnstileAttempts < MAX_TURNSTILE_ATTEMPTS) {
                if (verbose) {
                    console.log(`     [CF] Looking for clickable Turnstile (used ${turnstileAttempts}/${MAX_TURNSTILE_ATTEMPTS}, type=${challengeType})...`);
                }

                // Solve timeout grows with each failed attempt (3s → 6s max)
                const solveTimeout = Math.min(3000 + turnstileAttempts * 500, 6000);
                const solved = await solveTurnstile(page, solveTimeout);

                if (solved) {
                    // Only count actual clicks in the budget (not "nothing found" scans)
                    turnstileAttempts++;
                    if (verbose) {
                        console.log(`     [CF] Click #${turnstileAttempts} done — waiting for response...`);
                    }

                    // Wait for the click to take effect (grows slightly each attempt)
                    const waitAfterClick = Math.min(3000 + turnstileAttempts * 500, 6000);
                    await sleep(waitAfterClick);

                    // Quick check: did the click work?
                    try {
                        const postTitle    = await page.title().catch(() => '');
                        const postUrl      = page.url();
                        const postTitleLow = postTitle.toLowerCase().trim();
                        const titleIsReal  = postTitle.length > 0 &&
                            !postTitleLow.includes('just a moment') &&
                            !postTitleLow.includes('cloudflare')    &&
                            !postTitleLow.includes('checking')      &&
                            !postTitleLow.includes('challenge')      &&
                            !postTitleLow.includes('verify')        &&
                            !postUrl.includes('/cdn-cgi/');

                        if (titleIsReal) {
                            if (verbose) {
                                console.log(`     [CF] ✅ Cloudflare FULLY bypassed after click #${turnstileAttempts}! (${elapsed}s) title="${postTitle.substring(0, 40)}"`);
                            }
                            await sleep(1000);
                            return true;
                        } else {
                            if (verbose) {
                                console.log(`     [CF] Click #${turnstileAttempts}: not resolved yet. title="${postTitle.substring(0, 40)}"`);
                            }
                        }
                    } catch (e) { /* page navigating */ }

                    continue;
                }
            }

            // ── Diagnostic screenshot after 30s ──────────────────────────────
            if (!screenshotTaken && elapsed > 30) {
                screenshotTaken = true;
                try {
                    const fs          = require('fs');
                    const screenshotDir = path.join(__dirname, '../screenshots');
                    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
                    await page.screenshot({ path: path.join(screenshotDir, 'cf_bypass_stuck.png'), fullPage: false });
                    if (verbose) console.log('     [CF] 📸 Diagnostic screenshot: screenshots/cf_bypass_stuck.png');
                } catch (e) { /* best effort */ }
            }

            if (verbose && elapsed % 10 === 0 && elapsed !== lastLogSec && elapsed > 0) {
                lastLogSec = elapsed;
                const t = await page.title().catch(() => '');
                console.log(`     [CF] ⏳ Still waiting... (${elapsed}s/${timeoutSec}s) title="${t.substring(0, 40)}" type=${challengeType} attempts=${turnstileAttempts}`);
            }

        } catch (err) {
            // Page navigating
        }

        await sleep(POLL_MS);
    }

    // Final timeout screenshot
    try {
        const fs          = require('fs');
        const screenshotDir = path.join(__dirname, '../screenshots');
        if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
        await page.screenshot({ path: path.join(screenshotDir, 'cf_bypass_timeout.png'), fullPage: false });
        if (verbose) console.log('     [CF] 📸 Timeout screenshot: screenshots/cf_bypass_timeout.png');
    } catch (e) { /* best effort */ }

    if (verbose) {
        console.log(`     [CF] ❌ Cloudflare bypass timeout after ${timeoutSec}s (${turnstileAttempts} Turnstile attempts)`);
    }
    return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// COOKIE EXTRACTOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract all Cloudflare cookies via CDP (includes HttpOnly).
 * cf_clearance is the key one — it grants access for subsequent requests.
 *
 * @param {import('puppeteer-core').Page} page
 * @returns {{ cf_clearance, __cf_bm, _cfuvid, _all: Map }}
 */
async function extractCFCookies(page) {
    const client = await page.createCDPSession();
    const { cookies: allCookies } = await client.send('Network.getAllCookies');
    const pageCookies = await page.cookies();

    const cookieMap = new Map();
    for (const c of [...allCookies, ...pageCookies]) {
        cookieMap.set(c.name, c.value);
    }

    const getCookie = (name) => {
        const val = cookieMap.get(name);
        if (!val || val === 'undefined' || val === 'null' || val === '') return null;
        return val;
    };

    return {
        cf_clearance: getCookie('cf_clearance'),
        __cf_bm:      getCookie('__cf_bm'),
        _cfuvid:      getCookie('_cfuvid'),
        _all:         cookieMap,
    };
}

module.exports = {
    waitForCFBypass,
    extractCFCookies,
    solveTurnstile,
    humanMouseClick,
    humanDelay,
    sleep,
};

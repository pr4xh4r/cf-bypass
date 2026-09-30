/**
 * index.js — CF Bypass Entry Point
 * ─────────────────────────────────
 *
 * Ties together fingerprint → browser → solver.
 *
 * Usage (CLI):
 *   node index.js
 *   node index.js https://some-cf-site.com/
 *
 * Usage (library):
 *   const { bypass } = require('./index');
 *   const { page, cookies, bypassed } = await bypass({ targetUrl: '...' });
 */

'use strict';

require('dotenv').config();

const { generateFingerprint }              = require('./src/fingerprint');
const { launchStealthBrowser, sleep }      = require('./src/browser');
const { waitForCFBypass, extractCFCookies } = require('./src/solver');

/**
 * Full CF bypass flow.
 *
 * @param {Object}  [options]
 * @param {string}  [options.targetUrl]
 * @param {number}  [options.timeoutSec=120]
 * @param {string}  [options.chromePath]
 * @param {boolean} [options.keepOpen=false]  — keep browser open after bypass
 *
 * @returns {{ browser, page, cookies, bypassed }}
 */
async function bypass(options = {}) {
    const {
        targetUrl  = process.env.TARGET_URL || 'https://example.com/',
        timeoutSec = parseInt(process.env.CF_TIMEOUT || '120', 10),
        chromePath = process.env.CHROME_PATH || undefined,
        keepOpen   = false,
    } = options;

    console.log('═══════════════════════════════════════════════');
    console.log('  CF Bypass — Cloudflare Turnstile Solver');
    console.log('═══════════════════════════════════════════════');
    console.log(`  Target  : ${targetUrl}`);
    console.log(`  Timeout : ${timeoutSec}s`);
    console.log('');

    // ── Step 1: Generate browser fingerprint ─────────────────────────────────
    const fingerprint = generateFingerprint();
    console.log(`[main] Platform: ${fingerprint.platform_name} | Memory: ${fingerprint.device_memory}GB | Cores: ${fingerprint.hardware_concurrency}`);

    // ── Step 2: Launch stealth browser ──────────────────────────────────────
    const { browser, page } = await launchStealthBrowser({
        headless:    false,
        chromePath,
        fingerprint,
        args: ['--start-maximized'],
    });

    let cookies  = null;
    let bypassed = false;

    try {
        // ── Step 3: Navigate ──────────────────────────────────────────────────
        console.log(`[main] Navigating to ${targetUrl}...`);
        await page.goto(targetUrl, {
            waitUntil: 'domcontentloaded',
            timeout:   timeoutSec * 1000,
        });
        console.log('[main] Page loaded — starting CF bypass watcher...');
        console.log('');

        // ── Step 4: Wait for / solve CF challenge ─────────────────────────────
        bypassed = await waitForCFBypass(page, timeoutSec);

        // ── Step 5: Extract cookies ───────────────────────────────────────────
        if (bypassed) {
            cookies = await extractCFCookies(page);

            console.log('');
            console.log('═══════════════════════════════════════════════');
            console.log('  ✅ BYPASS SUCCESSFUL');
            console.log('═══════════════════════════════════════════════');
            console.log(`  cf_clearance : ${cookies.cf_clearance || '(none)'}`);
            console.log(`  __cf_bm      : ${cookies.__cf_bm      || '(none)'}`);
            console.log(`  _cfuvid      : ${cookies._cfuvid      || '(none)'}`);
            console.log('');
            console.log('[main] All cookies:');
            for (const [name, value] of cookies._all.entries()) {
                console.log(`  ${name} = ${String(value).substring(0, 80)}`);
            }
        } else {
            console.log('');
            console.log('═══════════════════════════════════════════════');
            console.log('  ❌ BYPASS FAILED');
            console.log('═══════════════════════════════════════════════');
        }
    } finally {
        // ── Step 6: Cleanup ───────────────────────────────────────────────────
        if (!keepOpen) {
            console.log('\n[main] Closing browser...');
            await browser.close().catch(() => {});
        }
    }

    return { browser, page, cookies, bypassed };
}

// ─── Run as CLI script ────────────────────────────────────────────────────────
if (require.main === module) {
    const targetUrl = process.argv[2] || undefined;

    bypass({ targetUrl, keepOpen: false })
        .then(({ bypassed }) => process.exit(bypassed ? 0 : 1))
        .catch((err) => {
            console.error('[main] Fatal error:', err.message);
            process.exit(1);
        });
}

module.exports = { bypass };

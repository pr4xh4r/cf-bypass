/**
 * browser.js — Stealth Browser Launcher
 * ──────────────────────────────────────
 *
 * EXACT logic from portable/scripts/cf_bypass.js (stripped of proxy/account code).
 *
 * Two core tricks that make this work:
 *
 *  1. rebrowser-puppeteer-core
 *     Patches the Runtime.enable CDP call that normal Puppeteer makes.
 *     CF detects this call because it exposes automation internals.
 *     rebrowser patches it at the protocol level — CF can't see it.
 *     IMPORTANT: aliased in package.json as puppeteer-core so existing
 *     require('puppeteer-core') calls automatically use rebrowser.
 *
 *  2. puppeteer-extra-plugin-stealth
 *     Patches ~20 browser fingerprint signals CF checks:
 *       navigator.webdriver, plugins, languages, canvas, AudioContext,
 *       Permissions.query, iframe.contentWindow, chrome.runtime, etc.
 *     IMPORTANT: We use addExtra(puppeteerCore) — NOT require('puppeteer-extra').
 *     This forces puppeteer-extra to wrap OUR rebrowser binary so BOTH tricks
 *     are active simultaneously. Without addExtra(), rebrowser's patch is skipped.
 *
 *  3. Our supplementary patches (injectStealthPatches)
 *     Things stealth plugin misses:
 *       - chrome.app object (CF managed challenge checks this)
 *       - WebGL vendor/renderer (consistent with fingerprint)
 *       - hardwareConcurrency, deviceMemory (consistent with fingerprint)
 *
 *  4. Chrome args — MINIMAL set
 *     DO NOT add --disable-web-security or --disable-site-isolation.
 *     CF's challenge script tests cross-origin enforcement — disabling it
 *     is a detectable red flag.
 *
 *  5. User-Agent — must match the REAL OS platform
 *     CF cross-references UA with navigator.platform and Sec-CH-UA-Platform.
 *     A Mac UA on a Linux system = strong bot signal.
 */

'use strict';

const { addExtra }  = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const puppeteerCore = require('puppeteer-core'); // → rebrowser-puppeteer-core (via package.json alias)
const path          = require('path');
const os            = require('os');
const { execSync }  = require('child_process');

// Wrap rebrowser with puppeteer-extra → gets BOTH CDP patch + stealth fingerprints
const puppeteerExtra = addExtra(puppeteerCore);
puppeteerExtra.use(StealthPlugin());

// Default Chrome path (auto-downloaded by rebrowser on first use)
const DEFAULT_CHROME_PATH = process.env.CHROME_PATH ||
    path.join(os.homedir(), '.cache/puppeteer/chrome/linux-143.0.7499.42/chrome-linux64/chrome');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Inject supplementary stealth patches BEFORE any page script runs.
 *
 * puppeteer-extra-plugin-stealth already handles: navigator.webdriver,
 * plugins, languages, Permissions.query, iframe.contentWindow, canvas,
 * AudioContext, font enumeration, Function.toString, chrome.runtime.
 *
 * We add ONLY what the stealth plugin misses:
 *   - chrome.app  (CF managed challenge checks for this exact object)
 *   - WebGL vendor/renderer (GPU fingerprinting signal)
 *   - hardwareConcurrency, deviceMemory (CF cross-checks with HTTP hints)
 *
 * @param {import('puppeteer-core').Page} page
 * @param {Object} fingerprint — from fingerprint.js
 */
async function injectStealthPatches(page, fingerprint = null) {
    await page.evaluateOnNewDocument((fp) => {

        // 1. chrome.app — CF's managed challenge checks window.chrome.app
        if (!window.chrome) window.chrome = {};
        if (!window.chrome.app) {
            window.chrome.app = {
                isInstalled: false,
                InstallState: {
                    DISABLED:      'disabled',
                    INSTALLED:     'installed',
                    NOT_INSTALLED: 'not_installed',
                },
                RunningState: {
                    CANNOT_RUN:   'cannot_run',
                    READY_TO_RUN: 'ready_to_run',
                    RUNNING:      'running',
                },
            };
        }

        // 2. hardwareConcurrency & deviceMemory — spoof from fingerprint
        if (fp && fp.hardware_concurrency) {
            Object.defineProperty(navigator, 'hardwareConcurrency', {
                get: () => fp.hardware_concurrency,
                configurable: true,
            });
        }
        if (fp && fp.device_memory) {
            Object.defineProperty(navigator, 'deviceMemory', {
                get: () => fp.device_memory,
                configurable: true,
            });
        }

        // 3. WebGL vendor/renderer — spoof so GPU fingerprint is consistent
        // UNMASKED_VENDOR_WEBGL = 0x9245, UNMASKED_RENDERER_WEBGL = 0x9246
        const webglVendor   = (fp && fp.webgl_vendor)   || 'Google Inc. (NVIDIA)';
        const webglRenderer = (fp && fp.webgl_renderer)  ||
            'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)';

        const getParameterProto = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (param) {
            if (param === 0x9245) return webglVendor;
            if (param === 0x9246) return webglRenderer;
            return getParameterProto.call(this, param);
        };

        if (typeof WebGL2RenderingContext !== 'undefined') {
            const getParam2Proto = WebGL2RenderingContext.prototype.getParameter;
            WebGL2RenderingContext.prototype.getParameter = function (param) {
                if (param === 0x9245) return webglVendor;
                if (param === 0x9246) return webglRenderer;
                return getParam2Proto.call(this, param);
            };
        }

    }, fingerprint || {});
}

/**
 * Launch a stealth Chrome browser ready to bypass Cloudflare.
 *
 * @param {Object}  options
 * @param {boolean} [options.headless=false]   — false = real/Xvfb display (recommended)
 * @param {string}  [options.chromePath]       — Path to Chrome executable
 * @param {string[]}[options.args]             — Extra Chrome args
 * @param {Object}  [options.fingerprint]      — Fingerprint from fingerprint.js
 *
 * @returns {{ browser, page }}
 */
async function launchStealthBrowser(options = {}) {
    const {
        headless    = false,
        chromePath  = DEFAULT_CHROME_PATH,
        args        = [],
        fingerprint = null,
    } = options;

    // ── Build Chrome args — MINIMAL set to avoid detection ───────────────────
    // DO NOT add --disable-web-security / --disable-site-isolation-trials /
    // --disable-features=IsolateOrigins. CF's challenge script tests whether
    // cross-origin restrictions are enforced. Disabling them = detectable.
    const chromeArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        // Remove "Chrome is being controlled by automation" banner
        '--disable-blink-features=AutomationControlled',
        ...args,
    ];

    // ── WebRTC leak prevention ────────────────────────────────────────────────
    // --proxy-server only covers TCP. WebRTC gathers ICE candidates over UDP
    // straight out of the host interface — leaking the real IP even when proxied.
    // These flags force WebRTC through the proxy path too.
    if (!chromeArgs.some(a => a.startsWith('--force-webrtc-ip-handling-policy'))) {
        chromeArgs.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
    }
    if (!chromeArgs.some(a => a.startsWith('--webrtc-ip-handling-policy'))) {
        chromeArgs.push('--webrtc-ip-handling-policy=disable_non_proxied_udp');
    }

    // ── User-Agent — must match the REAL OS platform ──────────────────────────
    // CF cross-references UA with navigator.platform and Sec-CH-UA-Platform.
    // A Mac UA on a Linux host is a strong bot signal.
    const platform = os.platform();
    let actualUA;
    if (platform === 'darwin') {
        actualUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';
    } else if (platform === 'win32') {
        actualUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';
    } else {
        // Linux — use X11 Linux UA to match navigator.platform
        actualUA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';
    }
    chromeArgs.push(`--user-agent=${actualUA}`);

    // ── Window size from fingerprint ──────────────────────────────────────────
    if (fingerprint && fingerprint.screen_resolution) {
        chromeArgs.push(`--window-size=${fingerprint.screen_resolution.width},${fingerprint.screen_resolution.height}`);
    } else if (!args.some(a => a.startsWith('--window-size'))) {
        chromeArgs.push('--window-size=1280,800');
    }

    // ── Display / headless mode ───────────────────────────────────────────────
    // CRITICAL: CF detects headless Chrome even in 'new' mode (via GPU/canvas signals).
    // Always prefer a real or virtual display (Xvfb on Linux).
    let headlessMode = false;
    const hasDisplay = !!process.env.DISPLAY;

    if (!headless) {
        // headless=false: try to start Xvfb if no real display
        if (!hasDisplay) {
            try {
                const xvfbDisplay = ':99';
                try {
                    execSync(`Xvfb ${xvfbDisplay} -screen 0 1920x1080x24 &`, { timeout: 2000, stdio: 'ignore' });
                } catch (e) { /* might already be running */ }
                process.env.DISPLAY = xvfbDisplay;
                console.log(`     [CF] Started Xvfb on ${xvfbDisplay}`);
            } catch (e) { /* best effort */ }
        }
        headlessMode = false;
    } else {
        // headless=true: use display if available, else Xvfb, else new headless
        if (hasDisplay) {
            headlessMode = false;
        } else {
            try {
                const xvfbDisplay = ':99';
                try {
                    execSync(`Xvfb ${xvfbDisplay} -screen 0 1920x1080x24 &`, { timeout: 2000, stdio: 'ignore' });
                } catch (e) { /* might already be running */ }
                process.env.DISPLAY = xvfbDisplay;
                headlessMode = false;
                console.log(`     [CF] Started Xvfb on ${xvfbDisplay}`);
            } catch (e) {
                headlessMode = 'new';
                console.log('     [CF] ⚠️ No display — falling back to headless (CF bypass may fail)');
            }
        }
    }

    const launchOptions = {
        headless:          headlessMode,
        executablePath:    chromePath,
        args:              chromeArgs,
        defaultViewport:   null,   // use window-size from --window-size flag
        ignoreHTTPSErrors: true,
        // Don't let Puppeteer kill Chrome on SIGINT/SIGTERM — let the caller decide
        handleSIGINT:  false,
        handleSIGTERM: false,
        handleSIGHUP:  false,
    };

    // Launch via puppeteer-extra wrapping rebrowser-puppeteer-core
    // → BOTH the CDP patch (rebrowser) + stealth fingerprints (stealth plugin) are active
    const browser = await puppeteerExtra.launch(launchOptions);

    // Get (or create) the first page
    const pages = await browser.pages();
    const page  = pages[0] || await browser.newPage();

    // Inject supplementary patches AFTER stealth plugin (they complement, not conflict)
    await injectStealthPatches(page, fingerprint);
    console.log('     [CF] ✅ Stealth active: rebrowser-puppeteer-core + stealth plugin + WebGL/hardware patches');

    return { browser, page };
}

module.exports = {
    launchStealthBrowser,
    injectStealthPatches,
    DEFAULT_CHROME_PATH,
    sleep,
};

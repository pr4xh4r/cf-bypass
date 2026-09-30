/**
 * fingerprint.js — Browser Fingerprint Generator
 * ──────────────────────────────────────────────
 *
 * Generates a realistic, internally-consistent browser fingerprint.
 * Cloudflare cross-references many browser signals (UA, sec-ch-ua,
 * navigator.platform, WebGL, hardware). If they contradict each other,
 * CF marks the session as a bot. This module keeps everything in sync.
 *
 * How it works:
 *   - Pick a random Chrome/Edge version, platform (Win/Mac/Linux), and language.
 *   - Build the matching User-Agent, sec-ch-ua, and all navigator properties.
 *   - Hardware metrics (concurrency, memory, screen) are chosen randomly too.
 *
 * Usage:
 *   const { generateFingerprint } = require('./fingerprint');
 *   const fp = generateFingerprint();
 *   console.log(fp.user_agent);
 */

'use strict';

// ─── Chrome version pool (real builds) ───────────────────────────────────────
const CHROME_VERSIONS = [
    { major: '120', full: '120.0.6099.109' },
    { major: '122', full: '122.0.6261.57'  },
    { major: '124', full: '124.0.6367.78'  },
    { major: '126', full: '126.0.6478.55'  },
    { major: '128', full: '128.0.6613.84'  },
    { major: '130', full: '130.0.6723.58'  },
    { major: '132', full: '132.0.6834.83'  },
    { major: '134', full: '134.0.6998.35'  },
    { major: '136', full: '136.0.7103.49'  },
    { major: '138', full: '138.0.7204.48'  },
    { major: '140', full: '140.0.7310.38'  },
    { major: '143', full: '143.0.7499.42'  },
];

// ─── "Not A Brand" values — part of sec-ch-ua, varies per Chrome build ───────
const NOT_A_BRAND_VALUES = [
    { brand: '"Not_A Brand"',  version: '"8"'  },
    { brand: '"Not A(Brand"',  version: '"24"' },
    { brand: '"Not/A)Brand"',  version: '"8"'  },
    { brand: '"Not)A;Brand"',  version: '"99"' },
];

// ─── Platform pool — each entry describes one OS fingerprint ─────────────────
const PLATFORMS = [
    {
        name:              'Windows',
        ua_platform:       'Windows NT 10.0; Win64; x64',
        sec_platform:      '"Windows"',
        platform_versions: ['"10.0.0"', '"15.0.0"'],
        arch:              '"x86"',
        bitness:           '"64"',
    },
    {
        name:              'macOS',
        ua_platform:       'Macintosh; Intel Mac OS X 10_15_7',
        sec_platform:      '"macOS"',
        platform_versions: ['"14.0.0"', '"14.5.0"', '"15.0.0"'],
        arch:              '"x86"',
        bitness:           '"64"',
    },
    {
        name:              'Linux',
        ua_platform:       'X11; Linux x86_64',
        sec_platform:      '"Linux"',
        platform_versions: ['"6.5.0"', '"6.6.0"', '"6.8.0"'],
        arch:              '"x86"',
        bitness:           '"64"',
    },
];

// ─── Accept-Language pool ─────────────────────────────────────────────────────
const ACCEPT_LANGUAGES = [
    'en-US,en;q=0.9',
    'en-US,en;q=0.9,es;q=0.8',
    'en-GB,en;q=0.9',
    'en-US,en;q=0.9,fr;q=0.8',
    'en-US,en;q=0.9,de;q=0.8',
    'en-US,en;q=0.9,pt;q=0.8',
    'en-IN,en;q=0.9,hi;q=0.8',
];

// ─── Hardware pools ───────────────────────────────────────────────────────────
const SCREEN_RESOLUTIONS   = [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768  },
    { width: 1536, height: 864  },
    { width: 1440, height: 900  },
    { width: 2560, height: 1440 },
];
const HARDWARE_CONCURRENCY = [4, 8, 12, 16];
const DEVICE_MEMORY        = [4, 8, 16];

// ─── WebGL spoof values — must look like a real GPU ──────────────────────────
const WEBGL_VENDORS   = ['Google Inc. (NVIDIA)', 'Google Inc. (Intel)', 'Google Inc. (AMD)'];
const WEBGL_RENDERERS = [
    'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (AMD, Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)',
];

// ─── Helper: pick a random item from an array ────────────────────────────────
function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Generate a single random browser fingerprint.
 *
 * @returns {Object} Fingerprint with user_agent, sec-ch-ua fields,
 *                   hardware metrics, and WebGL spoof values.
 */
function generateFingerprint() {
    const chromeVer   = pick(CHROME_VERSIONS);
    const platform    = pick(PLATFORMS);
    const platVer     = pick(platform.platform_versions);
    const notABrand   = pick(NOT_A_BRAND_VALUES);
    const language    = pick(ACCEPT_LANGUAGES);
    const resolution  = pick(SCREEN_RESOLUTIONS);
    const concurrency = pick(HARDWARE_CONCURRENCY);
    const memory      = pick(DEVICE_MEMORY);
    const webGLVendor = pick(WEBGL_VENDORS);
    const webGLRenderer = pick(WEBGL_RENDERERS);

    // Build User-Agent — Chrome standard format
    const userAgent =
        `Mozilla/5.0 (${platform.ua_platform}) ` +
        `AppleWebKit/537.36 (KHTML, like Gecko) ` +
        `Chrome/${chromeVer.major}.0.0.0 Safari/537.36`;

    // sec-ch-ua — the Client Hints header CF reads
    const secChUa =
        `"Chromium";v="${chromeVer.major}", ${notABrand.brand};v=${notABrand.version}`;

    return {
        // HTTP / CDP fields
        user_agent:                  userAgent,
        accept_language:             language,
        sec_ch_ua:                   secChUa,
        sec_ch_ua_full_version:      chromeVer.full,
        sec_ch_ua_platform:          platform.sec_platform,
        sec_ch_ua_platform_version:  platVer,
        sec_ch_ua_arch:              platform.arch,
        sec_ch_ua_bitness:           platform.bitness,
        sec_ch_ua_mobile:            '?0',

        // navigator.* JS properties
        platform_name:          platform.name,
        hardware_concurrency:   concurrency,
        device_memory:          memory,

        // Screen
        screen_resolution:      resolution,

        // WebGL spoofs
        webgl_vendor:           webGLVendor,
        webgl_renderer:         webGLRenderer,
    };
}

module.exports = { generateFingerprint };

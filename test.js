/**
 * test.js — Interactive CF Bypass Tester
 * ───────────────────────────────────────
 * Run with:  npm test
 *
 * Prompts you to enter a URL, then runs the full bypass flow.
 */

'use strict';

const readline = require('readline');
const { bypass } = require('./index');

// ─── Prompt helper ────────────────────────────────────────────────────────────
function ask(question) {
    const rl = readline.createInterface({
        input:  process.stdin,
        output: process.stdout,
    });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║      CF Bypass — Interactive Tester          ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');

    // Ask for the URL
    let url = await ask('  Enter URL to bypass: ');

    // Add https:// if user forgot it
    if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
    }

    // Validate
    if (!url) {
        console.error('  ❌ No URL entered. Exiting.');
        process.exit(1);
    }

    console.log('');
    console.log(`  Starting bypass for: ${url}`);
    console.log('');

    // Run the bypass
    const { bypassed, cookies } = await bypass({
        targetUrl:  url,
        timeoutSec: 120,
        keepOpen:   false,
    });

    process.exit(bypassed ? 0 : 1);
})();

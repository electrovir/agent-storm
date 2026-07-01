#!/usr/bin/env node
import {chromium} from 'playwright';
import {mkdirSync, readFileSync, existsSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {parseArgs} from 'node:util';

const {values, positionals} = parseArgs({
    allowPositionals: true,
    options: {
        click: {type: 'string'},
        wait: {type: 'string', default: '500'},
        output: {type: 'string', default: '.logs/screenshot.png'},
        base: {type: 'string', default: 'http://localhost:5173'},
        width: {type: 'string', default: '1280'},
        height: {type: 'string', default: '900'},
        'full-page': {type: 'boolean', default: false},
    },
});

const path = positionals[0];
if (!path) {
    console.error(
        'usage: screenshot.mjs <path> [--click=<selector>] [--wait=<ms>] [--output=<file>] [--full-page]',
    );
    process.exit(1);
}

const url = new URL(path, values.base).toString();
const output = resolve(process.cwd(), values.output);
mkdirSync(dirname(output), {recursive: true});

/**
 * No `executablePath` so Playwright uses the Chromium it manages itself (run
 * `npx playwright install chromium` once if it isn't already on disk). The previous
 * hardcoded `/usr/bin/google-chrome` only existed on Linux and broke this script on macOS.
 */
const browser = await chromium.launch({
    headless: true,
});
try {
    const context = await browser.newContext({
        viewport: {width: Number(values.width), height: Number(values.height)},
    });
    const secretPath = resolve(process.cwd(), '.not-committed/auth-secret');
    if (existsSync(secretPath)) {
        const secret = readFileSync(secretPath, 'utf8').trim();
        await context.addInitScript((s) => {
            localStorage.setItem('agent-storm-auth-secret', s);
        }, secret);
    }
    const page = await context.newPage();
    await page.goto(url, {waitUntil: 'networkidle'});
    if (values.click) {
        await page.locator(values.click).first().click();
        await page.waitForTimeout(Number(values.wait));
    }
    await page.screenshot({path: output, fullPage: values['full-page']});
    console.log(`wrote ${output}  (${url})`);
} finally {
    await browser.close();
}

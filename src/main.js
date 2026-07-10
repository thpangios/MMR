import { Actor } from 'apify';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Add stealth plugin
chromium.use(StealthPlugin());

// ============================================
// HUMAN-LIKE BEHAVIOR HELPERS
// ============================================

// Add random jitter to make patterns less predictable
function jitter() {
    return Math.floor(Math.random() * 80) - 40; // -40 to +40 random offset
}

async function humanDelay(min = 1000, max = 3000) {
    const baseDelay = Math.random() * (max - min) + min;
    const delay = baseDelay + jitter(); // Add jitter to delay
    await new Promise(resolve => setTimeout(resolve, Math.max(100, delay))); // Min 100ms
}

async function simulateHumanMouse(page) {
    // More variable mouse positions with jitter
    const baseX = Math.floor(Math.random() * 600) + 50;
    const baseY = Math.floor(Math.random() * 600) + 50;
    const x = baseX + jitter();
    const y = baseY + jitter();

    // Variable number of steps (8-15 instead of always 10)
    const steps = Math.floor(Math.random() * 8) + 8;

    await page.mouse.move(x, y, { steps });
    await humanDelay(300, 800);
}

async function simulateHumanScroll(page) {
    // More variable scroll amounts with jitter
    const baseScroll = Math.floor(Math.random() * 400) + 150;
    const scrollAmount = baseScroll + jitter();

    await page.evaluate((amount) => {
        window.scrollBy({
            top: amount,
            behavior: 'smooth'
        });
    }, scrollAmount);
    await humanDelay(500, 1000);
}

async function humanTypeVIN(page, selector, vin) {
    // Focus input
    await page.click(selector);
    await humanDelay(300, 600);

    // Type character by character with variable delays + jitter
    for (const char of vin) {
        await page.keyboard.type(char);
        // More variable typing speed: 60-220ms range with jitter
        const baseTypingDelay = Math.floor(Math.random() * 160) + 60;
        const typingDelay = baseTypingDelay + (jitter() / 2); // Smaller jitter for typing
        await new Promise(resolve => setTimeout(resolve, Math.max(50, typingDelay)));
    }

    await humanDelay(500, 1000);
}

// ============================================
// CAPTCHA & ERROR DETECTION
// ============================================

async function detectCaptchaOrBlocking(page, pageName = 'page') {
    console.log(`  → Checking for CAPTCHA/blocking on ${pageName}...`);

    const result = await page.evaluate(() => {
        const bodyText = (document.body?.textContent || '');
        const text = bodyText.toLowerCase();
        const html = document.documentElement.innerHTML.toLowerCase();

        // Keyword groups — each match records WHICH keyword hit and the surrounding text,
        // so a "captcha" hit from a passive reCAPTCHA badge can be told apart from a real wall.
        const groups = {
            hasCaptcha: ['captcha', 'verify you are human', "verify you're human"],
            hasCloudflare: ['cloudflare', 'checking your browser'],
            hasAccessDenied: ['access denied', '403 forbidden', 'not authorized'],
            hasSessionExpired: ['session expired', 'please log in', 'login required'],
            hasRateLimit: ['too many requests', 'rate limit'],
        };

        const signals = {};
        const matches = [];
        for (const [signal, keywords] of Object.entries(groups)) {
            signals[signal] = false;
            for (const kw of keywords) {
                const idx = text.indexOf(kw);
                if (idx !== -1) {
                    signals[signal] = true;
                    const start = Math.max(0, idx - 90);
                    const excerpt = bodyText.slice(start, idx + kw.length + 90).replace(/\s+/g, ' ').trim();
                    matches.push({ signal, keyword: kw, excerpt });
                }
            }
        }

        // Distinguish an INTERACTIVE reCAPTCHA challenge from the passive footer badge/script
        // that normal login pages carry ("This site is protected by reCAPTCHA...").
        const recaptchaWidget = !!document.querySelector(
            '.g-recaptcha, [data-sitekey], iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/api2/bframe"], iframe[src*="recaptcha/enterprise"]'
        );
        signals.hasRecaptcha = recaptchaWidget || html.includes('recaptcha');
        const recaptchaBadgeOnly = html.includes('recaptcha') && !recaptchaWidget;

        // Structural / positive signals — much more reliable than keyword guessing.
        const hasPasswordField = !!document.querySelector('input[type="password"]');
        const hasVinBox = !!document.querySelector('#vinText');

        return {
            signals, matches, recaptchaWidget, recaptchaBadgeOnly,
            hasPasswordField, hasVinBox,
            title: document.title, url: location.href,
        };
    });

    // Report findings with the actual matched text, so logs are self-explanatory.
    result.matches.forEach(m => {
        console.log(`  ⚠️ [${m.signal}] matched "${m.keyword}" → "...${m.excerpt}..."`);
    });
    if (result.recaptchaWidget) {
        console.log('  ⚠️ INTERACTIVE reCAPTCHA widget present (real challenge)');
    } else if (result.recaptchaBadgeOnly) {
        console.log('  ℹ️ Passive reCAPTCHA badge/script only — normal on login pages, NOT a challenge');
    }
    if (result.hasPasswordField) {
        console.log('  ℹ️ Password field present → this looks like a LOGIN page, not a captcha');
    }
    if (result.hasVinBox) {
        console.log('  ✅ VIN search box (#vinText) present → MMR app is actually loaded');
    }

    const isBlocked = Object.values(result.signals).some(v => v) || result.recaptchaWidget;
    if (!isBlocked) {
        console.log(`  ✅ No blocking detected on ${pageName}`);
    }

    // Flat flags kept for backwards compatibility; `.details` carries the rich data.
    return { ...result.signals, details: result };
}

// ============================================
// DIAGNOSTICS — capture EVERYTHING when something goes wrong
// ============================================

// Dumps a full snapshot (screenshot + HTML + visible text + metadata) to the Apify
// key-value store so you can SEE exactly what the page was at the moment of failure.
// View them under the run's "Storage → Key-value store" tab.
async function saveDiagnostics(page, label) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const key = `DIAG-${label}-${ts}`;
    try {
        const url = page.url();
        const title = await page.title().catch(() => 'unknown');

        // Full-page screenshot (not just the fold)
        const screenshot = await page.screenshot({ fullPage: true }).catch(() => null);
        if (screenshot) {
            await Actor.setValue(`${key}.png`, screenshot, { contentType: 'image/png' });
        }

        // Full rendered HTML of the top frame
        const html = await page.content().catch(() => '');
        await Actor.setValue(`${key}.html`, html, { contentType: 'text/html' });

        // Visible text + structural facts
        const facts = await page.evaluate(() => ({
            bodyText: (document.body?.innerText || '').slice(0, 8000),
            hasPasswordField: !!document.querySelector('input[type="password"]'),
            hasVinBox: !!document.querySelector('#vinText'),
            hasOdometer: !!document.querySelector('input#Odometer'),
            recaptchaWidget: !!document.querySelector('.g-recaptcha, [data-sitekey], iframe[src*="recaptcha/api2"]'),
            inputIds: Array.from(document.querySelectorAll('input')).map(i => i.id || i.name || i.type).slice(0, 40),
            buttonLabels: Array.from(document.querySelectorAll('button')).map(b => b.getAttribute('aria-label') || b.textContent.trim()).filter(Boolean).slice(0, 40),
        })).catch(() => ({}));

        const frameUrls = page.frames().map(f => f.url());
        const cookies = await page.context().cookies().catch(() => []);

        const meta = {
            label, url, title, timestamp: ts,
            frameUrls,
            cookiesPresent: cookies.map(c => `${c.domain} | ${c.name}`),
            ...facts,
        };
        await Actor.setValue(`${key}.json`, meta);

        console.log(`  🧾 Diagnostics saved → KV keys "${key}.png / .html / .json"`);
        console.log(`     • URL:   ${url}`);
        console.log(`     • Title: ${title}`);
        console.log(`     • Frames(${frameUrls.length}): ${frameUrls.join(' | ')}`);
        console.log(`     • Inputs seen: ${(meta.inputIds || []).join(', ') || 'none'}`);
        console.log(`     • Buttons seen: ${(meta.buttonLabels || []).join(', ') || 'none'}`);
        return meta;
    } catch (e) {
        console.log(`  ⚠️ Failed to save diagnostics (${label}): ${e.message}`);
        return null;
    }
}

// ============================================
// MMR EXTRACTION FUNCTIONS
// ============================================

async function extractMMRValues(page) {
    console.log('  → Extracting MMR values from page...');

    const mmrData = await page.evaluate(() => {
        // Helper function to extract number from price string
        const extractPrice = (text) => {
            if (!text) return null;
            const match = text.match(/\$[\d,]+/);
            if (!match) return null;
            return parseInt(match[0].replace(/[$,]/g, ''));
        };

        // Extract Base MMR (36px font, inside baseMMRTitle container)
        const baseMmrEl = document.querySelector('.styles__baseMMRTitle__AfQgP .styles__currency__EkR32');
        const baseMmrText = baseMmrEl?.textContent?.trim();

        // Extract Adjusted MMR (44px font, inside adjustedMMRContainer)
        const adjustedMmrEl = document.querySelector('.styles__adjustedMMRContainer__lixDF .styles__currency__EkR32');
        const adjustedMmrText = adjustedMmrEl?.textContent?.trim();

        // Extract MMR Range ($36,700 - $40,300)
        const mmrRangeEl = document.querySelector('.styles__adjMMRRangeValue__fOTt5');
        const mmrRangeText = mmrRangeEl?.textContent?.trim();

        // Extract Estimated Retail Value
        const retailEl = document.querySelector('.styles__estimatedRetailValue__Wkxa3');
        const retailText = retailEl?.textContent?.trim();

        // Extract Typical Range (for retail)
        const typicalRangeEl = document.querySelector('.styles__adjTypicalRangeValue__rwVzw');
        const typicalRangeText = typicalRangeEl?.textContent?.trim();

        // Parse MMR Range into min and max
        let mmrRangeMin = null;
        let mmrRangeMax = null;
        if (mmrRangeText) {
            const prices = mmrRangeText.match(/\$[\d,]+/g);
            if (prices && prices.length >= 2) {
                mmrRangeMin = parseInt(prices[0].replace(/[$,]/g, ''));
                mmrRangeMax = parseInt(prices[1].replace(/[$,]/g, ''));
            }
        }

        return {
            mmr_base_usd: extractPrice(baseMmrText),
            mmr_adjusted_usd: extractPrice(adjustedMmrText),
            mmr_range_min_usd: mmrRangeMin,
            mmr_range_max_usd: mmrRangeMax,
            estimated_retail_usd: extractPrice(retailText),
            raw_data: {
                base_mmr_text: baseMmrText,
                adjusted_mmr_text: adjustedMmrText,
                mmr_range_text: mmrRangeText,
                retail_text: retailText,
                typical_range_text: typicalRangeText
            }
        };
    });

    console.log('  ✅ MMR values extracted:');
    console.log(`     • Base MMR: ${mmrData.mmr_base_usd ? '$' + mmrData.mmr_base_usd.toLocaleString() : 'NOT FOUND'}`);
    console.log(`     • Adjusted MMR: ${mmrData.mmr_adjusted_usd ? '$' + mmrData.mmr_adjusted_usd.toLocaleString() : 'NOT FOUND'}`);
    console.log(`     • MMR Range: ${mmrData.mmr_range_min_usd ? '$' + mmrData.mmr_range_min_usd.toLocaleString() : '?'} - ${mmrData.mmr_range_max_usd ? '$' + mmrData.mmr_range_max_usd.toLocaleString() : '?'}`);
    console.log(`     • Estimated Retail: ${mmrData.estimated_retail_usd ? '$' + mmrData.estimated_retail_usd.toLocaleString() : 'NOT FOUND'}`);

    return mmrData;
}

// ============================================
// MAIN SCRAPER
// ============================================

await Actor.main(async () => {
    const input = await Actor.getInput();

    const {
        manheimCookies = [],
        supabaseEdgeFunctionUrl = 'https://nyhpgaksdlmrclraqqmg.supabase.co/functions/v1/get-next-vin',
        n8nWebhookUrl = '',
        maxVINsPerRun = 100,
        delayBetweenVINs = [3000, 8000], // [min, max] in milliseconds
        proxyConfiguration = {
            useApifyProxy: true,
            apifyProxyGroups: ['RESIDENTIAL'],
            apifyProxyCountry: 'CA'
        }
    } = input;

    console.log('🚀 Starting Manheim MMR Scraper...');
    console.log(`📊 Max VINs per run: ${maxVINsPerRun}`);
    console.log(`⏱️ Delay between VINs: ${delayBetweenVINs[0]/1000}s - ${delayBetweenVINs[1]/1000}s`);

    // Validate inputs
    if (!manheimCookies || manheimCookies.length === 0) {
        throw new Error('❌ manheimCookies is required! Please provide your Manheim session cookies.');
    }

    if (!n8nWebhookUrl) {
        throw new Error('❌ n8nWebhookUrl is required! Please provide your n8n webhook URL.');
    }

    // Setup proxy configuration
    let proxyUrl = null;
    if (proxyConfiguration && proxyConfiguration.useApifyProxy) {
        const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
        proxyUrl = await proxyConfig.newUrl();

        console.log('🌍 Proxy Configuration:');
        console.log(`  ✅ Country: ${proxyConfiguration.apifyProxyCountry}`);
        console.log(`  ✅ Groups: ${proxyConfiguration.apifyProxyGroups.join(', ')}`);
        console.log(`  ✅ Proxy URL: ${proxyUrl.substring(0, 50)}...`);
    } else {
        console.log('🌍 No proxy - using direct connection');
    }

    // Launch browser with stealth
    const browser = await chromium.launch({
        headless: true,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-web-security',
        ],
    });

    const contextOptions = {
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        locale: 'en-CA', // Canadian locale
        timezoneId: 'America/Edmonton', // Alberta, Canada timezone (Mountain Time)
    };

    // Only add proxy if configured
    if (proxyUrl) {
        contextOptions.proxy = { server: proxyUrl };
    }

    const context = await browser.newContext(contextOptions);

    // Set default navigation timeout
    context.setDefaultNavigationTimeout(90000);

    // Inject cookies BEFORE navigating
    console.log('\n🍪 Injecting session cookies...');
    console.log(`  → Injecting ${manheimCookies.length} cookies`);

    // Group cookies by domain for debugging
    const cookiesByDomain = {};
    manheimCookies.forEach(cookie => {
        if (!cookiesByDomain[cookie.domain]) {
            cookiesByDomain[cookie.domain] = [];
        }
        cookiesByDomain[cookie.domain].push(cookie.name);
    });

    Object.entries(cookiesByDomain).forEach(([domain, names]) => {
        console.log(`  → ${domain}: ${names.join(', ')}`);
    });

    await context.addCookies(manheimCookies);
    console.log('  ✅ Cookies injected successfully');

    const page = await context.newPage();

    try {
        // STEP 1: Verify login by visiting Manheim main site
        console.log('\n🌐 STEP 1: Verifying Manheim session...');
        console.log('  → Navigating to: https://www.manheim.com/');

        await page.goto('https://www.manheim.com/', {
            waitUntil: 'domcontentloaded',
            timeout: 90000
        });
        console.log('  ✅ Page loaded (domcontentloaded)');

        console.log('  → Waiting 3-5 seconds...');
        await humanDelay(3000, 5000);

        console.log('  → Simulating mouse movement...');
        await simulateHumanMouse(page);

        // Check for CAPTCHA or blocking
        const homeBlocking = await detectCaptchaOrBlocking(page, 'Manheim home');
        if (homeBlocking.hasCaptcha || homeBlocking.hasRecaptcha || homeBlocking.hasCloudflare) {
            console.error('\n❌ CAPTCHA or challenge detected on home page!');
            await saveDiagnostics(page, 'home-blocked');
            throw new Error('CAPTCHA challenge detected - cannot proceed automatically');
        }
        if (homeBlocking.hasSessionExpired) {
            console.error('\n❌ Session expired detected!');
            await saveDiagnostics(page, 'home-session-expired');
            throw new Error('Session cookies expired - please extract fresh cookies');
        }

        console.log('✅ Manheim homepage loaded successfully');

        // STEP 2: Access MMR tool (optimized with smart fallback)
        console.log('\n📊 STEP 2: Accessing MMR tool...');
        console.log('  → Simulating mouse movement...');
        await simulateHumanMouse(page);
        await humanDelay(1000, 2000);

        let mmrPage = null;

        // IMPORTANT (changed 2026-07-10): Open the MMR tool by DIRECT NAVIGATION, not the
        // header button. Manheim changed their auth so the button's popup OAuth flow
        // (auth.manheim.com/as/authorization.oauth2) no longer performs silent SSO — it now
        // drops to a "Sign In" page even with valid, fresh session cookies. Loading the MMR
        // URL directly still authenticates via the session cookies and returns live MMR data
        // (verified end-to-end: getValuation VIN call → HTTP 200). The old button/popup path
        // is kept below (disabled) for reference only.
        console.log('  → Opening MMR tool via DIRECT navigation (popup OAuth flow no longer authenticates)...');
        mmrPage = await context.newPage();
        await mmrPage.goto('https://mmr.manheim.com/ui-mmr/?country=US&popup=true&source=man', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });
        console.log('  ✅ MMR tool opened via direct navigation');

        /* ---- DISABLED: legacy header-button + popup OAuth flow (broke 2026-07-10) ----
        try {
            const frames = page.frames();
            let headerFrame = frames.find(f => f.url().includes('mcom-header-footer'));
            const clickTarget = headerFrame
                ? headerFrame.locator('[data-test-id="mmr-btn"]').first()
                : page.locator('[data-test-id="mmr-btn"]').first();
            await clickTarget.waitFor({ state: 'visible', timeout: 10000 });
            const popupPromise = context.waitForEvent('page', {
                predicate: (p) => p.url().includes('mmr.manheim.com'),
                timeout: 10000
            }).catch(() => null);
            await clickTarget.hover();
            await clickTarget.click({ timeout: 10000 });
            mmrPage = await popupPromise;
        } catch (error) {
            mmrPage = await context.newPage();
            await mmrPage.goto('https://mmr.manheim.com/ui-mmr/?country=US&popup=true&source=man',
                { waitUntil: 'domcontentloaded', timeout: 30000 });
        }
        ------------------------------------------------------------------------------- */

        // Verify we have MMR page
        if (!mmrPage) {
            console.error('\n❌ Failed to open MMR tool!');
            await saveDiagnostics(page, 'mmr-open-failed');
            throw new Error('Could not access MMR tool - direct navigation failed');
        }

        console.log(`✅ MMR page ready: ${mmrPage.url()}`);

        // A healthy session 302-redirects the OAuth authorize URL straight into the MMR app.
        // If we're still on auth.manheim.com / an /oauth/ path, give SSO a chance to complete.
        if (mmrPage.url().includes('auth.manheim.com') || mmrPage.url().includes('/oauth/')) {
            console.log('  ⏳ Still on auth/OAuth domain — waiting up to 20s for SSO redirect into the MMR app...');
            await mmrPage.waitForURL(/mmr\.manheim\.com\/ui-mmr/, { timeout: 20000 })
                .then(() => console.log(`  ✅ Redirected into MMR app: ${mmrPage.url()}`))
                .catch(() => console.log(`  ⚠️ No SSO redirect — still at: ${mmrPage.url()}`));
        }

        console.log('  → Waiting for page to load...');
        await mmrPage.waitForLoadState('domcontentloaded').catch(() => {});
        await humanDelay(2000, 4000);

        // POSITIVE readiness check: the real MMR app exposes the VIN search box (#vinText).
        // This is far more reliable than keyword-based captcha guessing, which false-positives
        // on the "protected by reCAPTCHA" badge that ordinary login pages carry.
        console.log('  → Verifying MMR app loaded (looking for VIN search box #vinText)...');
        const mmrReady = await mmrPage.locator('#vinText').first()
            .waitFor({ state: 'visible', timeout: 15000 })
            .then(() => true)
            .catch(() => false);

        // Run detailed detection AND always capture a full diagnostic bundle at this checkpoint.
        const mmrBlocking = await detectCaptchaOrBlocking(mmrPage, 'MMR tool');
        await saveDiagnostics(mmrPage, mmrReady ? 'mmr-ready' : 'mmr-NOT-ready');

        if (!mmrReady) {
            const d = mmrBlocking.details || {};
            const url = mmrPage.url();
            let classification;
            if (d.recaptchaWidget) {
                classification = 'A real INTERACTIVE reCAPTCHA challenge is present on the page.';
            } else if (d.hasPasswordField || url.includes('auth.manheim.com')) {
                classification = 'Landed on a LOGIN page — the SSO session cookie was NOT honored. '
                    + 'This is almost certainly NOT a captcha: the injected cookies are insufficient/expired '
                    + 'for the auth.manheim.com OAuth flow, or Manheim changed the auth flow.';
            } else {
                classification = 'Unknown page — the MMR app did not load and no login/captcha signature matched. '
                    + 'Manheim may have changed the page layout or the #vinText selector.';
            }

            console.error('\n❌ MMR app did NOT load. Diagnosis:');
            console.error(`   • Final URL:                 ${url}`);
            console.error(`   • Page title:                ${d.title || 'unknown'}`);
            console.error(`   • Password field present:    ${!!d.hasPasswordField}`);
            console.error(`   • Interactive reCAPTCHA:     ${!!d.recaptchaWidget}`);
            console.error(`   • Passive reCAPTCHA badge:   ${!!d.recaptchaBadgeOnly}`);
            console.error(`   • #vinText (MMR box) present: ${!!d.hasVinBox}`);
            console.error(`   → ${classification}`);
            console.error('   📸 Full screenshot + HTML + page text saved to the key-value store (keys starting "DIAG-mmr-NOT-ready-...").');

            throw new Error(`MMR app failed to load — ${classification}`);
        }

        console.log('✅ MMR app is ready (VIN search box present)');

        // STEP 3: Process VINs from Supabase
        let vinsProcessed = 0;
        let vinsSuccessful = 0;
        let vinsFailed = 0;

        console.log(`\n${'='.repeat(60)}`);
        console.log(`🔄 Starting VIN processing loop (max: ${maxVINsPerRun})`);
        console.log(`${'='.repeat(60)}\n`);

        while (vinsProcessed < maxVINsPerRun) {
            // --- Fetch next VIN (resilient) -----------------------------------------
            // The Supabase edge function occasionally returns an HTML error page
            // (gateway/cold-start/5xx) instead of JSON. Retry a few times, then end the
            // run cleanly rather than crashing — the next scheduled run picks up where we left off.
            let vinData = null;
            let vinFetchFailed = false;
            for (let attempt = 1; attempt <= 3; attempt++) {
                console.log(`\n📞 STEP 3.${vinsProcessed + 1}: Fetching VIN from Supabase...${attempt > 1 ? ` (retry ${attempt}/3)` : ''}`);
                console.log(`  → URL: ${supabaseEdgeFunctionUrl}`);
                try {
                    const vinResponse = await fetch(supabaseEdgeFunctionUrl);
                    const rawBody = await vinResponse.text();
                    if (!vinResponse.ok) {
                        throw new Error(`HTTP ${vinResponse.status}: ${rawBody.slice(0, 150).replace(/\s+/g, ' ').trim()}`);
                    }
                    try {
                        vinData = JSON.parse(rawBody);
                    } catch {
                        throw new Error(`Non-JSON response (transient gateway/HTML error): ${rawBody.slice(0, 150).replace(/\s+/g, ' ').trim()}`);
                    }
                    break; // got valid JSON
                } catch (fetchErr) {
                    console.log(`  ⚠️ VIN fetch failed: ${fetchErr.message}`);
                    if (attempt < 3) {
                        const backoffMs = attempt * 4000;
                        console.log(`  ⏳ Retrying in ${(backoffMs / 1000).toFixed(0)}s...`);
                        await humanDelay(backoffMs, backoffMs + 1000);
                    } else {
                        vinFetchFailed = true;
                    }
                }
            }

            if (vinFetchFailed) {
                console.log('  ⚠️ Could not fetch a VIN after 3 attempts (Supabase likely returning errors). Ending run cleanly — the next scheduled run will retry.');
                break;
            }

            if (!vinData.success || !vinData.data) {
                console.log('  ✅ No more pending VINs. Scraping complete!');
                break;
            }

            try {
                const {
                    id: listing_id,
                    vin,
                    trim,
                    cargurus_price_cad,
                    cargurus_mileage_km,
                    mileage_miles
                } = vinData.data;

                console.log(`\n${'='.repeat(60)}`);
                console.log(`🚗 Processing VIN #${vinsProcessed + 1}: ${vin}`);
                console.log(`📍 Listing ID: ${listing_id}`);
                console.log(`🎨 Trim: ${trim || 'Not specified'}`);
                console.log(`💰 CarGurus Price: $${cargurus_price_cad} CAD`);
                console.log(`🛣️ Mileage: ${cargurus_mileage_km} km (${mileage_miles} mi)`);
                console.log(`${'='.repeat(60)}\n`);

                // Check and close any leftover modal before processing VIN
                const modalOpen = await mmrPage.evaluate(() => {
                    const modal = document.querySelector('.styles__overlay__jMJmy.show--inline-block');
                    if (modal) {
                        const closeButton = modal.querySelector('.styles__close__uf9p4');
                        if (closeButton) {
                            closeButton.click();
                            return true;
                        }
                    }
                    return false;
                });

                if (modalOpen) {
                    console.log('  🧹 Closed leftover modal from previous VIN');
                    await humanDelay(1000, 2000);
                }

                // STEP 4: Input VIN and search
                console.log('🔍 STEP 4: Searching VIN in MMR...');
                console.log('  → Simulating mouse movement...');
                await simulateHumanMouse(mmrPage);
                await humanDelay(1000, 2000);

                // Clear existing input if any
                console.log('  → Clearing VIN input field...');
                const vinInput = mmrPage.locator('#vinText');
                await vinInput.clear();
                await humanDelay(300, 600);

                // Type VIN human-like
                console.log(`  ⌨️ Typing VIN: ${vin}...`);
                await humanTypeVIN(mmrPage, '#vinText', vin);
                console.log('  ✅ VIN typed');

                // Click search button
                console.log('  → Clicking search button [aria-label="Search VIN"]...');
                await simulateHumanMouse(mmrPage);
                const searchButton = mmrPage.locator('button[aria-label="Search VIN"]');
                await searchButton.click({ timeout: 30000 });
                console.log('  ✅ Search button clicked');

                // Wait for results to load
                console.log('  ⏳ Waiting 4-7 seconds for results...');
                await humanDelay(4000, 7000);

                // Check if VIN was found (improved detection)
                const pageStatus = await mmrPage.evaluate(() => {
                    const errorText = document.body.textContent.toLowerCase();
                    const hasErrorMessage = errorText.includes('no data found') ||
                                          errorText.includes('vin not found') ||
                                          errorText.includes('invalid vin') ||
                                          errorText.includes('no results') ||
                                          errorText.includes('not available');

                    // Also check if odometer input exists (if not, likely VIN not found)
                    const hasOdometerInput = !!document.querySelector('input#Odometer');

                    return {
                        vinNotFound: hasErrorMessage || !hasOdometerInput,
                        hasOdometerInput: hasOdometerInput,
                        errorMessage: hasErrorMessage
                    };
                });

                if (pageStatus.vinNotFound) {
                    const reason = pageStatus.errorMessage
                        ? 'VIN not found in MMR database (error message detected)'
                        : 'VIN not found in MMR database (odometer input missing)';

                    console.log(`⚠️ ${reason}`);

                    // Send to webhook with status
                    await fetch(n8nWebhookUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            listing_id,
                            vin,
                            trim,
                            cargurus_price_cad,
                            cargurus_mileage_km,
                            mileage_miles,
                            mmr_status: 'vin_not_found',
                            error: reason
                        })
                    });

                    vinsFailed++;
                    vinsProcessed++;
                    continue;
                }

                // STEP 4.5: Handle multiple vehicle styles modal (if it appears)
                console.log('\n🔍 Checking for vehicle style selection modal...');
                const modalExists = await mmrPage.evaluate(() => {
                    const modal = document.querySelector('.styles__overlay__jMJmy.show--inline-block');
                    return !!modal;
                });

                if (modalExists) {
                    console.log('  ✅ Modal detected! Multiple vehicle styles found.');

                    // Try to match by trim FIRST, then fallback to mileage
                    const selectionResult = await mmrPage.evaluate(({ vehicleTrim, targetMileage }) => {
                        const rows = document.querySelectorAll('.styles__tableContainer__At0ta tbody tr');
                        let bestIndex = 0;
                        let matchStrategy = 'mileage'; // default fallback
                        let smallestDiff = Infinity;
                        let matchedStyle = '';

                        // LOG: Show all available styles for debugging
                        const availableStyles = [];
                        rows.forEach((row, index) => {
                            const styleCell = row.cells[3];
                            if (styleCell) {
                                availableStyles.push(`${index + 1}. ${styleCell.textContent.trim()}`);
                            }
                        });

                        // Helper: Normalize text for smart matching
                        const normalize = (text) => {
                            return text
                                .toUpperCase()
                                .replace(/2-DOOR/gi, '2DR')
                                .replace(/4-DOOR/gi, '4DR')
                                .replace(/2 DOOR/gi, '2DR')
                                .replace(/4 DOOR/gi, '4DR')
                                .replace(/4WD/gi, '4X4')
                                .replace(/AWD/gi, '4X4')
                                .replace(/FWD/gi, '2WD')
                                .replace(/[-_]/g, ' ') // Replace dashes/underscores with spaces
                                .replace(/\s+/g, ' ')  // Collapse multiple spaces
                                .trim();
                        };

                        // STRATEGY 1: Simple includes match (works most of the time)
                        if (vehicleTrim && vehicleTrim.trim() !== '') {
                            const trimUpper = vehicleTrim.trim().toUpperCase();

                            for (let index = 0; index < rows.length; index++) {
                                const row = rows[index];
                                const styleCell = row.cells[3];
                                if (!styleCell) continue;

                                const styleText = styleCell.textContent.trim().toUpperCase();

                                if (styleText.includes(trimUpper)) {
                                    bestIndex = index;
                                    matchStrategy = 'trim-exact';
                                    matchedStyle = styleCell.textContent.trim();
                                    break;
                                }
                            }
                        }

                        // STRATEGY 2: Smart keyword matching (for edge cases like "Sport 2-Door 4WD")
                        if (matchStrategy === 'mileage' && vehicleTrim && vehicleTrim.trim() !== '') {
                            const normalizedTrim = normalize(vehicleTrim);
                            const trimKeywords = normalizedTrim.split(' ').filter(k => k.length > 1); // Min 2 chars

                            let bestScore = 0;
                            let bestSmartIndex = 0;
                            let bestSmartStyle = '';

                            rows.forEach((row, index) => {
                                const styleCell = row.cells[3];
                                if (!styleCell) return;

                                const styleText = styleCell.textContent.trim();
                                const normalizedStyle = normalize(styleText);

                                // Count how many keywords match
                                let score = 0;
                                trimKeywords.forEach(keyword => {
                                    if (normalizedStyle.includes(keyword)) {
                                        score++;
                                    }
                                });

                                // Need at least 50% of keywords to match
                                const minScore = Math.ceil(trimKeywords.length / 2);
                                if (score >= minScore && score > bestScore) {
                                    bestScore = score;
                                    bestSmartIndex = index;
                                    bestSmartStyle = styleText;
                                }
                            });

                            if (bestScore > 0) {
                                bestIndex = bestSmartIndex;
                                matchStrategy = 'trim-smart';
                                matchedStyle = bestSmartStyle;
                            }
                        }

                        // STRATEGY 2.5: Reverse keyword matching (modal keywords → trim)
                        if (matchStrategy === 'mileage' && vehicleTrim && vehicleTrim.trim() !== '') {
                            const normalizedTrim = normalize(vehicleTrim);

                            // Common words to ignore (appear in almost all styles)
                            const ignoreWords = ['SUV', '4D', '2D', 'DOOR', 'DR', 'SEDAN', 'WAGON', 'TRUCK', 'CAB', 'CREW', 'EXTENDED', 'REGULAR', 'QUAD', 'KING', 'DOUBLE'];

                            let bestReverseScore = 0;
                            let bestReverseIndex = 0;
                            let bestReverseStyle = '';

                            rows.forEach((row, index) => {
                                const styleCell = row.cells[3];
                                if (!styleCell) return;

                                const styleText = styleCell.textContent.trim();
                                const normalizedStyle = normalize(styleText);

                                // Extract meaningful keywords from modal style
                                const styleKeywords = normalizedStyle
                                    .split(' ')
                                    .filter(k => k.length > 2 && !ignoreWords.includes(k)); // Min 3 chars, not in ignore list

                                if (styleKeywords.length === 0) return;

                                // Count how many modal keywords are found in the trim
                                let reverseScore = 0;
                                styleKeywords.forEach(keyword => {
                                    if (normalizedTrim.includes(keyword)) {
                                        reverseScore++;
                                    }
                                });

                                // Need at least 1 significant keyword match
                                if (reverseScore > 0 && reverseScore > bestReverseScore) {
                                    bestReverseScore = reverseScore;
                                    bestReverseIndex = index;
                                    bestReverseStyle = styleText;
                                }
                            });

                            if (bestReverseScore > 0) {
                                bestIndex = bestReverseIndex;
                                matchStrategy = 'trim-reverse';
                                matchedStyle = bestReverseStyle;
                            }
                        }

                        // STRATEGY 3: Fallback to closest mileage
                        if (matchStrategy === 'mileage') {
                            rows.forEach((row, index) => {
                                const avgOdoCell = row.cells[5]; // Avg Odo column
                                if (!avgOdoCell) return;

                                const mileageText = avgOdoCell.textContent.trim().replace(/,/g, '');
                                const mileage = parseInt(mileageText);

                                if (!isNaN(mileage)) {
                                    const diff = Math.abs(mileage - targetMileage);
                                    if (diff < smallestDiff) {
                                        smallestDiff = diff;
                                        bestIndex = index;
                                    }
                                }
                            });

                            // Get the matched style for mileage fallback
                            const selectedRow = rows[bestIndex];
                            if (selectedRow && selectedRow.cells[3]) {
                                matchedStyle = selectedRow.cells[3].textContent.trim();
                            }
                        }

                        return { bestIndex, matchStrategy, matchedStyle, availableStyles };
                    }, { vehicleTrim: trim, targetMileage: mileage_miles });

                    const { bestIndex: bestRowIndex, matchStrategy, matchedStyle, availableStyles } = selectionResult;

                    // Log available styles
                    console.log(`  📋 Available styles in modal:`);
                    availableStyles.forEach(style => {
                        console.log(`     ${style}`);
                    });

                    // Log match result
                    if (matchStrategy === 'trim-exact') {
                        console.log(`  🎯 Exact trim match! Database: "${trim}" → MMR: "${matchedStyle}"`);
                    } else if (matchStrategy === 'trim-smart') {
                        console.log(`  🧠 Smart keyword match! Database: "${trim}" → MMR: "${matchedStyle}"`);
                    } else if (matchStrategy === 'trim-reverse') {
                        console.log(`  🔄 Reverse keyword match! Database: "${trim}" → MMR: "${matchedStyle}"`);
                    } else {
                        console.log(`  ⚠️ No trim match found for "${trim || 'N/A'}"`);
                        console.log(`  → Fallback: Selected by closest mileage (${mileage_miles} mi) → "${matchedStyle}"`);
                    }
                    console.log(`  → Selected: Row ${bestRowIndex + 1}`);

                    // Click the selected row
                    await mmrPage.evaluate((rowIndex) => {
                        const rows = document.querySelectorAll('.styles__tableContainer__At0ta tbody tr');
                        if (rows[rowIndex]) {
                            rows[rowIndex].click();
                        }
                    }, bestRowIndex);

                    console.log('  ✅ Style selected');

                    // Wait for modal to close and page to update
                    await humanDelay(2000, 3000);
                } else {
                    console.log('  → No modal - single vehicle style');
                }

                // STEP 5: Input mileage to get adjusted MMR
                console.log(`\n📏 STEP 5: Inputting mileage for adjusted MMR...`);
                console.log(`  → Target mileage: ${mileage_miles} miles`);

                // Wait for odometer field to appear
                console.log('  → Waiting for odometer input field...');
                await mmrPage.waitForSelector('input#Odometer', { timeout: 10000 });
                console.log('  ✅ Odometer input found');
                await humanDelay(1000, 2000);

                // Click the input field
                console.log('  → Clicking odometer input...');
                const odometerInput = mmrPage.locator('input#Odometer');
                await odometerInput.click();
                await humanDelay(300, 600);

                // Clear any existing value
                console.log('  → Clearing existing value...');
                await odometerInput.fill('');
                await humanDelay(300, 600);

                // Type mileage character by character (human-like)
                console.log(`  ⌨️ Typing mileage: ${mileage_miles}...`);
                for (const char of mileage_miles.toString()) {
                    await mmrPage.keyboard.type(char);
                    await humanDelay(80, 200);
                }
                console.log('  ✅ Mileage typed');

                // Click the submit button (checkmark icon)
                console.log('  → Clicking submit button [aria-label="Submit odo"]...');
                const submitButton = mmrPage.locator('button[aria-label="Submit odo"]');
                await submitButton.click();
                console.log('  ✅ Submit button clicked');

                // Wait for MMR to recalculate with adjusted mileage
                console.log('  ⏳ Waiting 4-6 seconds for MMR to recalculate...');
                await humanDelay(4000, 6000);

                // STEP 6: Extract MMR values (now adjusted for mileage)
                console.log('\n📊 STEP 6: Extracting MMR values...');
                const mmrValues = await extractMMRValues(mmrPage);

                // Validate that we got data
                if (!mmrValues.mmr_base_usd) {
                    console.log('⚠️ Failed to extract MMR values');
                    vinsFailed++;
                    vinsProcessed++;
                    continue;
                }

                // Capture the MMR dashboard URL for this vehicle
                const mmrDashboardUrl = mmrPage.url();
                console.log(`  → MMR Dashboard URL: ${mmrDashboardUrl}`);

                // STEP 7: Send to n8n webhook
                console.log('\n📤 STEP 7: Sending data to n8n webhook...');
                const webhookPayload = {
                    listing_id,
                    vin,
                    trim,
                    mmr_base_usd: mmrValues.mmr_base_usd,
                    mmr_adjusted_usd: mmrValues.mmr_adjusted_usd,
                    mmr_range_min_usd: mmrValues.mmr_range_min_usd,
                    mmr_range_max_usd: mmrValues.mmr_range_max_usd,
                    estimated_retail_usd: mmrValues.estimated_retail_usd,
                    mmr_dashboard_url: mmrDashboardUrl,
                    cargurus_price_cad,
                    cargurus_mileage_km,
                    mileage_miles
                };

                console.log(`  → URL: ${n8nWebhookUrl}`);
                console.log(`  → Payload: ${JSON.stringify(webhookPayload, null, 2)}`);

                const webhookResponse = await fetch(n8nWebhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(webhookPayload)
                });

                if (webhookResponse.ok) {
                    console.log(`  ✅ Webhook sent successfully (${webhookResponse.status})`);
                    vinsSuccessful++;
                } else {
                    console.log(`  ⚠️ Webhook failed (${webhookResponse.status})`);
                    vinsFailed++;
                }

                vinsProcessed++;

                // Human-like delay between VINs
                if (vinsProcessed < maxVINsPerRun) {
                    const delayTime = Math.random() * (delayBetweenVINs[1] - delayBetweenVINs[0]) + delayBetweenVINs[0];
                    console.log(`\n⏸️ Waiting ${(delayTime/1000).toFixed(1)}s before next VIN...`);
                    await humanDelay(delayTime, delayTime + 1000);

                    // Simulate some human activity during wait
                    await simulateHumanScroll(mmrPage);
                    await simulateHumanMouse(mmrPage);
                }

            } catch (vinError) {
                console.error(`❌ Error processing VIN:`, vinError.message);
                // Capture exactly what the page looked like at the moment of failure.
                // NOTE: use vinData?.data?.vin (loop scope) — `vin` is block-scoped to the try
                // and would itself throw "vin is not defined" if the error hit before it was set.
                await saveDiagnostics(mmrPage, `vin-error-${vinData?.data?.vin || 'unknown'}`);
                vinsFailed++;
                vinsProcessed++;

                // CRITICAL: Refresh the page to recover from error state
                console.log('  🔄 Refreshing MMR tool to recover from error...');
                try {
                    await mmrPage.goto('https://mmr.manheim.com/ui-mmr/?country=US&popup=true&source=man', {
                        waitUntil: 'domcontentloaded',
                        timeout: 30000
                    });
                    await humanDelay(3000, 4000);
                    console.log('  ✅ MMR tool refreshed and ready');
                } catch (refreshError) {
                    console.error('  ⚠️ Failed to refresh page:', refreshError.message);
                }

                // Wait before next VIN
                await humanDelay(2000, 3000);
            }
        }

        // STEP 8: Summary
        console.log(`\n${'='.repeat(60)}`);
        console.log('📊 SCRAPING SUMMARY');
        console.log(`${'='.repeat(60)}`);
        console.log(`✅ Total VINs processed: ${vinsProcessed}`);
        console.log(`✅ Successful: ${vinsSuccessful}`);
        console.log(`❌ Failed: ${vinsFailed}`);
        console.log(`${'='.repeat(60)}\n`);

    } catch (error) {
        console.error('❌ Fatal error:', error.message);
        throw error;
    }

    await browser.close();
    console.log('✅ Scraper completed successfully!');
});

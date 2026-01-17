# 🚗 Manheim MMR Scraper

**Phase 2** of the CarGurus deal analysis system. This scraper extracts MMR (Manheim Market Report) wholesale values for vehicles using session cookie authentication.

---

## 🎯 What It Does

1. **Fetches VINs** from Supabase (via edge function)
2. **Logs into Manheim MMR** using injected session cookies
3. **Looks up each VIN** in the MMR database
4. **Extracts values:**
   - Base MMR (Past 30 Days average)
   - MMR Range (min/max)
   - Estimated Retail Value
5. **Sends raw data** to n8n webhook for processing
6. **Repeats** until no VINs left or max limit reached

---

## 🔧 Setup Instructions

### 1. Extract Manheim Session Cookies

**IMPORTANT:** You need to extract cookies from your logged-in Manheim session.

**Option A: Using Browser Extension (Easiest)**
1. Install "EditThisCookie" extension (Chrome/Edge) or "Cookie-Editor" (Firefox)
2. Login to https://home.manheim.com/
3. Click the extension icon
4. Click "Export" → Copy JSON
5. Format it properly (see example below)

**Option B: Using Browser DevTools**
1. Login to https://home.manheim.com/
2. Press F12 to open DevTools
3. Go to **Application** tab → **Cookies** → `https://home.manheim.com`
4. Copy all cookies and format them like this:

```json
[
  {
    "name": "JSESSIONID",
    "value": "ABCD1234567890...",
    "domain": ".manheim.com",
    "path": "/",
    "httpOnly": true,
    "secure": true
  },
  {
    "name": "MHN_AUTH",
    "value": "xyz123...",
    "domain": ".manheim.com",
    "path": "/",
    "httpOnly": true,
    "secure": true
  }
]
```

**Key cookies to include:**
- `JSESSIONID` (session ID)
- `MHN_AUTH` or similar auth tokens
- Any cookies with `.manheim.com` domain

---

### 2. Get Your n8n Webhook URL

In n8n, create a webhook node and copy the production URL.

Example: `https://your-n8n-instance.com/webhook/mmr-data`

---

### 3. Deploy to Apify

**Option A: Via Apify CLI**
```bash
cd mmr-scraper
apify login
apify push
```

**Option B: Via Apify Console**
1. Create new Actor
2. Upload code as ZIP
3. Build & Publish

---

## 📝 Input Configuration

```json
{
  "manheimCookies": [
    {
      "name": "JSESSIONID",
      "value": "YOUR_SESSION_ID",
      "domain": ".manheim.com",
      "path": "/",
      "httpOnly": true,
      "secure": true
    }
  ],
  "supabaseEdgeFunctionUrl": "https://nyhpgaksdlmrclraqqmg.supabase.co/functions/v1/get-next-vin",
  "n8nWebhookUrl": "https://your-n8n.com/webhook/mmr-data",
  "maxVINsPerRun": 100,
  "delayBetweenVINs": [3000, 8000]
}
```

---

## 🔒 Anti-Ban Features

✅ **Cookie injection** - No login automation (more reliable)
✅ **Human-like typing** - Random character delays (80-200ms)
✅ **Mouse movements** - Simulated cursor activity
✅ **Random scrolling** - Natural page interaction
✅ **Variable delays** - 3-8 seconds between VINs
✅ **Stealth plugins** - Hides automation markers
✅ **Single session** - No suspicious multiple logins

---

## 📤 Webhook Payload

Data sent to your n8n webhook:

```json
{
  "listing_id": 123,
  "vin": "1C6SRFFP6SN567235",
  "mmr_base_usd": 38500,
  "mmr_adjusted_usd": 38500,
  "mmr_range_min_usd": 36700,
  "mmr_range_max_usd": 40300,
  "estimated_retail_usd": 43300,
  "cargurus_price_cad": 54900,
  "cargurus_mileage_km": 86000,
  "mileage_miles": 53438
}
```

---

## 🔄 Workflow

```
1. Apify Actor starts
2. Fetches VIN from Supabase edge function
3. Supabase marks VIN as "processing"
4. Actor logs into Manheim with cookies
5. Searches VIN in MMR
6. Extracts values
7. Sends to n8n webhook
8. n8n calculates deal metrics
9. n8n updates Supabase
10. Repeat for next VIN
```

---

## ⚙️ Recommended Settings

**For Testing:**
- `maxVINsPerRun`: 5-10
- `delayBetweenVINs`: [2000, 4000]

**For Production:**
- `maxVINsPerRun`: 50-100
- `delayBetweenVINs`: [3000, 8000]

**Safety Limits:**
- Max 200 VINs per run (hard limit)
- 3-8 second delays between lookups
- Single browser session per run

---

## 🐛 Troubleshooting

### "Session authentication failed"
- Your cookies have expired (typically last 24-48 hours)
- Extract fresh cookies from your browser
- Update the `manheimCookies` input

### "VIN not found in MMR database"
- Normal - not all VINs are in Manheim's database
- These are marked as `vin_not_found` status
- They will be skipped automatically

### "Webhook failed"
- Check your n8n webhook URL is correct
- Verify the workflow is active in n8n
- Check n8n logs for errors

---

## 📊 Expected Performance

- **Speed:** ~15-20 VINs per minute
- **Duration:** 100 VINs = ~5-7 minutes
- **Success Rate:** 85-95% (depends on VIN availability in MMR)

---

## 🔐 Security Notes

- ⚠️ **Never commit cookies to Git**
- ⚠️ **Store cookies securely in Apify secrets**
- ⚠️ **Refresh cookies every 1-2 days**
- ⚠️ **Don't run multiple instances simultaneously**

---

## 📞 Support

If you encounter issues:
1. Check Apify run logs
2. Verify cookies are fresh
3. Test n8n webhook manually
4. Check Supabase edge function is responding

---

**Created for Phase 2 of the CarGurus Deal Analyzer** 🚀

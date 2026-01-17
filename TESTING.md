# 🧪 Testing Guide - MMR Scraper

## 🎯 Goal: Get ONE successful MMR lookup working end-to-end

---

## ✅ Pre-Test Checklist

### 1. Verify Supabase Setup
Run this query to check you have test data:

```sql
SELECT id, vin, price, mileage, mmr_status
FROM car_listings
WHERE mmr_status = 'pending'
AND vin IS NOT NULL
LIMIT 5;
```

**Expected:** At least 1 row with a valid VIN

---

### 2. Test Supabase Edge Function

```bash
curl https://nyhpgaksdlmrclraqqmg.supabase.co/functions/v1/get-next-vin
```

**Expected Response:**
```json
{
  "success": true,
  "message": "VIN retrieved successfully",
  "data": {
    "id": 123,
    "vin": "1C6SRFFP6SN567235",
    "cargurus_price_cad": 54900,
    "cargurus_mileage_km": 86000,
    "mileage_miles": 53438
  }
}
```

**If you get "No pending VINs":**
- You need to manually set at least one listing's `mmr_status = 'pending'` in Supabase
- Make sure it has a valid VIN

---

### 3. Test n8n Webhook

```bash
curl -X POST https://n8n-production-0d7d.up.railway.app/webhook/MMR \
  -H "Content-Type: application/json" \
  -d '{
    "listing_id": 999,
    "vin": "TEST123456789",
    "mmr_base_usd": 38500,
    "mmr_adjusted_usd": 38500,
    "mmr_range_min_usd": 36700,
    "mmr_range_max_usd": 40300,
    "estimated_retail_usd": 43300,
    "cargurus_price_cad": 54900,
    "cargurus_mileage_km": 86000,
    "mileage_miles": 53438
  }'
```

**Expected:** Status 200 OK (or whatever your n8n workflow returns)

---

## 🚀 Test Run #1 - Single VIN

### Option A: Deploy to Apify (Recommended)

1. **Push to Apify:**
   ```bash
   cd mmr-scraper
   apify push
   ```

2. **Run on Apify:**
   - Go to Apify Console
   - Find "manheim-mmr-scraper" actor
   - Click "Try it"
   - Use the input from `input.test.json` (already configured for 1 VIN)
   - Click "Start"

3. **Watch the logs:**
   ```
   🚀 Starting Manheim MMR Scraper...
   🍪 Injecting session cookies...
   🌐 Verifying Manheim session...
   ✅ Session verified!
   📊 Opening MMR tool...
   ✅ MMR page loaded
   📞 Fetching VIN #1 from Supabase...
   🚗 Processing VIN #1: 1C6SRFFP6SN567235
   ⌨️ Typing VIN...
   🔍 Clicking search button...
   ⏳ Waiting for MMR results...
   📊 Extracting MMR values from page...
     MMR Base (USD): 38500
     MMR Range: $36700 - $40300
     Estimated Retail (USD): 43300
   📤 Sending data to n8n webhook...
   ✅ Webhook sent successfully (200)
   ```

---

### Option B: Local Test (if you want to debug)

```bash
cd mmr-scraper
npm install
npm start
```

---

## 🔍 What to Check

### ✅ **Success Indicators:**

1. **Scraper logs show:**
   - ✅ Session verified
   - ✅ MMR values extracted
   - ✅ Webhook sent (200)

2. **Supabase shows:**
   - Listing `mmr_status` changed from `'pending'` → `'completed'`
   - MMR values populated (mmr_base_usd, mmr_range_min_usd, etc.)

3. **n8n logs show:**
   - Webhook received
   - Calculations performed
   - Database updated

---

## ❌ **Common Issues:**

### "Session authentication failed"
**Cause:** Cookies expired
**Fix:** Extract fresh cookies from browser and update input

### "No pending VINs found"
**Cause:** No listings with `mmr_status = 'pending'` in database
**Fix:** Manually update at least one listing:
```sql
UPDATE car_listings
SET mmr_status = 'pending'
WHERE vin IS NOT NULL
LIMIT 1;
```

### "VIN not found in MMR database"
**Cause:** The VIN doesn't exist in Manheim's database (normal for some cars)
**Fix:** Try a different VIN, or accept that some VINs won't have MMR data

### "Webhook failed"
**Cause:** n8n workflow not active or URL wrong
**Fix:** Check n8n workflow is active and webhook URL is correct

---

## 📊 After Successful Test

Once you see:
```
✅ Total VINs processed: 1
✅ Successful: 1
❌ Failed: 0
```

And Supabase shows the updated MMR values, **you're ready for production!**

---

## 🎯 Next Steps After Test

1. **If test passed:**
   - Update `maxVINsPerRun` to 50-100 in production input
   - Schedule actor to run periodically on Apify
   - Monitor first few production runs

2. **If test failed:**
   - Check logs carefully
   - Verify each step (Supabase, Manheim login, n8n)
   - Share error logs for debugging

---

## 🔄 Production Schedule Recommendation

Once tested:
- Run every 2-4 hours
- Process 50-100 VINs per run
- Monitor success rate (should be 85-95%)
- Refresh cookies daily

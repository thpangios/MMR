# ✅ Pre-Deployment Checklist

## Before you deploy the MMR scraper to Apify, verify these items:

---

### 1. ✅ **Supabase Database Ready**

**Run this SQL to check:**
```sql
-- Check Phase 2 columns exist
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'car_listings'
AND column_name IN ('mmr_status', 'mmr_base_usd', 'mmr_range_min_usd');
```

**Expected:** 3 rows (means migration was successful)

---

### 2. ✅ **Test Data Exists**

**Run this SQL:**
```sql
-- Check you have listings ready for MMR analysis
SELECT COUNT(*) as pending_count
FROM car_listings
WHERE mmr_status = 'pending'
AND vin IS NOT NULL;
```

**Expected:** At least 1 row

**If 0 rows:** Update some listings to pending:
```sql
UPDATE car_listings
SET mmr_status = 'pending'
WHERE vin IS NOT NULL
LIMIT 10;
```

---

### 3. ✅ **Supabase Edge Function Works**

**Test with curl:**
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

---

### 4. ✅ **n8n Webhook is Active**

**URL:** `https://n8n-production-0d7d.up.railway.app/webhook/MMR`

**Test with curl:**
```bash
curl -X POST https://n8n-production-0d7d.up.railway.app/webhook/MMR \
  -H "Content-Type: application/json" \
  -d '{"vin":"TEST","mmr_base_usd":38500}'
```

**Expected:** HTTP 200 (or your n8n configured response)

---

### 5. ✅ **Manheim Cookies Fresh**

Your cookies in `input.test.json`:
- SESSION: `NDA5ZGFmMTUtNTM2OC00OTMyLWE3NjktYjBiZjMxMjU0MDFi`
- session: `eyJhc3NvY2lhdGVkVG9rZW5z...`
- session.sig: `BPzqO3V4fHW_zRIo6OqqWrJyIms`

**⚠️ These expire tomorrow!**

Test if still valid by visiting:
https://home.manheim.com/landingPage#/

If redirected to login → Extract fresh cookies!

---

### 6. ✅ **Scraper Files Complete**

**Check these files exist:**
```
mmr-scraper/
├── src/main.js              ✅
├── package.json             ✅
├── Dockerfile               ✅
├── .actor/actor.json        ✅
├── .actor/input_schema.json ✅
├── input.test.json          ✅ (for testing)
├── input.example.json       ✅ (for production)
└── README.md                ✅
```

---

## 🚀 Ready to Deploy?

If all items above are ✅:

### **Step 1: Deploy to Apify**
```bash
cd mmr-scraper
apify login
apify push
```

### **Step 2: Test Run (1 VIN)**
- Go to Apify Console
- Find actor "manheim-mmr-scraper"
- Use input from `input.test.json`
- Click "Start"
- Watch logs

### **Step 3: Verify Results**
Check Supabase:
```sql
SELECT vin, mmr_status, mmr_base_usd, mmr_range_min_usd, mmr_range_max_usd
FROM car_listings
WHERE mmr_status = 'completed'
ORDER BY mmr_analyzed_at DESC
LIMIT 1;
```

### **Step 4: Production Run**
If test passed:
- Update `maxVINsPerRun` to 50-100
- Schedule runs every 2-4 hours
- Monitor logs for first few runs

---

## 📝 Notes

- Cookie lifespan: ~24-48 hours (refresh daily)
- Processing speed: ~15-20 VINs per minute
- Recommended batch size: 50-100 VINs per run
- Recommended schedule: Every 2-4 hours

---

## 🆘 If Something Fails

1. Check Apify logs
2. Verify all checklist items again
3. Test each component individually (Supabase, n8n, Manheim)
4. Share error logs for debugging

---

**Last Updated:** Ready for deployment with your credentials ✅

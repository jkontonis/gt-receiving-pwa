#!/usr/bin/env bash
# Seed the G&T Chickens product + supplier catalogue.
#
# Usage:  ADMIN_PIN=yourpin ./seed_catalogue.sh
# (the PIN is read from your shell env — never hard-code it in this file)
#
# Safe to re-run: products/suppliers upsert on name (ON CONFLICT DO UPDATE).

set -euo pipefail
BASE="${BASE:-https://gt-receiving-pwa.vercel.app}"
: "${ADMIN_PIN:?Set ADMIN_PIN in your environment, e.g. ADMIN_PIN=1234 ./seed_catalogue.sh}"

H_JSON='-H Content-Type:application/json'
H_PIN="-H X-Admin-PIN:${ADMIN_PIN}"

sup() {  # name code
  curl -s -X POST "$BASE/api/suppliers" $H_JSON $H_PIN \
    -d "{\"name\":\"$1\",\"code\":\"$2\",\"status\":\"Active\"}" >/dev/null
  echo "  supplier: $1"
}

prod() { # name kind shelf_life default_supplier
  curl -s -X POST "$BASE/api/products" $H_JSON $H_PIN \
    -d "{\"canonical_name\":\"$1\",\"kind\":\"$2\",\"shelf_life_days\":$3,\"default_supplier\":\"$4\"}" >/dev/null
  echo "  product: $1"
}

del_sup() { # id
  curl -s -X DELETE "$BASE/api/suppliers?id=$1" $H_PIN >/dev/null || true
}

del_prod() { # name
  curl -s -X DELETE "$BASE/api/products?canonical_name=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$1")" $H_PIN >/dev/null || true
}

echo "== Suppliers =="
sup "Hazeldenes" "HAZ"
sup "Inghams" "ING"
sup "Limnos Poultry" "LIM"
sup "Master Poultry" "MAST"
sup "Gourmet Poultry" "GOUR"
sup "Food Industry Products" "FIP"
sup "Goodman Fielder" "GF"
sup "SEDA" "SEDA"

echo "== Raw / bought-in =="
prod "RSPCA Medium Boning Bird WIP Bulk Bin" "raw" 7 "Hazeldenes"
prod "RSPCA Large Boning Bird WIP Bulk Bin"  "raw" 7 "Hazeldenes"
prod "Tenderloins (6kg)"                      "raw" 7 "Inghams"
prod "FS CKN WBIRD #17 RW PALLECON"           "raw" 7 "Inghams"
prod "FS CKN WBIRD #22 RW PALLECON"           "raw" 7 "Inghams"
prod "Chicken Breast Fillet Skin Off (20kg)"  "raw" 7 "Limnos Poultry"
prod "BREAST ON BONE (NO-WG) SIZE 16-17*"     "raw" 7 "Master Poultry"
prod "BREAST FILLET S/OFF S16-17 SPL CUT-UNI" "raw" 7 "Master Poultry"
prod "BREAST FILLET S/OFF S.22 SPL CUT-UNI (BAI)" "raw" 7 "Master Poultry"
prod "Frsh BR/FILLET (S/Off) P/C 17+"         "raw" 7 "Gourmet Poultry"

echo "== Ingredients (allergen-tracked) =="
prod "Battermix"            "ingredient" 90 "Food Industry Products"
prod "Breadcrumb (Fine White)" "ingredient" 90 "Goodman Fielder"
prod "Panko"                "ingredient" 90 "SEDA"

echo "== Processed: bone-out outputs =="
prod "Breast Fillet Skin Off"   "processed" 7 ""
prod "Breast Fillet Skin On"    "processed" 7 ""
prod "Maryland Fillet Skin Off" "processed" 7 ""
prod "Maryland Fillet Skin On"  "processed" 7 ""
prod "Wings"                    "processed" 7 ""
prod "Frame / Carcass"          "processed" 7 ""

echo "== Processed: further breakdown =="
prod "Thigh Fillet Skin On"      "processed" 7 ""
prod "Thigh Fillet Skin Off"     "processed" 7 ""
prod "Drumstick Fillet Skin On"  "processed" 7 ""
prod "Drumstick Fillet Skin Off" "processed" 7 ""
prod "Diced"                     "processed" 7 ""
prod "Wingettes"                 "processed" 7 ""
prod "Drummettes"                "processed" 7 ""

echo "== Sliced Breast Fillet Skin Off — by size (for schnitzels) =="
prod "Sliced Breast Fillet S/Off LARGE (160-180g)"   "processed" 7 ""
prod "Sliced Breast Fillet S/Off MEDIUM (120-140g)"  "processed" 7 ""
prod "Sliced Breast Fillet S/Off SPECIAL (130-150g)" "processed" 7 ""
prod "Sliced Breast Fillet S/Off DX250 (230-250g)"   "processed" 7 ""
prod "Sliced Breast Fillet S/Off PK16 (180-200g)"    "processed" 7 ""
prod "Sliced Breast Fillet S/Off BABY (80-100g)"     "processed" 7 ""
prod "Sliced Breast Fillet S/Off ZSP (160-180g)"     "processed" 7 ""

echo "== Crumbed schnitzels — FRESH (5 day shelf, capped at bird UBD) =="
for s in LARGE MEDIUM SPECIAL DX250 PK16 BABY ZSP; do
  prod "Crumbed Chicken Schnitzel $s Fresh" "processed" 5 ""
done

echo "== Crumbed schnitzels — FROZEN (365 day shelf, no source-UBD cap) =="
for s in LARGE MEDIUM SPECIAL DX250 PK16 BABY ZSP; do
  prod "Crumbed Chicken Schnitzel $s Frozen" "processed" 365 ""
done

echo "== Remove old test products =="
for p in "Chicken Schnitzel" "Chicken Breast Fillet" "Chicken Maryland" \
         "Chicken Thigh Fillet" "Chicken Wings" "Crumb Mix (gluten/egg)" \
         "Maryland Fillet Skin-Off" "Breast Fillet Skin-Off" \
         "Sliced Breast Fillet" "Whole Chicken Size 16" "Whole Chicken Size 17" \
         "RSPCA Medium Boning Bird WIP Bulk Bin"; do
  : # NOTE: keep RSPCA Medium — it's a real product. Listed-then-skipped guard below.
done
del_prod "Chicken Schnitzel"
del_prod "Chicken Breast Fillet"
del_prod "Chicken Maryland"
del_prod "Chicken Thigh Fillet"
del_prod "Chicken Wings"
del_prod "Crumb Mix (gluten/egg)"
del_prod "Maryland Fillet Skin-Off"
del_prod "Breast Fillet Skin-Off"
del_prod "Sliced Breast Fillet"
del_prod "Whole Chicken Size 16"
del_prod "Whole Chicken Size 17"
echo "  (old test products removed)"

echo "== Remove unused suppliers (La Ionica, Turi Foods) =="
# find their IDs then delete
IDS=$(curl -s "$BASE/api/suppliers")
python3 - "$BASE" "$ADMIN_PIN" <<'PY'
import json,sys,urllib.request
base,pin=sys.argv[1],sys.argv[2]
data=json.load(urllib.request.urlopen(base+"/api/suppliers"))
for s in data.get("suppliers",[]):
    if s["name"] in ("La Ionica","Turi Foods"):
        req=urllib.request.Request(f"{base}/api/suppliers?id={s['id']}",method="DELETE",headers={"X-Admin-PIN":pin})
        try: urllib.request.urlopen(req); print("  removed supplier:",s["name"])
        except Exception as e: print("  (could not remove",s["name"],e,")")
PY

echo
echo "Done. Verify:  curl -s $BASE/api/products | python3 -m json.tool | grep canonical_name"

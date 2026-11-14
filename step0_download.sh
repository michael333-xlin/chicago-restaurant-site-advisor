#!/usr/bin/env bash
# Step 0: download every public input into data/raw/ (no credentials needed).
# Run from the repo root:  bash advantage/step0_download.sh
set -euo pipefail
RAW="data/raw"
mkdir -p "$RAW/licenses" "$RAW/pop" "$RAW/ses" "$RAW/lodes" "$RAW/zips"

# Business Licenses (r5kz-chrr), Retail Food Establishment only, paged by :id
for off in 0 50000 100000 150000 200000; do
  curl -s -G "https://data.cityofchicago.org/resource/r5kz-chrr.csv" \
    --data-urlencode "\$select=license_number,account_number,site_number,application_type,date_issued,license_start_date,expiration_date,license_status,doing_business_as_name,legal_name,address,zip_code,latitude,longitude,business_activity,community_area" \
    --data-urlencode "\$where=license_description='Retail Food Establishment'" \
    --data-urlencode "\$order=:id" --data-urlencode "\$limit=50000" --data-urlencode "\$offset=$off" \
    -o "$RAW/licenses/p_$off.csv"
done

# Chicago Population Counts by ZIP (85cm-7uqa), 2018-2021
curl -s "https://data.cityofchicago.org/resource/85cm-7uqa.csv?\$limit=5000" -o "$RAW/pop/pop.csv"
# Census socioeconomic indicators by community area 2008-2012 (kn9c-c2s2)
curl -s "https://data.cityofchicago.org/resource/kn9c-c2s2.csv" -o "$RAW/ses/ses.csv"

# Boundaries - ZIP Codes (unjd-c2ca), used for the citywide map layer
curl -s "https://data.cityofchicago.org/resource/unjd-c2ca.geojson?\$limit=200" -o "$RAW/zips/zips.geojson"

# LODES8 Illinois crosswalk + WAC 2011-2024
curl -sfL -o "$RAW/lodes/il_xwalk.csv.gz" "https://lehd.ces.census.gov/data/lodes/LODES8/il/il_xwalk.csv.gz"
for y in $(seq 2011 2024); do
  curl -sfL -o "$RAW/lodes/il_wac_$y.csv.gz" \
    "https://lehd.ces.census.gov/data/lodes/LODES8/il/wac/il_wac_S000_JT00_$y.csv.gz"
done
echo "done: $(ls "$RAW"/*/ | wc -l) files"

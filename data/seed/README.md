# data/seed

`chicago_restaurant_categories.csv`: 11,875 restaurant places in and around Chicago from Overture Maps
(places theme; name, address, ZIP, primary category, category hierarchy, coordinates).

The server needs this file on first start (it is the restaurant supply snapshot). License: Overture Maps
places data is released under CDLA-Permissive-2.0 — keep this attribution: "© Overture Maps Foundation".

To use a newer snapshot, replace this file (same columns) and run `POST /api/admin/retrain`.
